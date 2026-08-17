/**
 * Thin wrapper over the tmux CLI.
 *
 * Every invocation passes an argv array to `execFile`, so no shell is involved
 * and no quoting or escaping path exists. Task text never travels through here:
 * it is written to a file and delivered by bracketed paste (see `pasteFile`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 10_000;
const SPAWN_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** tmux user options used as a cross-process registry of pane ownership. */
export const PANE_OPTION_AGENT = "@pi_claude_agent";
export const PANE_OPTION_SESSION = "@pi_claude_session";
export const PANE_OPTION_STATE = "@pi_claude_state";
export const PANE_OPTION_RUN = "@pi_subagent_run";
export const PANE_OPTION_CHILD = "@pi_subagent_child";
/**
 * The pane's logical name, which is the only run-independent handle on it.
 *
 * `reuse: true` has to find a pane created by an earlier run, and every other
 * tag is per-run: the run id and child key change, and the state dir lives under
 * the old run's async dir. The pane name does not.
 */
export const PANE_OPTION_NAME = "@pi_claude_pane_name";

/** A pane tagged by this runner, as reported by `tmux list-panes`. */
export interface TaggedPane {
	paneId: string;
	agent: string;
	/** Logical pane name, from `@pi_claude_pane_name`. Empty on panes tagged before it existed. */
	paneName: string;
	/**
	 * State dir this pane's own Claude writes hook events to, from
	 * `@pi_claude_state`. Authoritative: the path was baked into the child's
	 * `--settings` at launch and cannot be moved while it runs.
	 */
	stateDir: string;
	/** Run this pane belongs to, from `@pi_subagent_run`. */
	runId: string;
	/** Logical child key within the run, from `@pi_subagent_child`. */
	childKey: string;
	dead: boolean;
	session: string;
	windowId: string;
}

const PANE_FIELDS = [
	"#{pane_id}",
	`#{${PANE_OPTION_AGENT}}`,
	`#{${PANE_OPTION_STATE}}`,
	`#{${PANE_OPTION_RUN}}`,
	`#{${PANE_OPTION_CHILD}}`,
	"#{pane_dead}",
	"#{session_name}",
	"#{window_id}",
	`#{${PANE_OPTION_NAME}}`,
].join("\t");

interface ExecFailure {
	code?: number | string;
	stdout?: string;
	stderr?: string;
	killed?: boolean;
}

function readExecFailure(error: unknown): ExecFailure {
	if (typeof error !== "object" || error === null) return {};
	const candidate = error as ExecFailure;
	return {
		...(candidate.code !== undefined ? { code: candidate.code } : {}),
		...(typeof candidate.stdout === "string" ? { stdout: candidate.stdout } : {}),
		...(typeof candidate.stderr === "string" ? { stderr: candidate.stderr } : {}),
		...(typeof candidate.killed === "boolean" ? { killed: candidate.killed } : {}),
	};
}

export interface TmuxRunOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export class Tmux {
	private readonly binary: string;

	constructor(binary = "tmux") {
		this.binary = binary;
	}

	/** True when the current process is itself running inside tmux. */
	get inside(): boolean {
		return Boolean(process.env.TMUX);
	}

	/** The pane the current process runs in, if any. */
	get selfPane(): string | undefined {
		return process.env.TMUX_PANE;
	}

	async run(args: string[], options?: TmuxRunOptions): Promise<string> {
		try {
			const { stdout } = await execFileAsync(this.binary, args, {
				timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
				windowsHide: true,
				encoding: "utf-8",
				...(options?.signal ? { signal: options.signal } : {}),
			});
			return stdout;
		} catch (error) {
			const failure = readExecFailure(error);
			const detail = (failure.stderr || failure.stdout || "").trim();
			const code = failure.code ?? "unknown";
			throw new Error(`tmux ${args.join(" ")} failed (exit ${code})${detail ? `: ${detail}` : ""}`);
		}
	}

	/** Like `run`, but returns null instead of throwing. For probes only. */
	async tryRun(args: string[], options?: TmuxRunOptions): Promise<string | null> {
		try {
			return await this.run(args, options);
		} catch {
			return null;
		}
	}

	/** tmux version string, or null when tmux is unavailable. Side-effect free. */
	async version(): Promise<string | null> {
		const out = await this.tryRun(["-V"]);
		return out ? out.trim() : null;
	}

	/**
	 * Whether a tmux server is reachable. Side-effect free: `list-sessions`
	 * never starts a server, unlike `new-session`.
	 */
	async serverReachable(): Promise<boolean> {
		return (await this.tryRun(["list-sessions", "-F", "#{session_name}"])) !== null;
	}

	/** Every pane in every session carrying this runner's agent tag. */
	async listTagged(): Promise<TaggedPane[]> {
		const out = await this.tryRun(["list-panes", "-a", "-F", PANE_FIELDS]);
		if (!out) return [];
		const panes: TaggedPane[] = [];
		for (const line of out.split("\n")) {
			if (!line.trim()) continue;
			const parts = line.split("\t");
			const paneId = parts[0] ?? "";
			const agent = parts[1] ?? "";
			if (!paneId || !agent) continue;
			panes.push({
				paneId,
				agent,
				stateDir: parts[2] ?? "",
				runId: parts[3] ?? "",
				childKey: parts[4] ?? "",
				dead: (parts[5] ?? "") === "1",
				session: parts[6] ?? "",
				windowId: parts[7] ?? "",
				paneName: parts[8] ?? "",
			});
		}
		return panes;
	}

