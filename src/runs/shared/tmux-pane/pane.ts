/**
 * A Claude Code child living in a tmux pane, and its turn state machine.
 *
 * The turn lifecycle is driven entirely by Claude Code hook events, never by
 * scraping the pane:
 *
 *   paste + Enter -> UserPromptSubmit (carries the turn's prompt_id)
 *                 -> PreToolUse*      (progress / tool events)
 *                 -> Notification?    (blocked on a permission prompt)
 *                 -> Stop             (carries last_assistant_message)
 *
 * An interrupted turn emits no Stop, so the wait also resolves on abort, on a
 * superseding prompt, on SessionEnd, and on timeout.
 *
 * A prompt the runner did not send is a human sharing the pane. By default that
 * ends the turn as `superseded`, because the answer to someone else's question
 * cannot be attributed to the delegated task. `interactive: true` trades that
 * guarantee for collaboration: the human's prompt is adopted as the turn's
 * prompt, the deliverable becomes the answer to the newest instruction, and the
 * count of human prompts is reported so the result is never read as unattended.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendLocalEvent, EventTail, type HookEvent } from "./events.ts";
import type { ChildIdentity } from "./pane-identity.ts";
import type { Tmux } from "./tmux.ts";

export type TurnStatus =
	| "running"
	| "completed"
	| "interrupted"
	| "superseded"
	| "session_ended"
	| "timeout"
	| "submit_failed";

const TERMINAL: readonly TurnStatus[] = [
	"completed",
	"interrupted",
	"superseded",
	"session_ended",
	"timeout",
	"submit_failed",
];

export function isTerminalTurnStatus(status: TurnStatus): boolean {
	return TERMINAL.includes(status);
}

export interface TurnRecord {
	id: string;
	promptId?: string;
	status: TurnStatus;
	prompt: string;
	sentAt: number;
	finishedAt?: number;
	/** Final assistant message, from the Stop payload. The deliverable. */
	text?: string;
	/** Tool names used during the turn, in order. */
	tools: string[];
	/** Most recent Notification message, while blocked on a permission prompt. */
	blocked?: string;
	note?: string;
	/**
	 * Time this turn spent blocked on a human. Excluded from the deadline: a
	 * permission prompt must not consume the run's timeout budget.
	 */
	blockedDurationMs: number;
	/**
	 * Prompts a human submitted into the pane and this turn adopted, under
	 * `interactive: true`. Absent means the turn is the runner's alone.
	 */
	humanTurns?: number;
}

export interface PaneMeta extends ChildIdentity {
	paneName: string;
	paneId: string;
	claudeSessionId: string;
	cwd: string;
	stateDir: string;
	transcriptPath?: string;
	createdAt: number;
}

/**
 * Claude's workspace trust dialog. Probed against Claude Code 2.1.233: trust is
 * keyed to the git repository, so managed worktrees of an already-trusted repo
 * do not prompt. It can still appear on the first-ever use of an untrusted
 * repo, where a bracketed paste would land in the dialog instead of the editor.
 * Detect it and say so, rather than reporting an opaque submit failure.
 */
const TRUST_DIALOG_PATTERN = /Quick safety check|trust this folder/i;

/** Markers that Claude's input box has been drawn and will accept a paste. */
const PROMPT_READY_PATTERN = /│ >|❯|Claude Code v/;

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TrustDialogError extends Error {
	constructor(paneId: string, cwd: string) {
		super(
			`Claude is showing its workspace trust dialog in pane ${paneId} for ${cwd}, so the task could not be submitted. ` +
				`Trust the repository once (open Claude there interactively and accept), then re-run; all worktrees of that repository inherit the trust.`,
		);
		this.name = "TrustDialogError";
	}
}

export class ClaudePane {
	readonly tail: EventTail;
	current: TurnRecord | undefined;
	readonly history: TurnRecord[] = [];
	transcriptPath: string | undefined;
	ended = false;
	/**
	 * Set while Claude waits on a human. Outlives the turn, because a turn that
	 * times out while blocked leaves the pane itself blocked.
	 */
	blocked: string | undefined;

	private unsubscribe: (() => void) | undefined;
	private readonly turnWaiters = new Set<(turn: TurnRecord) => void>();
	private turnCounter = 0;
	/** Start of the current blocked span, if any. */
	private blockedSince: number | undefined;
	/**
	 * Steer request ids pasted into the pane but not yet confirmed by a
	 * UserPromptSubmit. Distinguishes a runner-delivered steer from a human
	 * typing into the pane, which must supersede the turn instead.
	 */
	private readonly pendingSteerIds: string[] = [];
	private readonly steerListeners = new Set<(requestId: string, promptId?: string) => void>();
	private readonly humanTurnListeners = new Set<(turn: TurnRecord) => void>();

