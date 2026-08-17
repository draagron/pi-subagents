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

// Captured before the suite clears them: one test needs the genuine
// inside-tmux context back, because that path behaves differently.
const OUTER_TMUX = process.env.TMUX;
const OUTER_TMUX_PANE = process.env.TMUX_PANE;

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

function killPane(paneId: string): void {
	try {
		execFileSync("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
	} catch {
		// Already gone.
	}
}

function paneAlive(paneId: string): boolean {
	try {
		return execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_dead}"], { encoding: "utf-8" }).trim() === "0";
	} catch {
		return false;
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

	it("raises needs-attention on a real permission prompt and pauses the deadline", async () => {
		const repo = makeRepo("pi-tmux-e2e-attention-");
		// A project-level ask rule forces a genuine permission prompt. It must go
		// here and NOT in extraArgs: a second --settings replaces the generated
		// hook config rather than merging, leaving the child with no hook stream.
		fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: ["Bash"] } }));
		trustRepoOnce(repo);
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		const timeoutMs = 15_000;
		const holdMs = 30_000; // deliberately longer than timeoutMs
		const startedAt = Date.now();
		const attention: string[] = [];
		let paneId = "";

		const pending = runTmuxPane(baseInput({
			identity: { runId: "e2e-attn", stepIndex: 0, childIndex: 0, agent: "attn-agent" },
			cwd: repo,
			asyncDir,
			stepIndex: 0,
			permissionMode: "manual",
			prompt: "Use the Bash tool to run exactly: echo PERMISSION_TEST. Then reply with the output.",
			timeoutMs,
			onRunnerStatus: (r: { paneId?: string }) => { paneId = r.paneId ?? ""; },
			onNeedsAttention: (message: string) => attention.push(message),
		}));

		// Leave the prompt unanswered past the deadline, then approve it. If the
		// blocked clock were not paused, the turn would have timed out by now.
		let approved = false;
		while (!approved && Date.now() - startedAt < 90_000) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (!paneId || attention.length === 0) continue;
			if (Date.now() - startedAt < holdMs) continue;
			approved = true;
			tmux(["send-keys", "-t", paneId, "Enter"]);
		}
		assert.ok(approved, "the permission prompt never appeared");

		const result = await pending;
		assert.ok(attention.length > 0, "a permission prompt must surface as needs-attention");
		assert.match(attention[0] ?? "", /permission/i);
		assert.equal(result.turnStatus, "completed", "the deadline must not run while blocked on a human");
		assert.equal(result.timedOut ?? false, false);
		assert.match(result.output, /PERMISSION_TEST/);
	});

	it("fails fast when its pane is killed externally mid-turn", async () => {
		const repo = makeRepo("pi-tmux-e2e-killed-");
		trustRepoOnce(repo);
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		// Generous deadline: if the death were only noticed by the timeout, this
		// would take timeoutMs rather than seconds, and the assertion below on
		// elapsed time would catch that regression.
		const timeoutMs = 45_000;
		const startedAt = Date.now();
		let paneId = "";

		const pending = runTmuxPane(baseInput({
			identity: { runId: "e2e-killed", stepIndex: 0, childIndex: 0, agent: "killed-agent" },
			cwd: repo,
			asyncDir,
			stepIndex: 0,
			prompt: "Count slowly from 1 to 3000, one number per line, nothing else. Do not use any tools.",
			timeoutMs,
			onRunnerStatus: (r: { paneId?: string }) => { paneId = r.paneId ?? ""; },
		}));

		while (!paneId && Date.now() - startedAt < 60_000) await new Promise((r) => setTimeout(r, 200));
		assert.ok(paneId, "the pane should have been created");
		await new Promise((r) => setTimeout(r, 7_000));
		killPane(paneId);

		const result = await pending;
		const elapsed = Date.now() - startedAt;

		assert.equal(result.turnStatus, "session_ended");
		assert.notEqual(result.exitCode, 0, "a killed pane must never report success");
		assert.equal(result.output, "", "there is no deliverable without a Stop hook");
		assert.match(result.error ?? "", /exited in pane .* before completing the task/);
		assert.ok(elapsed < timeoutMs - 5_000, `death should be seen via the SessionEnd hook, not the deadline (took ${elapsed}ms)`);
	});

	it("reuses one pane across runs and carries its conversation", async () => {
		// reuse: true keys the pane by agent alone, so a second run must adopt the
		// live pane rather than spawn a second one. Without adoption this passes
		// the naming check but silently starts a fresh Claude with no context.
		const repo = makeRepo("pi-tmux-e2e-reuse-");
		trustRepoOnce(repo);
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		const run = (runId: string, prompt: string) =>
			runTmuxPane(baseInput({
				identity: { runId, stepIndex: 0, childIndex: 0, agent: "reuse-agent" },
				cwd: repo,
				asyncDir,
				stepIndex: 0,
				prompt,
				reuse: true,
			}));

		const first = await run("e2e-reuse-1", "Remember this codeword: ZEPHYR42. Reply with exactly OK and nothing else.");
		assert.equal(first.turnStatus, "completed");

		const second = await run(
			"e2e-reuse-2",
			"What codeword did I ask you to remember earlier in this conversation? Reply with just the codeword, or NONE if you were not told one.",
		);
		assert.equal(second.turnStatus, "completed");

		assert.equal(second.runner.paneId, first.runner.paneId, "the second run must adopt the first run's pane");
		assert.match(second.output, /ZEPHYR42/, "reuse exists to carry conversation context across runs");

		// Exactly one pane, not an orphan per run. Scope this to THIS test's state
		// dir: the agent name alone would also count panes left by earlier runs of
		// the suite, which live in the same tmux session.
		const stateDir = paneStateDir(asyncDir, second.runner.paneName ?? "");
		const live = tmux(["list-panes", "-a", "-F", "#{pane_id} #{@pi_claude_state}"])
			.split("\n")
			.filter((line) => line.includes(stateDir));
		assert.equal(live.length, 1, `reuse must not leak a pane per run, saw ${live.length}`);
	});

	/**
	 * Drive a long turn, then fire the registered control callback.
	 *
	 * Stop and timeout share the whole path and differ only in which seam the
	 * async runner uses, so they are exercised through one helper.
	 */
	async function runAndControl(control: "stop" | "timeout", prefix: string) {
		const repo = makeRepo(prefix);
		trustRepoOnce(repo);
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		let fire: (() => void) | undefined;
		let paneId = "";
		const register = (fn: (() => void) | undefined) => { if (fn) fire = fn; };

		const pending = runTmuxPane(baseInput({
			identity: { runId: `e2e-${control}`, stepIndex: 0, childIndex: 0, agent: `${control}-agent` },
			cwd: repo,
			asyncDir,
			stepIndex: 0,
			prompt: "Count slowly from 1 to 3000, one number per line, nothing else. Do not use any tools.",
			timeoutMs: 300_000,
			onRunnerStatus: (r: { paneId?: string }) => { paneId = r.paneId ?? ""; },
			...(control === "stop" ? { registerStop: register } : { registerTimeout: register }),
		}));

		// Act as soon as the turn is provably underway, rather than after a fixed
		// wait: how long the child keeps generating is up to the model, and a
		// short turn would finish before a fixed delay elapsed, leaving nothing
		// to stop.
		const eventsPath = path.join(
			paneStateDir(asyncDir, paneNameForChild({ runId: `e2e-${control}`, stepIndex: 0, childIndex: 0, agent: `${control}-agent` })),
			"events.jsonl",
		);
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			if (fire && fs.existsSync(eventsPath) && /"hook_event_name":"UserPromptSubmit"/.test(fs.readFileSync(eventsPath, "utf-8"))) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.ok(fire, "the control callback should have been registered");
		await new Promise((r) => setTimeout(r, 1_500));
		fire();

		const result = await pending;
		assert.notEqual(result.turnStatus, "completed", "the turn finished before it could be controlled; make the task longer");
		await new Promise((r) => setTimeout(r, 500));
		return { result, paneId };
	}

	it("stops a child and tears its pane down", async () => {
		const { result, paneId } = await runAndControl("stop", "pi-tmux-e2e-stop-");

		assert.equal(result.stopped, true);
		assert.notEqual(result.exitCode, 0, "a stopped child is not a success");
		assert.equal(result.timedOut ?? false, false);
		assert.equal(paneAlive(paneId), false, "stop must remove the pane");
		// No Stop hook fires on an interrupt, so the transcript is the only route
		// back to whatever the child had produced.
		assert.match(result.error ?? "", /Partial work is in .*\.jsonl/);
	});

	it("times a child out, preserves its pane, and names it", async () => {
		const { result, paneId } = await runAndControl("timeout", "pi-tmux-e2e-timeout-");

		assert.equal(result.timedOut, true);
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.stopped ?? false, false);
		assert.equal(paneAlive(paneId), true, "timeout must preserve the pane for inspection");
		assert.match(result.error ?? "", new RegExp(`Pane ${paneId.replace("%", "%")} was left running`));
		assert.match(result.error ?? "", /partial work is in .*\.jsonl/);
	});

	it("spawns correctly when pi itself is running inside tmux", async () => {
		// Every other test here runs with $TMUX cleared, so children land in a
		// dedicated session. That is NOT what a real user hits: when pi runs inside
		// tmux the runner targets the current session instead, and a window must be
		// created in a session while a split is created from a pane. Passing this
		// process's pane id to `new-window -t` fails with "can't specify pane
		// here", which is exactly the bug this covers.
		if (!OUTER_TMUX) {
			// Cannot exercise the path if the suite itself is not inside tmux.
			return;
		}
		const repo = makeRepo("pi-tmux-e2e-inside-");
		trustRepoOnce(repo);
		const asyncDir = path.join(path.dirname(repo), "async");
		fs.mkdirSync(asyncDir, { recursive: true });

		process.env.TMUX = OUTER_TMUX;
		if (OUTER_TMUX_PANE) process.env.TMUX_PANE = OUTER_TMUX_PANE;
		let paneId = "";
		try {
			const result = await runTmuxPane(baseInput({
				identity: { runId: "e2e-inside", stepIndex: 0, childIndex: 0, agent: "inside-agent" },
				cwd: repo,
				asyncDir,
				stepIndex: 0,
				prompt: "Reply with exactly the single word INSIDE and nothing else. Do not use any tools.",
				onRunnerStatus: (r: { paneId?: string }) => { paneId = r.paneId ?? ""; },
			}));
			assert.equal(result.turnStatus, "completed");
			assert.equal(result.output.trim(), "INSIDE");
		} finally {
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;
			if (paneId) killPane(paneId);
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
