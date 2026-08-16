/**
 * Spawning a Claude Code child into a tmux pane.
 *
 * Everything that differs from the `claude-tmux` extension this is ported from
 * is concentrated here: identity is per logical child rather than per agent,
 * ownership is a file lock rather than an in-process promise, state lives under
 * the run's async dir rather than the project, and the recursion guard uses the
 * counter semantics `pi-subagents` already defines.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSubagentDepthEnv } from "../../../shared/types.ts";
import { writeHookConfig } from "./events.ts";
import { ClaudePane, type PaneMeta } from "./pane.ts";
import {
	acquirePaneOwnership,
	type ChildIdentity,
	childKeyFor,
	paneNameForChild,
	paneNameForReuse,
	sanitizeAgentName,
} from "./pane-identity.ts";
import {
	PANE_OPTION_AGENT,
	PANE_OPTION_CHILD,
	PANE_OPTION_RUN,
	PANE_OPTION_SESSION,
	PANE_OPTION_STATE,
	type Tmux,
} from "./tmux.ts";

export const TMUX_PANE_STATE_DIRNAME = "tmux-pane";
export const DEFAULT_FALLBACK_SESSION = "pi-subagents";
/** `window` keeps a fan-out off the operator's screen and reduces stray typing. */
export const DEFAULT_LAYOUT: "split" | "window" = "window";
export const DEFAULT_SPLIT_SIZE = "45%";

export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";

export interface SpawnPaneOptions {
	identity: ChildIdentity;
	/** Resolved child cwd. Worktree isolation arrives here already applied. */
	cwd: string;
	/** Root for pane state; the run's async dir keeps it off worktree paths. */
	stateRoot: string;
	claudeBin: string;
	nodeBin: string;
	model?: string;
	permissionMode?: PermissionMode;
	allowedTools?: string[];
	disallowedTools?: string[];
	addDirs?: string[];
	layout?: "split" | "window";
	size?: string;
	extraArgs?: string[];
	appendSystemPrompt?: string;
	/** Install the PreToolUse hook so tool activity streams back. */
	progress?: boolean;
	/** Reuse a pane keyed by agent name. Caller must have validated this. */
	reuse?: boolean;
	fallbackSession?: string;
	maxSubagentDepth?: number;
	/**
	 * Optional ceiling on live panes. Left unset by default: `runs.all` already
	 * governs concurrency, and a second independent cap would fail children on
	 * the basis of scheduling order.
	 */
	maxPanes?: number;
}

export interface SpawnedPane {
	pane: ClaudePane;
	/** Releases the ownership lock. Always call, even on failure paths. */
	release: () => void;
}

export function isTmuxPaneSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

export function paneStateDir(stateRoot: string, paneName: string): string {
	return path.join(stateRoot, TMUX_PANE_STATE_DIRNAME, paneName);
}

export function resolvePaneName(identity: ChildIdentity, reuse: boolean | undefined): string {
	return reuse ? paneNameForReuse(identity.agent) : paneNameForChild(identity);
}

export function buildClaudeCommand(options: SpawnPaneOptions & { settingsPath: string; claudeSessionId: string; paneName: string }): string[] {
	const command = [
		options.claudeBin,
		"--session-id",
		options.claudeSessionId,
		"--settings",
		options.settingsPath,
		"-n",
		options.paneName,
	];
	if (options.appendSystemPrompt) command.push("--append-system-prompt", options.appendSystemPrompt);
	if (options.permissionMode) command.push("--permission-mode", options.permissionMode);
	if (options.model) command.push("--model", options.model);
	if (options.allowedTools?.length) command.push("--allowedTools", ...options.allowedTools);
	if (options.disallowedTools?.length) command.push("--disallowedTools", ...options.disallowedTools);
	for (const dir of options.addDirs ?? []) command.push("--add-dir", dir);
	command.push(...(options.extraArgs ?? []));
	return command;
}