	readonly meta: PaneMeta;
	private readonly tmux: Tmux;
	/** Pause between the bracketed paste and Enter, so the editor absorbs it. */
	private readonly pasteSettleMs: number;
	/** Adopt a human's prompt into the running turn instead of superseding it. */
	private readonly interactive: boolean;

	constructor(meta: PaneMeta, tmux: Tmux, options?: { pasteSettleMs?: number; interactive?: boolean }) {
		this.meta = meta;
		this.tmux = tmux;
		this.pasteSettleMs = options?.pasteSettleMs ?? 250;
		this.interactive = options?.interactive ?? false;
		this.transcriptPath = meta.transcriptPath;
		this.tail = new EventTail(meta.stateDir);
	}

	get agent(): string {
		return this.meta.agent;
	}

	get paneId(): string {
		return this.meta.paneId;
	}

	get busy(): boolean {
		return this.current?.status === "running";
	}

	attach(options?: { fromEnd?: boolean }): void {
		if (this.unsubscribe) return;
		if (options?.fromEnd) this.tail.seekToEnd();
		this.unsubscribe = this.tail.subscribe((event) => this.onEvent(event));
		this.tail.start();
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.tail.stop();
	}

	/** Wall-clock elapsed minus time spent blocked on a human. */
	effectiveElapsedMs(turn: TurnRecord, now = Date.now()): number {
		const openSpan = this.blockedSince === undefined ? 0 : now - this.blockedSince;
		return Math.max(0, now - turn.sentAt - turn.blockedDurationMs - openSpan);
	}

	private closeBlockedSpan(turn: TurnRecord | undefined, now = Date.now()): void {
		if (this.blockedSince === undefined) return;
		if (turn) turn.blockedDurationMs += Math.max(0, now - this.blockedSince);
		this.blockedSince = undefined;
	}

	private onEvent(event: HookEvent): void {
		if (event.transcript_path && event.transcript_path !== this.transcriptPath) {
			this.transcriptPath = event.transcript_path;
			this.persist();
		}

		const turn = this.current;

		switch (event.hook_event_name) {
			case "UserPromptSubmit": {
				this.blocked = undefined;
				this.closeBlockedSpan(turn);
				if (!turn || turn.status !== "running") return;
				if (!turn.promptId) {
					turn.promptId = event.prompt_id;
				} else if (event.prompt_id && event.prompt_id !== turn.promptId) {
					// A second prompt landed before our turn produced a Stop. If the
					// runner pasted it as a steer, this event IS the delivery receipt
					// and the turn continues. Otherwise a human typed into the pane
					// and our turn will never complete.
					const steerRequestId = this.pendingSteerIds.shift();
					if (steerRequestId !== undefined) {
						for (const listener of [...this.steerListeners]) {
							try {
								listener(steerRequestId, event.prompt_id);
							} catch {
								// A failing ack listener must not supersede a live turn.
							}
						}
						return;
					}
					if (this.interactive) {
						this.adoptHumanPrompt(turn, event.prompt_id);
						return;
					}
					this.finish(turn, "superseded", { note: "another prompt was submitted in the pane" });
				}
				return;
			}

			case "PreToolUse": {
				this.blocked = undefined;
				this.closeBlockedSpan(turn);
				if (!turn || turn.status !== "running") return;
				if (event.tool_name) turn.tools.push(event.tool_name);
				turn.blocked = undefined;
				return;
			}

			case "Notification": {
				this.blocked = event.message ?? "waiting for input";
				if (this.blockedSince === undefined) this.blockedSince = Date.now();
				if (!turn || turn.status !== "running") return;
				turn.blocked = this.blocked;
				return;
			}

			case "Stop": {
				this.blocked = undefined;
				this.closeBlockedSpan(turn);
				if (!turn || turn.status !== "running") return;
				// Match on prompt_id when known; a Stop for another prompt belongs
				// to a different turn in the same pane.
				if (turn.promptId && event.prompt_id && event.prompt_id !== turn.promptId) return;
				turn.text = event.last_assistant_message ?? "";
				turn.blocked = undefined;
				this.finish(turn, "completed");
				return;
			}

			case "SessionEnd": {
				this.ended = true;
				this.closeBlockedSpan(turn);
				if (turn && turn.status === "running") {
					this.finish(turn, "session_ended", { note: event.reason ?? "claude exited" });
				}
				return;
			}

			default:
				return;
		}
	}