	async paneExists(paneId: string): Promise<boolean> {
		const out = await this.tryRun(["display-message", "-p", "-t", paneId, "#{pane_dead}"]);
		return out !== null && out.trim() === "0";
	}

	async setPaneOption(paneId: string, name: string, value: string): Promise<void> {
		await this.run(["set-option", "-p", "-t", paneId, name, value]);
	}

	/**
	 * Create a pane running `command`, and return its pane id.
	 *
	 * `layout: "window"` opens a separate window rather than splitting, which is
	 * the default here: it keeps a fan-out of children off the operator's screen
	 * and makes stray typing into a working pane far less likely.
	 */
	async spawnPane(opts: {
		layout: "split" | "window";
		size: string;
		cwd: string;
		/**
		 * Session to create the window in, for `layout: "window"`.
		 *
		 * Must be a session, never a pane: `new-window -t %12` fails with "can't
		 * specify pane here". Leave unset when running inside tmux, so the window
		 * lands in the session tmux already resolves from $TMUX.
		 */
		targetSession?: string;
		/** Pane to split, for `layout: "split"`. */
		targetPane?: string;
		windowName: string;
		env: Record<string, string>;
		command: string[];
	}): Promise<string> {
		const env: string[] = [];
		for (const [key, value] of Object.entries(opts.env)) env.push("-e", `${key}=${value}`);

		const args =
			opts.layout === "window"
				? [
						"new-window",
						"-d",
						"-P",
						"-F",
						"#{pane_id}",
						"-n",
						opts.windowName,
						"-c",
						opts.cwd,
						...(opts.targetSession ? ["-t", opts.targetSession] : []),
						...env,
					]
				: [
						"split-window",
						"-h",
						"-d",
						"-P",
						"-F",
						"#{pane_id}",
						"-l",
						opts.size,
						"-c",
						opts.cwd,
						...(opts.targetPane ? ["-t", opts.targetPane] : []),
						...env,
					];

		const out = await this.run([...args, "--", ...opts.command], { timeoutMs: SPAWN_TIMEOUT_MS });
		const paneId = out.trim().split("\n").pop()?.trim();
		if (!paneId) throw new Error("tmux did not return a pane id");
		return paneId;
	}

	/**
	 * Ensure a detached session exists to host panes when pi is not inside tmux.
	 *
	 * Idempotent under concurrency. `has-session` followed by `new-session` is a
	 * check-then-act race, and a parallel fan-out runs it from several children
	 * at once: they all miss, they all create, and every loser gets "duplicate
	 * session". Losing that race means the session now exists, which is success.
	 */
	async ensureSession(name: string, cwd: string): Promise<void> {
		if ((await this.tryRun(["has-session", "-t", name])) !== null) return;
		try {
			await this.run(["new-session", "-d", "-s", name, "-c", cwd]);
		} catch (error) {
			if ((await this.tryRun(["has-session", "-t", name])) !== null) return;
			throw error;
		}
	}

	/**
	 * Type text into a pane without submitting it.
	 *
	 * Uses a tmux buffer loaded from a file plus a bracketed paste (`-p`), so a
	 * multi-line prompt arrives as one editor insertion. `send-keys` would submit
	 * at the first newline and would reinterpret words like "Enter" as key names.
	 */
	async pasteFile(paneId: string, bufferName: string, file: string): Promise<void> {
		await this.run(["load-buffer", "-b", bufferName, file]);
		await this.run(["paste-buffer", "-d", "-p", "-b", bufferName, "-t", paneId]);
	}

	async sendKey(paneId: string, key: string): Promise<void> {
		await this.run(["send-keys", "-t", paneId, key]);
	}

	/**
	 * Bring a pane into view and put the cursor in it.
	 *
	 * Selecting the window first matters for `layout: "window"`, where the pane is
	 * in a window the operator is not looking at; `select-pane` alone would move
	 * the cursor inside a window that stays hidden. The window id is resolved
	 * explicitly rather than passing the pane id to `select-window`, which is not
	 * a window target.
	 *
	 * Best-effort throughout: focus is a courtesy, and losing a race with a
	 * closing pane must never fail the child whose work is otherwise fine.
	 */
	async focusPane(paneId: string): Promise<void> {
		const windowId = (await this.tryRun(["display-message", "-p", "-t", paneId, "#{window_id}"]))?.trim();
		if (windowId) await this.tryRun(["select-window", "-t", windowId]);
		await this.tryRun(["select-pane", "-t", paneId]);
	}

	async capture(paneId: string, lines: number): Promise<string> {
		const out = await this.tryRun(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
		return out ?? "";
	}

	async killPane(paneId: string): Promise<void> {
		await this.tryRun(["kill-pane", "-t", paneId]);
	}
}
