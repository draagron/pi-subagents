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
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { enqueueStepSteer, steerAcksDir } from "../../src/runs/background/control-channel.ts";
import { runTmuxPane } from "../../src/runs/shared/tmux-pane/runner.ts";
import { paneNameForChild } from "../../src/runs/shared/tmux-pane/pane-identity.ts";
import { paneStateDir, resolveExecutableOnPath } from "../../src/runs/shared/tmux-pane/spawn.ts";
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

	it("relays a steer into a live pane without superseding the turn", async () => {
		const repo = makeRepo("pi-tmux-e2e-steer-");
		trustRepoOnce(repo);
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		const identity = { runId: "e2e-steer", stepIndex: 0, childIndex: 0, agent: "steer-agent" };
		const stateDir = paneStateDir(asyncDir, paneNameForChild(identity));
		const eventsPath = path.join(stateDir, "events.jsonl");

		// A long generation keeps the turn open long enough to steer into it.
		const pending = runTmuxPane(baseInput({
			identity,
			cwd: repo,
			asyncDir,
			stepIndex: 0,
			prompt: "Count from 1 to 300, writing one number per line and nothing else. Do not use any tools.",
		}));

		// Wait until Claude has actually accepted the task before steering.
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath) && /"hook_event_name":"UserPromptSubmit"/.test(fs.readFileSync(eventsPath, "utf-8"))) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		assert.ok(fs.existsSync(eventsPath), "the turn should have started");

		enqueueStepSteer(asyncDir, 0, {
			type: "steer",
			id: "steer-e2e-1",
			ts: Date.now(),
			message: "Additional note: when you are done counting, also say STEERED.",
		});

		const result = await pending;

		// The steer must not have killed the turn it was steering.
		assert.notEqual(result.turnStatus, "superseded", "a steer must not supersede its own turn");
		assert.equal(result.turnStatus, "completed");

		const ackDir = steerAcksDir(asyncDir, 0);
		const acks = fs.existsSync(ackDir)
			? fs.readdirSync(ackDir).map((file) => JSON.parse(fs.readFileSync(path.join(ackDir, file), "utf-8")) as { requestId: string; state: string })
			: [];
		const ack = acks.find((entry) => entry.requestId === "steer-e2e-1");
		assert.ok(ack, `expected an acknowledgment for the steer, saw ${JSON.stringify(acks)}`);
		// Claude queues input pasted mid-turn, so the honest receipt at this point
		// is "queued"; "delivered" is only possible if it happened to submit while
		// the relay was still running.
		assert.ok(["queued", "delivered"].includes(ack.state), `unexpected ack state ${ack.state}`);

		// The substantive claim is that the message really reached Claude, not
		// merely that tmux accepted a paste. Claude picks queued input up at the
		// next turn boundary, so wait for its own UserPromptSubmit to appear.
		const promptIds = () =>
			new Set(
				fs.readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean)
					.map((line) => JSON.parse(line) as { hook_event_name: string; prompt_id?: string })
					.filter((event) => event.hook_event_name === "UserPromptSubmit")
					.map((event) => event.prompt_id),
			);
		const submitDeadline = Date.now() + 30_000;
		while (Date.now() < submitDeadline && promptIds().size < 2) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		assert.ok(promptIds().size >= 2, `the steer should reach Claude as its own prompt, saw ${promptIds().size}`);
	});

	it("runs through the async runner's dispatch branch and persists status and result", async () => {
		// Drives src/runs/background/subagent-runner.ts as a real process, the way
		// an async run does, so the dispatch branch itself is covered rather than
		// runTmuxPane being called directly.
		const repo = makeRepo("pi-tmux-e2e-dispatch-");
		trustRepoOnce(repo);
		const dir = path.dirname(repo);
		const asyncDir = path.join(dir, "async");
		fs.mkdirSync(asyncDir, { recursive: true });
		const resultPath = path.join(dir, "result.json");
		const configPath = path.join(dir, "config.json");

		fs.writeFileSync(configPath, JSON.stringify({
			id: "tmux-pane-dispatch",
			sessionId: "session-tmux-pane",
			steps: [{
				agent: "pane-agent",
				task: "Reply with exactly the single word READY and nothing else. Do not use any tools.",
				runner: { type: "tmux-pane", program: "claude", permissionMode: "acceptEdits", layout: "window" },
				systemPrompt: "You are a test child.",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			}],
			resultPath,
			cwd: repo,
			placeholder: "{previous}",
			artifactConfig: { enabled: false },
			asyncDir,
			resultMode: "single",
		}));

		const repoRoot = path.resolve(import.meta.dirname, "../..");
		const childEnv = { ...process.env };
		// Force the dedicated host session rather than inheriting this process's.
		delete childEnv.TMUX;
		delete childEnv.TMUX_PANE;
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[path.join(repoRoot, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(repoRoot, "src/runs/background/subagent-runner.ts"), configPath],
				{ cwd: repoRoot, stdio: "inherit", shell: false, env: childEnv },
			);
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(exitCode, 0);

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.equal(status.state, "complete");
		assert.equal(status.steps[0].runner.type, "tmux-pane");
		assert.equal(status.steps[0].runner.program, "claude");
		assert.ok(status.steps[0].runner.paneId, "the pane id must be recorded for operators");
		assert.match(status.steps[0].runner.paneName, /^pi-tmux-pane-dispatch-s0-c0-pane-agent$/);
		assert.equal(status.steps[0].runner.capabilities.usage, "unavailable");
		assert.equal(status.steps[0].runner.capabilities.steer, true);

		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /READY/);
		assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.step\.completed/);

		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(result.success, true);
		assert.equal(result.results[0].runner.type, "tmux-pane");
		assert.match(result.results[0].output, /READY/);
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