	/**
	 * Interactive mode: make a human's prompt this turn's prompt.
	 *
	 * Re-keying to the new prompt id is what keeps the turn alive - the Stop that
	 * completes it is now the one answering the human, and a Stop for the prompt
	 * the runner sent is no longer expected, because Claude abandoned it the
	 * moment the human interrupted.
	 *
	 * The deadline is re-based rather than merely paused. A human conversing in
	 * the pane produces no event between their keystrokes, so there is no span to
	 * pause over; without a re-base a ten-minute conversation would time out a
	 * turn that is progressing perfectly well. Banked blocked time resets with it,
	 * because it was measured against the old start and would otherwise be
	 * subtracted twice.
	 */
	private adoptHumanPrompt(turn: TurnRecord, promptId?: string): void {
		if (promptId) turn.promptId = promptId;
		turn.humanTurns = (turn.humanTurns ?? 0) + 1;
		turn.note =
			`a human submitted ${turn.humanTurns === 1 ? "a prompt" : `${turn.humanTurns} prompts`} in the pane; ` +
			`the result answers the newest one`;
		turn.sentAt = Date.now();
		turn.blockedDurationMs = 0;
		this.blockedSince = undefined;
		appendLocalEvent(this.meta.stateDir, {
			hook_event_name: "PiHumanTurn",
			...(promptId ? { prompt_id: promptId } : {}),
		});
		for (const listener of [...this.humanTurnListeners]) {
			try {
				listener(turn);
			} catch {
				// Reporting a shared turn must not end the turn being shared.
			}
		}
	}

	/** Notified when a human's prompt is adopted into the running turn. */
	onHumanTurn(listener: (turn: TurnRecord) => void): () => void {
		this.humanTurnListeners.add(listener);
		return () => this.humanTurnListeners.delete(listener);
	}

	private finish(turn: TurnRecord, status: TurnStatus, extra?: { note?: string }): void {
		if (isTerminalTurnStatus(turn.status)) return;
		this.closeBlockedSpan(turn);
		turn.status = status;
		turn.finishedAt = Date.now();
		if (extra?.note) turn.note = extra.note;
		this.history.push(turn);
		if (this.history.length > 50) this.history.shift();
		this.current = undefined;
		for (const waiter of [...this.turnWaiters]) {
			try {
				waiter(turn);
			} catch {
				// A misbehaving waiter must not prevent the others from resolving.
			}
		}
	}

	persist(): void {
		try {
			fs.writeFileSync(
				path.join(this.meta.stateDir, "meta.json"),
				JSON.stringify({ ...this.meta, transcriptPath: this.transcriptPath }, null, 2),
			);
		} catch {
			// meta.json is a recovery aid; failing to refresh it must not fail a turn.
		}
	}

	/** Type a prompt into the pane and press Enter. Does not wait for the answer. */
	async send(prompt: string): Promise<TurnRecord> {
		if (this.busy) {
			throw new Error(`Pane ${this.paneId} for agent "${this.agent}" is still working on a turn.`);
		}

		// Claim the turn before awaiting anything, so a concurrent observer sees
		// "working" rather than a momentary "idle".
		const turn: TurnRecord = {
			id: `${++this.turnCounter}-${randomUUID().slice(0, 8)}`,
			status: "running",
			prompt,
			sentAt: Date.now(),
			tools: [],
			blockedDurationMs: 0,
		};
		this.current = turn;

		try {
			await this.deliver(turn.id, prompt);
			// The deadline starts when the task is actually submitted, not when the
			// paste began: the settle delay is the runner's cost, not the child's.
			turn.sentAt = Date.now();
		} catch (error) {
			if (this.current === turn) this.current = undefined;
			throw error;
		}
		return turn;
	}

	/**
	 * Write text to a file and deliver it by bracketed paste, then Enter.
	 *
	 * The text never reaches a shell or a tmux argument, so no quoting or
	 * escaping path exists for it.
	 */
	private async deliver(id: string, text: string): Promise<void> {
		if (!(await this.tmux.paneExists(this.paneId))) {
			throw new Error(`Pane ${this.paneId} for agent "${this.agent}" is gone.`);
		}

		const tasksDir = path.join(this.meta.stateDir, "tasks");
		fs.mkdirSync(tasksDir, { recursive: true });
		const file = path.join(tasksDir, `${id}.md`);
		fs.writeFileSync(file, text);

		await this.tmux.pasteFile(this.paneId, `pi-${this.meta.paneName}`, file);
		// Give the editor a beat to absorb the bracketed paste before submitting.
		if (this.pasteSettleMs > 0) await delay(this.pasteSettleMs);
		await this.tmux.sendKey(this.paneId, "Enter");
	}

	/** Notified when a pasted steer is confirmed by a real UserPromptSubmit. */
	onSteerDelivered(listener: (requestId: string, promptId?: string) => void): () => void {
		this.steerListeners.add(listener);
		return () => this.steerListeners.delete(listener);
	}

