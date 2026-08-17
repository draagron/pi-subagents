/**
 * Real tmux, no Claude: pane placement and focus.
 *
 * The unit tests drive a faked tmux, which can prove the runner asks for the
 * right thing but not that tmux does it. These assert the two claims an operator
 * actually cares about - a `split` child lands in the window pi is running in,
 * and `focus` moves the active pane - against the real tmux CLI.
 *
 * A stub program stands in for Claude: it prints the prompt marker the runner
 * waits for and then sleeps. That keeps this file free of subscription usage, so
 * unlike `tmux-pane-runner.test.ts` it needs no opt-in beyond having tmux.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { paneStateDir, resolveExecutableOnPath, spawnClaudePane } from "../../src/runs/shared/tmux-pane/spawn.ts";
import { paneNameForChild } from "../../src/runs/shared/tmux-pane/pane-identity.ts";
import { Tmux } from "../../src/runs/shared/tmux-pane/tmux.ts";

const HOST_SESSION = "pi-subagents-layout-e2e";
const skipReason = process.platform === "win32"
	? "tmux-pane is not supported on Windows"
	: resolveExecutableOnPath("tmux") === undefined
		? "tmux is not installed"
		: undefined;

const tempDirs: string[] = [];

function tmuxCli(args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf-8" }).trim();
}

function killSession(name: string): void {
	try {
		execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
	} catch {
		// Already gone.
	}
}

function paneField(paneId: string, field: string): string {
	return tmuxCli(["display-message", "-p", "-t", paneId, field]);
}

/** A stand-in for `claude`: draws the prompt marker, then stays alive. */
function writeStubClaude(dir: string): string {
	const stub = path.join(dir, "stub-claude.sh");
	fs.writeFileSync(stub, "#!/bin/sh\nprintf '\\342\\224\\202 > '\nexec sleep 120\n", { mode: 0o755 });
	return stub;
}

describe("tmux-pane placement and focus", { skip: skipReason, timeout: 120_000 }, () => {
	after(() => {
		killSession(HOST_SESSION);
		for (const dir of tempDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort.
			}
		}
	});

	/**
	 * Stand up a detached session and present its pane as the one pi runs in.
	 *
	 * `Tmux` reads $TMUX/$TMUX_PANE to decide whether it can split at all, so the
	 * inside-tmux path can only be exercised by supplying them. $TMUX has to be
	 * the genuine `socket,pid,session` triple, because the tmux CLI resolves its
	 * server socket from it: a placeholder makes every later call fail with
	 * "error connecting to ...".
	 */
	function withHostPane(run: (hostPane: string, dir: string) => Promise<void>): () => Promise<void> {
		return async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-layout-"));
			tempDirs.push(dir);
			killSession(HOST_SESSION);
			tmuxCli(["new-session", "-d", "-s", HOST_SESSION, "-x", "200", "-y", "50", "-c", dir, "sh", "-c", "sleep 120"]);
			const [hostPane, socketPath, serverPid, sessionId] = tmuxCli([
				"display-message", "-p", "-t", HOST_SESSION,
				"#{pane_id}\n#{socket_path}\n#{pid}\n#{session_id}",
			]).split("\n");
			const outerTmux = process.env.TMUX;
			const outerPane = process.env.TMUX_PANE;
			process.env.TMUX = `${socketPath},${serverPid},${(sessionId ?? "").replace("$", "")}`;
			process.env.TMUX_PANE = hostPane;
			try {
				await run(hostPane ?? "", dir);
			} finally {
				if (outerTmux === undefined) delete process.env.TMUX;
				else process.env.TMUX = outerTmux;
				if (outerPane === undefined) delete process.env.TMUX_PANE;
				else process.env.TMUX_PANE = outerPane;
				killSession(HOST_SESSION);
			}
		};
	}

	it("splits the pane pi runs in, leaving the cursor where it was", withHostPane(async (hostPane, dir) => {
		const identity = { runId: "layout-1", stepIndex: 0, childIndex: 0, agent: "pair" };
		const { pane, release } = await spawnClaudePane(new Tmux(), {
			identity,
			cwd: dir,
			stateRoot: path.join(dir, "async"),
			claudeBin: writeStubClaude(dir),
			nodeBin: process.execPath,
			layout: "split",
			size: "40%",
		});
		try {
			assert.equal(paneField(pane.paneId, "#{window_id}"), paneField(hostPane, "#{window_id}"), "a split child must be visible in pi's own window");
			assert.equal(tmuxCli(["display-message", "-p", "-t", pane.paneId, "#{window_panes}"]), "2");
			// Visible, but not stealing the cursor: `focus` was not requested.
			assert.equal(paneField(hostPane, "#{pane_active}"), "1");
			assert.equal(paneField(pane.paneId, "#{pane_active}"), "0");
			// The pane really is running the child, and is registered as this child's.
			assert.equal(paneField(pane.paneId, "#{@pi_subagent_child}"), "s0-c0");
			assert.equal(paneStateDir(path.join(dir, "async"), paneNameForChild(identity)), pane.meta.stateDir);
		} finally {
			await pane.kill().catch(() => {});
			release();
		}
	}));

	it("moves the active pane when focus is requested", withHostPane(async (hostPane, dir) => {
		const { pane, release } = await spawnClaudePane(new Tmux(), {
			identity: { runId: "layout-2", stepIndex: 0, childIndex: 0, agent: "pair" },
			cwd: dir,
			stateRoot: path.join(dir, "async"),
			claudeBin: writeStubClaude(dir),
			nodeBin: process.execPath,
			layout: "split",
			focus: true,
		});
		try {
			assert.equal(paneField(pane.paneId, "#{pane_active}"), "1", "focus must select the child pane");
			assert.equal(paneField(hostPane, "#{pane_active}"), "0");
		} finally {
			await pane.kill().catch(() => {});
			release();
		}
	}));

	it("selects the window too, so a windowed child is not focused out of sight", withHostPane(async (_hostPane, dir) => {
		const { pane, release } = await spawnClaudePane(new Tmux(), {
			identity: { runId: "layout-3", stepIndex: 0, childIndex: 0, agent: "pair" },
			cwd: dir,
			stateRoot: path.join(dir, "async"),
			claudeBin: writeStubClaude(dir),
			nodeBin: process.execPath,
			layout: "window",
			focus: true,
		});
		try {
			// `new-window -d` deliberately does not switch; focus is what brings it up.
			assert.equal(paneField(pane.paneId, "#{window_active}"), "1");
			assert.equal(paneField(pane.paneId, "#{pane_active}"), "1");
		} finally {
			await pane.kill().catch(() => {});
			release();
		}
	}));
});