/**
 * Create a pane, tag it, take ownership, and wait until Claude is ready to
 * accept a paste.
 *
 * The caller owns the returned `release`; the lock outlives this function so a
 * second process cannot adopt the pane mid-turn.
 */
export async function spawnClaudePane(tmux: Tmux, options: SpawnPaneOptions): Promise<SpawnedPane> {
	if (!isTmuxPaneSupportedPlatform()) {
		throw new Error("runner.type='tmux-pane' requires tmux, which is not available on Windows.");
	}

	const agent = sanitizeAgentName(options.identity.agent);
	const paneName = resolvePaneName(options.identity, options.reuse);
	const stateDir = paneStateDir(options.stateRoot, paneName);

	if (options.maxPanes !== undefined) {
		const live = (await tmux.listTagged()).filter((pane) => !pane.dead).length;
		if (live >= options.maxPanes) {
			throw new Error(
				`Refusing to spawn a pane for '${agent}': ${live} panes already live (maxPanes=${options.maxPanes}). ` +
					`Lower the group's concurrency or raise maxPanes.`,
			);
		}
	}

	const release = acquirePaneOwnership(stateDir, {
		pid: process.pid,
		runId: options.identity.runId,
		stepIndex: options.identity.stepIndex,
		childIndex: options.identity.childIndex,
		acquiredAt: Date.now(),
	});

	try {
		// Hook scripts, task files and event logs are scratch; never commit them.
		const stateParent = path.join(options.stateRoot, TMUX_PANE_STATE_DIRNAME);
		fs.mkdirSync(stateParent, { recursive: true });
		const ignore = path.join(stateParent, ".gitignore");
		if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");

		const claudeSessionId = randomUUID();
		const settingsPath = writeHookConfig(stateDir, {
			nodePath: options.nodeBin,
			progress: options.progress ?? true,
		});
		const command = buildClaudeCommand({ ...options, settingsPath, claudeSessionId, paneName });

		const layout = options.layout ?? DEFAULT_LAYOUT;
		let target = tmux.selfPane;
		let effectiveLayout = layout;
		if (!tmux.inside) {
			// Not inside tmux, so there is no pane to split. Host children in a
			// dedicated session the operator can attach to.
			const fallback = options.fallbackSession ?? DEFAULT_FALLBACK_SESSION;
			await tmux.ensureSession(fallback, options.cwd);
			target = fallback;
			effectiveLayout = "window";
		}

		const paneId = await tmux.spawnPane({
			layout: effectiveLayout,
			size: options.size ?? DEFAULT_SPLIT_SIZE,
			cwd: options.cwd,
			...(target ? { target } : {}),
			windowName: paneName,
			// Counter semantics, not the extension's boolean guard: this process is
			// already a subagent, so a boolean would refuse every spawn. Passing the
			// incremented counter lets a pane that itself loads claude-tmux refuse
			// to nest further.
			env: {
				...getSubagentDepthEnv(options.maxSubagentDepth),
				PI_SUBAGENT_NAME: agent,
			},
			command,
		});

		await tmux.setPaneOption(paneId, PANE_OPTION_AGENT, agent);
		await tmux.setPaneOption(paneId, PANE_OPTION_SESSION, claudeSessionId);
		await tmux.setPaneOption(paneId, PANE_OPTION_STATE, stateDir);
		await tmux.setPaneOption(paneId, PANE_OPTION_RUN, options.identity.runId);
		await tmux.setPaneOption(paneId, PANE_OPTION_CHILD, childKeyFor(options.identity));

		const meta: PaneMeta = {
			...options.identity,
			agent,
			paneName,
			paneId,
			claudeSessionId,
			cwd: options.cwd,
			stateDir,
			createdAt: Date.now(),
		};
		const pane = new ClaudePane(meta, tmux);
		pane.attach({ fromEnd: true });
		pane.persist();

		// Claude must render its prompt before it will accept a paste. This also
		// surfaces the workspace trust dialog as a specific error.
		await pane.waitForPrompt();

		return { pane, release };
	} catch (error) {
		release();
		throw error;
	}
}
