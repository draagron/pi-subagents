/**
 * Extension-config defaults for tmux-pane agents.
 *
 * Pane presentation is an operator preference, not a property of the agent: the
 * same profile wants a hidden window on a fan-out and a visible split next to pi
 * on a single delegation. Requiring `layout`/`focus`/`interactive` in every
 * profile would spread one person's terminal habits across every file, so they
 * can be set once in the extension config instead.
 *
 * Agent frontmatter always wins. The config only supplies a value a profile left
 * unset, and an absent config keeps the built-in defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunnerConfig, TmuxPaneDefaultsConfig } from "../../../shared/types.ts";
import { getAgentDir } from "../../../shared/utils.ts";

/** The subset of a tmux-pane runner block that the config can default. */
export type TmuxPaneDefaultableOptions = Pick<
	Extract<AgentRunnerConfig, { type: "tmux-pane" }>,
	"layout" | "size" | "focus" | "interactive"
>;

const DEFAULTABLE_KEYS = ["layout", "size", "focus", "interactive", "reuse"] as const;

/**
 * Validate a `tmuxPane` config block, returning the normalized value.
 *
 * Shared by config validation and config loading so the accepted shape cannot
 * drift between what is written and what is read. Throws with the config path in
 * the message, because that is where the operator has to fix it.
 */
export function parseTmuxPaneDefaults(value: unknown): TmuxPaneDefaultsConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.tmuxPane must be a JSON object");
	const config = value as Record<string, unknown>;

	for (const key of Object.keys(config)) {
		if (!(DEFAULTABLE_KEYS as readonly string[]).includes(key)) {
			throw new Error(`config.tmuxPane.${key} is not supported; supported keys are ${DEFAULTABLE_KEYS.join(", ")}`);
		}
	}
	if (config.layout !== undefined && config.layout !== "split" && config.layout !== "window") {
		throw new Error('config.tmuxPane.layout must be "split" or "window"');
	}
	if (config.size !== undefined && (typeof config.size !== "string" || !config.size.trim())) {
		throw new Error('config.tmuxPane.size must be a non-empty string such as "45%"');
	}
	if (config.focus !== undefined && typeof config.focus !== "boolean") {
		throw new Error("config.tmuxPane.focus must be a boolean");
	}
	if (config.interactive !== undefined && typeof config.interactive !== "boolean") {
		throw new Error("config.tmuxPane.interactive must be a boolean");
	}
	if (config.reuse !== undefined && typeof config.reuse !== "boolean") {
		throw new Error("config.tmuxPane.reuse must be a boolean");
	}

	return {
		...(config.layout ? { layout: config.layout as "split" | "window" } : {}),
		...(typeof config.size === "string" ? { size: config.size.trim() } : {}),
		...(config.focus !== undefined ? { focus: config.focus as boolean } : {}),
		...(config.interactive !== undefined ? { interactive: config.interactive as boolean } : {}),
		...(config.reuse !== undefined ? { reuse: config.reuse as boolean } : {}),
	};
}

export function tmuxPaneConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

/**
 * Read the `tmuxPane` block from the extension config on disk.
 *
 * Read from the file rather than passed down from the parent, because the pane
 * is created inside the detached async runner, which has no ExtensionConfig in
 * scope. Tolerant by design: a malformed config must not fail a delegation that
 * would otherwise run under the built-in defaults, and `saveConfig` already
 * rejects a bad block at the point where it is written.
 */
export function loadTmuxPaneDefaults(configPath = tmuxPaneConfigPath()): TmuxPaneDefaultsConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parseTmuxPaneDefaults((parsed as Record<string, unknown>).tmuxPane) ?? {};
	} catch {
		return {};
	}
}

/**
 * Layer config defaults under an agent's tmux-pane runner block.
 *
 * Presentation only. `reuse` is resolved separately by `resolveTmuxPaneReuse`,
 * because whether it can apply depends on the child, not just on the profile.
 * Model, permission mode and tool allowlists stay agent-owned entirely: they
 * change what the child is allowed to do, and a global default there would
 * silently re-scope every profile.
 */
export function resolveTmuxPaneOptions(
	runner: TmuxPaneDefaultableOptions,
	defaults: TmuxPaneDefaultsConfig = {},
): TmuxPaneDefaultableOptions {
	const layout = runner.layout ?? defaults.layout;
	const size = runner.size ?? defaults.size;
	const focus = runner.focus ?? defaults.focus;
	const interactive = runner.interactive ?? defaults.interactive;
	return {
		...(layout ? { layout } : {}),
		...(size ? { size } : {}),
		...(focus !== undefined ? { focus } : {}),
		...(interactive !== undefined ? { interactive } : {}),
	};
}

export interface ResolvedTmuxPaneReuse {
	/** Effective value the child runs under. */
	reuse: boolean;
	/** True when the profile itself asked for reuse, rather than the config. */
	explicit: boolean;
	/** True when a config default was dropped because this child cannot share a pane. */
	withheld: boolean;
}

/**
 * Decide whether a child reuses the agent's shared pane.
 *
 * Reuse means one pane and therefore one Claude conversation per agent, which is
 * incoherent for concurrent children (interleaved turns) and for children rooted
 * in different worktrees (one context, several trees). Where it cannot hold, the
 * source of the value decides what happens:
 *
 * - A profile that sets `reuse: true` has asserted something about that agent, so
 *   an incompatible launch is refused. Silently running it per-child would make
 *   the field mean nothing.
 * - A config default only states what the operator usually wants, and is meant to
 *   let a new profile be tried out with nothing in its file. Refusing a fan-out
 *   over a preference would turn a convenience into a trap, so the default is
 *   withheld and the child gets its own pane.
 *
 * Resolved at launch, where "is this child parallel or worktree-isolated?" is
 * known, and baked into the step so the detached runner cannot re-derive it
 * differently.
 */
export function resolveTmuxPaneReuse(
	runner: { reuse?: boolean },
	defaults: TmuxPaneDefaultsConfig,
	child: { parallel: boolean; worktree: boolean },
): ResolvedTmuxPaneReuse {
	if (runner.reuse !== undefined) return { reuse: runner.reuse, explicit: true, withheld: false };
	if (defaults.reuse !== true) return { reuse: false, explicit: false, withheld: false };
	const shared = child.parallel || child.worktree;
	return { reuse: !shared, explicit: false, withheld: shared };
}
