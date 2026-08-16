/**
 * Real tmux + real Claude Code end-to-end tests for the tmux-pane runner.
 *
 * These spawn actual `claude` sessions and consume real subscription usage, so
 * they are opt-in via PI_SUBAGENTS_TMUX_E2E=1 in addition to requiring tmux and
 * claude on PATH. Everything else about the runner is covered by unit tests
 * against a faked tmux.
 *
 * Claude must already trust the throwaway repository these tests create. The
 * runner deliberately refuses to answer the workspace trust dialog itself -
 * pasting into it would silently accept a security prompt - so the tests
 * perform that one-time acceptance the way an operator would, by hand.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { runTmuxPane } from "../../src/runs/shared/tmux-pane/runner.ts";
import { resolveExecutableOnPath } from "../../src/runs/shared/tmux-pane/spawn.ts";
import { TrustDialogError } from "../../src/runs/shared/tmux-pane/pane.ts";
import { resolveNodeExecutable } from "../../src/shared/node-executable.ts";

const HOST_SESSION = "pi-subagents-e2e";
const optedIn = process.env.PI_SUBAGENTS_TMUX_E2E === "1";
const hasTmux = resolveExecutableOnPath("tmux") !== undefined;
const hasClaude = resolveExecutableOnPath("claude") !== undefined;
const skipReason = !optedIn
	? "set PI_SUBAGENTS_TMUX_E2E=1 to run tmux-pane e2e tests (they use real Claude usage)"
	: !hasTmux
		? "tmux is not installed"
		: !hasClaude
			? "the claude CLI is not installed"
			: undefined;

const tempDirs: string[] = [];

function tmux(args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf-8" });
}

function killSession(name: string): void {
	try {
		execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
	} catch {
		// Already gone.
	}
}

function sleepSync(seconds: number): void {
	execFileSync("sleep", [String(seconds)]);
}

function makeRepo(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(root);
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "e2e\n");
	execFileSync("git", ["add", "-A"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-qm", "init"], { cwd: repo });
	return repo;
}

/** Accept Claude's trust dialog once, as an operator would before a run. */
function trustRepoOnce(dir: string): void {
	const session = "pi-subagents-e2e-trust";
	killSession(session);
	tmux(["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", dir, "claude"]);
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		const text = tmux(["capture-pane", "-p", "-t", session]);
		if (/trust this folder/i.test(text)) {
			tmux(["send-keys", "-t", session, "Enter"]);
			sleepSync(4);
			break;
		}
		if (/Welcome back|│ >/.test(text)) break;
		sleepSync(1);
	}
	killSession(session);
}

function baseInput(overrides: Record<string, unknown>): Parameters<typeof runTmuxPane>[0] {
	return {
		claudeBin: resolveExecutableOnPath("claude") ?? "claude",
		nodeBin: resolveNodeExecutable(),
		permissionMode: "acceptEdits",
		layout: "window",
		submitTimeoutMs: 90_000,
		timeoutMs: 240_000,
		fallbackSession: HOST_SESSION,
		...overrides,
	} as Parameters<typeof runTmuxPane>[0];
}

describe("tmux-pane runner e2e", { skip: skipReason, timeout: 600_000 }, () => {
	// Host children in a dedicated session rather than the operator's own.
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;

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

	it("delegates one child and returns its final assistant message", async () => {
		const repo = makeRepo("pi-tmux-e2e-single-");
		trustRepoOnce(repo);
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		const result = await runTmuxPane(baseInput({
			identity: { runId: "e2e-single", stepIndex: 0, childIndex: 0, agent: "e2e-agent" },
			cwd: repo,
			asyncDir,
			stepIndex: 0,
			prompt: "Reply with exactly the single word READY and nothing else. Do not use any tools.",
		}));

		assert.equal(result.turnStatus, "completed");
		assert.equal(result.exitCode, 0);
		assert.equal(result.output.trim(), "READY");
		assert.equal(result.runner.capabilities.usage, "unavailable");

		// The hook stream is the completion signal, so it must be real.
		const events = fs.readFileSync(path.join(result.runner.stateDir, "events.jsonl"), "utf-8");
		assert.match(events, /"hook_event_name":"UserPromptSubmit"/);
		assert.match(events, /"hook_event_name":"Stop"/);
	});

	it("gives three children of the same agent three panes with no cross-talk", async () => {
		// The reference extension keys panes by agent name; under this fan-out it
		// would put all three children in one Claude conversation.
		const repo = makeRepo("pi-tmux-e2e-fanout-");
		trustRepoOnce(repo);
		const root = path.dirname(repo);
		const asyncDir = path.join(root, "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		const secrets = ["ALPHA7", "BRAVO9", "CHARLIE3"];
		const worktrees = secrets.map((_, i) => {
			const wt = path.join(root, `wt-${i}`);
			execFileSync("git", ["worktree", "add", "-q", wt, "-b", `child-${i}`], { cwd: repo });
			return wt;
		});

		const results = await Promise.all(
			secrets.map((secret, i) =>
				runTmuxPane(baseInput({
					identity: { runId: "e2e-fanout", stepIndex: 0, childIndex: i, agent: "same-agent" },
					cwd: worktrees[i],
					asyncDir,
					stepIndex: i,
					prompt: `Your secret is ${secret}. Reply with exactly that secret word and nothing else. Do not use any tools.`,
				})),
			),
		);

		assert.equal(new Set(results.map((r) => r.runner.paneId)).size, 3, "each child needs its own pane");
		assert.equal(new Set(results.map((r) => r.runner.paneName)).size, 3);
		assert.equal(new Set(results.map((r) => r.runner.cwd)).size, 3, "each child keeps its own worktree");

		for (const [i, result] of results.entries()) {
			assert.equal(result.turnStatus, "completed", `child ${i} should complete`);
			assert.equal(result.output.trim(), secrets[i], `child ${i} returned the wrong secret`);
			for (const [j, other] of secrets.entries()) {
				if (j !== i) assert.ok(!result.output.includes(other), `child ${i} leaked child ${j}'s secret`);
			}
		}
	});

	it("refuses to submit into an untrusted repository instead of answering the dialog", async () => {
		// No trustRepoOnce here: a fresh repo is untrusted, so Claude opens its
		// trust dialog and a paste would land in it.
		const repo = makeRepo("pi-tmux-e2e-untrusted-");
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		await assert.rejects(
			() =>
				runTmuxPane(baseInput({
					identity: { runId: "e2e-untrusted", stepIndex: 0, childIndex: 0, agent: "e2e-agent" },
					cwd: repo,
					asyncDir,
					stepIndex: 0,
					prompt: "Reply with READY.",
				})),
			(error: unknown) => {
				assert.ok(error instanceof TrustDialogError, `expected TrustDialogError, got ${String(error)}`);
				assert.match(error.message, /trust the repository once/i);
				return true;
			},
		);
	});
});