	/**
	 * Paste a steer message into a pane that is mid-turn.
	 *
	 * Registered as pending first, so the UserPromptSubmit it produces is read
	 * as a delivery receipt rather than as a human superseding the turn.
	 *
	 * Note that Claude queues input pasted mid-turn: its UserPromptSubmit
	 * normally lands just after the current turn's Stop, so the receipt usually
	 * arrives for the NEXT turn. The pending registration still matters, because
	 * a steer submitted while Claude is between turns would otherwise be
	 * mistaken for a human typing and would supersede the turn.
	 */
	async steer(requestId: string, message: string): Promise<void> {
		this.pendingSteerIds.push(requestId);
		try {
			await this.deliver(`steer-${requestId}`, message);
		} catch (error) {
			const index = this.pendingSteerIds.indexOf(requestId);
			if (index >= 0) this.pendingSteerIds.splice(index, 1);
			throw error;
		}
	}

	/**
	 * Wait for a turn to reach a terminal state.
	 *
	 * The deadline runs on the blocked-adjusted clock: time spent waiting on a
	 * permission prompt does not count against `timeoutMs`. The submit window is
	 * deliberately wall-clock, because a turn that never submitted has not
	 * started and cannot be legitimately blocked.
	 */
	async awaitTurn(
		turn: TurnRecord,
		options: {
			timeoutMs: number;
			submitTimeoutMs: number;
			signal?: AbortSignal;
			onProgress?: (turn: TurnRecord) => void;
			tickMs?: number;
		},
	): Promise<TurnRecord> {
		if (isTerminalTurnStatus(turn.status)) return turn;

		return await new Promise<TurnRecord>((resolve) => {
			let settled = false;
			const tickMs = options.tickMs ?? 250;
			let lastProgressAt = 0;

			const done = (result: TurnRecord) => {
				if (settled) return;
				settled = true;
				clearInterval(ticker);
				this.turnWaiters.delete(onTurnEnd);
				options.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};

			const onTurnEnd = (finished: TurnRecord) => {
				if (finished.id === turn.id) done(finished);
			};
			this.turnWaiters.add(onTurnEnd);

			const onAbort = () => {
				void this.interrupt().catch(() => {});
				this.finish(turn, "interrupted", { note: "aborted by pi" });
			};

			const ticker = setInterval(() => {
				if (settled || turn.status !== "running") return;
				const now = Date.now();

				// The prompt must actually reach Claude's editor and submit. If no
				// UserPromptSubmit lands, the paste went somewhere unexpected (a
				// dialog was open, the pane was not a Claude prompt).
				if (!turn.promptId && now - turn.sentAt >= options.submitTimeoutMs) {
					this.finish(turn, "submit_failed", {
						note: "no UserPromptSubmit hook fired; the prompt may not have been submitted",
					});
					return;
				}

				if (this.effectiveElapsedMs(turn, now) >= options.timeoutMs) {
					this.finish(turn, "timeout", {
						note: `no Stop hook within ${Math.round(options.timeoutMs / 1000)}s of unblocked run time`,
					});
					return;
				}

				if (options.onProgress && now - lastProgressAt >= 1000) {
					lastProgressAt = now;
					options.onProgress(turn);
				}
			}, tickMs);
			// Deliberately NOT unref'd. This timer is the only thing awaiting the
			// turn, so unref'ing it lets the process exit mid-turn whenever the
			// pane is the sole work in flight. Every other timer here is unref'd
			// precisely because this one holds the loop open.

			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) onAbort();
		});
	}

	/** Escape: stops the current turn but leaves the pane and its context alive. */
	async interrupt(): Promise<void> {
		this.blocked = undefined;
		await this.tmux.sendKey(this.paneId, "Escape");
		appendLocalEvent(this.meta.stateDir, { hook_event_name: "PiInterrupt" });
	}

	async capture(lines: number): Promise<string> {
		return await this.tmux.capture(this.paneId, lines);
	}

	async kill(): Promise<void> {
		this.detach();
		await this.tmux.killPane(this.paneId);
	}

	/**
	 * Poll until Claude's input box is drawn.
	 *
	 * Throws `TrustDialogError` when the workspace trust dialog is up: pasting
	 * into it would silently answer a security prompt, so refuse instead.
	 */
	async waitForPrompt(options?: { timeoutMs?: number }): Promise<void> {
		const deadline = Date.now() + (options?.timeoutMs ?? 20_000);
		while (Date.now() < deadline) {
			const text = await this.capture(40);
			if (TRUST_DIALOG_PATTERN.test(text)) throw new TrustDialogError(this.paneId, this.meta.cwd);
			if (PROMPT_READY_PATTERN.test(text)) {
				await delay(600);
				return;
			}
			await delay(300);
		}
		// Fall through: the turn's submit window is the real backstop, and it
		// reports a pane id the operator can inspect.
	}
}
