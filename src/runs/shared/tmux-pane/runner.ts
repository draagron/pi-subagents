/**
 * Runs one child subagent as an interactive Claude Code session in a tmux pane.
 *
 * This is the in-process peer of `runExternalCli`. Because it runs inside the
 * async runner rather than behind an intermediate client process, there is no
 * SIGTERM/SIGKILL escalation and therefore no orphaned-pane failure mode: stop
 * and timeout act on the pane directly.
 */

import * as path from "node:path";
import {
	consumeSteerRequestsFromDir,
	stepSteerInboxDir,
	writeSteerAck,
	writeSteerCapability,
} from "../../background/control-channel.ts";
import type { TmuxPanePermissionMode, TmuxPaneRunnerStatus } from "../../../shared/types.ts";
import type { ChildIdentity } from "./pane-identity.ts";
import type { ClaudePane, TurnRecord, TurnStatus } from "./pane.ts";
import { spawnClaudePane } from "./spawn.ts";
import { Tmux } from "./tmux.ts";

export const DEFAULT_TURN_TIMEOUT_MS = 900_000;
export const DEFAULT_SUBMIT_TIMEOUT_MS = 25_000;
const STEER_POLL_MS = 250;

export interface TmuxPaneRunResult {
	output: string;
	exitCode: number | null;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	/** Interrupted with context intact, so the run can be resumed. */
	paused?: boolean;
	turnStatus: TurnStatus;
	runner: TmuxPaneRunnerStatus;
}

