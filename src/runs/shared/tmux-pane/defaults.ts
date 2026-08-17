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

const DEFAULTABLE_KEYS = ["layout", "size", "focus", "interactive"] as const;

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

	return {
		...(config.layout ? { layout: config.layout as "split" | "window" } : {}),
		...(typeof config.size === "string" ? { size: config.size.trim() } : {}),
		...(config.focus !== undefined ? { focus: config.focus as boolean } : {}),
		...(config.interactive !== undefined ? { interactive: config.interactive as boolean } : {}),
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
 * Only the presentation fields are defaultable. Model, permission mode, tool
 * allowlists and `reuse` stay agent-owned: they change what the child is allowed
 * to do, and a global default there would silently re-scope every profile.
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