export interface TmuxPaneRunInput {
	identity: ChildIdentity;
	cwd: string;
	/** Run's async dir: holds status.json, events, and now pane state. */
	asyncDir: string;
	/** Flat child index, used for this child's steer inbox and ack dir. */
	stepIndex: number;
	prompt: string;
	claudeBin: string;
	nodeBin: string;
	model?: string;
	permissionMode?: TmuxPanePermissionMode;
	allowedTools?: string[];
	disallowedTools?: string[];
	addDirs?: string[];
	layout?: "split" | "window";
	size?: string;
	reuse?: boolean;
	extraArgs?: string[];
	appendSystemPrompt?: string;
	timeoutMs?: number;
	submitTimeoutMs?: number;
	maxSubagentDepth?: number;
	/** Keep the pane after the turn so an operator can inspect it. */
	preservePane?: boolean;
	registerTimeout?: (stop: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	timeoutMessage?: string;
	stopMessage?: string;
	/** Called once the pane exists, so status can carry real pane identity. */
	onRunnerStatus?: (runner: TmuxPaneRunnerStatus) => void;
	onToolEvent?: (toolName: string) => void;
	onNeedsAttention?: (message: string) => void;
	onProgress?: (turn: TurnRecord) => void;
	tmux?: Tmux;
}

function statusToResult(
	turn: TurnRecord,
	runner: TmuxPaneRunnerStatus,
	input: TmuxPaneRunInput,
): TmuxPaneRunResult {
	const output = turn.text ?? "";
	switch (turn.status) {
		case "completed":
			return { output, exitCode: 0, turnStatus: turn.status, runner };
		case "timeout":
			return {
				output,
				exitCode: 1,
					error: input.timeoutMessage ?? `Subagent timed out. Pane ${runner.paneId} was left running for inspection${runner.transcriptPath ? `; partial work is in ${runner.transcriptPath}` : ""}.`,
				timedOut: true,
				turnStatus: turn.status,
				runner,
			};
		case "interrupted":
			return {
				output,
				exitCode: 1,
				error: input.stopMessage ?? `Subagent interrupted. Pane ${runner.paneId} is paused with its context intact${runner.transcriptPath ? `; partial work is in ${runner.transcriptPath}` : ""}.`,
				paused: true,
				turnStatus: turn.status,
				runner,
			};
		case "session_ended":
			return {
				output,
				exitCode: 1,
				// No Stop hook fired, so there is no deliverable. Claude exiting is
				// never success, even though the turn ended.
				// Claude reports reason "other" for an externally killed pane, which
				// tells an operator nothing; only append a note that adds meaning.
				error:
					`Claude exited in pane ${runner.paneId} before completing the task, so no result was produced` +
					`${turn.note && turn.note !== "other" ? `: ${turn.note}.` : ". The pane was closed or Claude was quit."}`,
				turnStatus: turn.status,
				runner,
			};
		case "submit_failed":
			return {
				output,
				exitCode: 1,
				error:
					`The task was pasted into pane ${runner.paneId} but never submitted, so Claude never started. ` +
					`A dialog was probably open in the pane. Inspect it with: tmux attach -t ${runner.paneId}`,
				turnStatus: turn.status,
				runner,
			};
		case "superseded":
			return {
				output,
				exitCode: 1,
				error:
					`Another prompt was submitted in pane ${runner.paneId} while this task was running, ` +
					`so its result can never be attributed. Avoid typing into panes owned by a run.`,
				turnStatus: turn.status,
				runner,
			};
		default:
			return { output, exitCode: 1, error: `Turn ended in unexpected state '${turn.status}'.`, turnStatus: turn.status, runner };
	}
}

function ackSteer(
	input: TmuxPaneRunInput,
	requestId: string,
	state: "queued" | "delivered" | "failed",
	message: string,
): void {
	try {
		writeSteerAck(input.asyncDir, {
			requestId,
			index: input.stepIndex,
			ts: Date.now(),
			state,
			...(state === "failed" ? {} : { deliveryStatus: state }),
			message: message.slice(0, 990),
		});
	} catch {
		// Acknowledgment is reporting, not control: never disturb a running turn.
	}
}

/**
 * Consume this child's steer inbox on the pane's behalf.
 *
 * Native Pi children read the inbox themselves through env vars. A Claude pane
 * has no such channel, so the runner relays the message in by bracketed paste.
 *
 * Acknowledgment is deliberately two-stage, because Claude Code QUEUES input
 * pasted while it is mid-turn: measured against Claude Code 2.1.233, the
 * steer's UserPromptSubmit fires roughly 80ms AFTER the steered turn's Stop,
 * not during it. So a mid-turn steer influences the child's NEXT turn, not the
 * one in flight, and a "delivered" receipt cannot arrive inside the turn it was
 * aimed at.
 *
 * Reporting "delivered" on paste alone would therefore assert something untrue.
 * Instead the paste acks `queued` - the protocol's own word for exactly this -
 * and it is upgraded to `delivered` only if Claude's UserPromptSubmit is
 * actually observed while the relay is still running.
 */
function startSteerRelay(pane: ClaudePane, input: TmuxPaneRunInput): () => void {
	const inbox = stepSteerInboxDir(input.asyncDir, input.stepIndex);

	const unsubscribe = pane.onSteerDelivered((requestId) => {
		ackSteer(input, requestId, "delivered", "Accepted by the Claude pane; confirmed by UserPromptSubmit.");
	});

	const timer = setInterval(() => {
		let requests: ReturnType<typeof consumeSteerRequestsFromDir>;
		try {
			requests = consumeSteerRequestsFromDir(inbox);
		} catch {
			return;
		}
		for (const request of requests) {
			void pane
				.steer(request.id, request.message)
				.then(() => {
					ackSteer(
						input,
						request.id,
						"queued",
						"Pasted into the Claude pane. Claude queues input received mid-turn, so it is picked up at the next turn boundary.",
					);
				})
				.catch((error: unknown) => {
					ackSteer(input, request.id, "failed", `Could not paste into the pane: ${error instanceof Error ? error.message : String(error)}`);
				});
		}
	}, STEER_POLL_MS);
	timer.unref?.();

	return () => {
		clearInterval(timer);
		unsubscribe();
	};
}

export async function runTmuxPane(input: TmuxPaneRunInput): Promise<TmuxPaneRunResult> {
	const tmux = input.tmux ?? new Tmux();
	const { pane, release } = await spawnClaudePane(tmux, {
		identity: input.identity,
		cwd: input.cwd,
		stateRoot: input.asyncDir,
		claudeBin: input.claudeBin,
		nodeBin: input.nodeBin,
		...(input.model ? { model: input.model } : {}),
		...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
		...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
		...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
		...(input.addDirs ? { addDirs: input.addDirs } : {}),
		...(input.layout ? { layout: input.layout } : {}),
		...(input.size ? { size: input.size } : {}),
		...(input.reuse ? { reuse: input.reuse } : {}),
		...(input.extraArgs ? { extraArgs: input.extraArgs } : {}),
		...(input.appendSystemPrompt ? { appendSystemPrompt: input.appendSystemPrompt } : {}),
		...(input.maxSubagentDepth !== undefined ? { maxSubagentDepth: input.maxSubagentDepth } : {}),
	});

	const runner: TmuxPaneRunnerStatus = {
		type: "tmux-pane",
		program: "claude",
		paneId: pane.paneId,
		paneName: pane.meta.paneName,
		claudeSessionId: pane.meta.claudeSessionId,
		stateDir: pane.meta.stateDir,
		cwd: pane.meta.cwd,
		capabilities: {
			stop: true,
			steer: true,
			resume: true,
			structuredOutput: false,
			toolEvents: true,
			usage: "unavailable",
			turnBudget: false,
			toolBudget: false,
		},
	};

	input.onRunnerStatus?.(runner);

	const controller = new AbortController();
	let stopRequested = false;
	let timeoutRequested = false;
	let stopSteerRelay: (() => void) | undefined;
	const unsubscribeEvents = pane.tail.subscribe((event) => {
		if (event.hook_event_name === "PreToolUse" && event.tool_name) input.onToolEvent?.(event.tool_name);
		if (event.hook_event_name === "Notification") input.onNeedsAttention?.(event.message ?? "waiting for input");
	});

	try {
		// Advertise steer support before the first paste, so a steer arriving
		// immediately is relayed rather than rejected.
		try {
			writeSteerCapability(input.asyncDir, {
				index: input.stepIndex,
				pid: process.pid,
				readyAt: Date.now(),
				supported: true,
			});
		} catch {
			// Steering is an enhancement; failing to advertise it must not fail the run.
		}
		stopSteerRelay = startSteerRelay(pane, input);

		const turn = await pane.send(input.prompt);

		// Same control seam the external-CLI runner uses. Aborting sends Escape
		// rather than kill-pane: it ends the turn while leaving the conversation
		// resumable. The flags survive the abort so the outcome can be reported
		// as a timeout or a stop rather than as a bare interrupt.
		input.registerTimeout?.(() => {
			timeoutRequested = true;
			controller.abort();
		});
		input.registerStop?.(() => {
			stopRequested = true;
			controller.abort();
		});

		const finished = await pane.awaitTurn(turn, {
			timeoutMs: input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
			submitTimeoutMs: input.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS,
			signal: controller.signal,
			...(input.onProgress ? { onProgress: input.onProgress } : {}),
		});

		// Claude reports its transcript path through the hook stream, so it is only
		// known once events have flowed. It matters most on the paths that produce
		// no deliverable - stop, timeout, session_ended - where it is the operator's
		// only route back to the child's partial work.
		if (pane.transcriptPath) {
			runner.transcriptPath = pane.transcriptPath;
			input.onRunnerStatus?.(runner);
		}

		const result = statusToResult(finished, runner, input);
		if (stopRequested) {
			return {
				...result,
				stopped: true,
				paused: false,
				exitCode: 1,
				error: input.stopMessage ?? `Subagent stopped by user.${runner.transcriptPath ? ` Partial work is in ${runner.transcriptPath}.` : ""}`,
			};
		}
		if (timeoutRequested) {
			return {
				...result,
				timedOut: true,
				paused: false,
				exitCode: 1,
				error: input.timeoutMessage ?? `Subagent timed out. Pane ${runner.paneId} was left running for inspection${runner.transcriptPath ? `; partial work is in ${runner.transcriptPath}` : ""}.`,
			};
		}
		return result;
	} finally {
		input.registerTimeout?.(undefined);
		input.registerStop?.(undefined);
		stopSteerRelay?.();
		unsubscribeEvents();
		// An explicit stop tears the pane down; everything else leaves it alive.
		// The pane's context is the only thing that makes resume possible, and a
		// timed-out or failed child is worth inspecting.
		if (stopRequested && !input.preservePane) {
			await pane.kill().catch(() => {});
		} else {
			pane.detach();
		}
		release();
	}
}
