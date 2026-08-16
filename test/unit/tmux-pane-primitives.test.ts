import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { appendLocalEvent, EventTail, writeHookConfig } from "../../src/runs/shared/tmux-pane/events.ts";
import {
	acquirePaneOwnership,
	assertReuseAllowed,
	childKeyFor,
	PaneOwnershipError,
	paneNameForChild,
	paneNameForReuse,
	readPaneOwner,
	sanitizeAgentName,
} from "../../src/runs/shared/tmux-pane/pane-identity.ts";
import { ClaudePane, delay, type PaneMeta } from "../../src/runs/shared/tmux-pane/pane.ts";
import { buildClaudeCommand, resolvePaneName } from "../../src/runs/shared/tmux-pane/spawn.ts";
import type { Tmux } from "../../src/runs/shared/tmux-pane/tmux.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

class FakeTmux {
	paneAlive = true;
	pasted: string[] = [];
	keys: string[] = [];
	captureText = "";
	killed = false;

	async paneExists(): Promise<boolean> {
		return this.paneAlive;
	}

	async pasteFile(_paneId: string, _buffer: string, file: string): Promise<void> {
		this.pasted.push(fs.readFileSync(file, "utf-8"));
	}

	async sendKey(_paneId: string, key: string): Promise<void> {
		this.keys.push(key);
	}

	async capture(): Promise<string> {
		return this.captureText;
	}

	async killPane(): Promise<void> {
		this.killed = true;
	}
}

function makeMeta(stateDir: string, overrides: Partial<PaneMeta> = {}): PaneMeta {
	return {
		runId: "run-abc",
		stepIndex: 0,
		childIndex: 0,
		agent: "implementer",
		paneName: "pi-run-abc-s0-c0-implementer",
		paneId: "%42",
		claudeSessionId: "session-1",
		cwd: "/tmp/work",
		stateDir,
		createdAt: Date.now(),
		...overrides,
	};
}

function makePane(stateDir: string, tmux: FakeTmux, overrides: Partial<PaneMeta> = {}): ClaudePane {
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(stateDir, "events.jsonl"), "");
	const pane = new ClaudePane(makeMeta(stateDir, overrides), tmux as unknown as Tmux, { pasteSettleMs: 0 });
	pane.attach();
	return pane;
}

/**
 * Drive the event tail faster than its 200ms production interval.
 *
 * Deliberately not tighter than this: unit test files run concurrently, and a
 * swarm of few-millisecond timers here degrades timing-sensitive suites
 * elsewhere in the run.
 */
function startTailDriver(pane: ClaudePane): () => void {
	const timer = setInterval(() => pane.tail.poll(), 20);
	timer.unref?.();
	return () => clearInterval(timer);
}

describe("tmux-pane identity", () => {
	it("generates a distinct pane name per logical child of the same agent", () => {
		const base = { runId: "run-1", stepIndex: 0, agent: "implementer" };
		const names = [0, 1, 2].map((childIndex) => paneNameForChild({ ...base, childIndex }));

		assert.deepEqual(names, [
			"pi-run-1-s0-c0-implementer",
			"pi-run-1-s0-c1-implementer",
			"pi-run-1-s0-c2-implementer",
		]);
		assert.equal(new Set(names).size, 3, "parallel children of one agent must not share a pane");
	});

	it("separates children by step as well as by child index", () => {
		const a = paneNameForChild({ runId: "r", stepIndex: 0, childIndex: 1, agent: "a" });
		const b = paneNameForChild({ runId: "r", stepIndex: 1, childIndex: 1, agent: "a" });
		assert.notEqual(a, b);
	});

	it("sanitizes agent names and rejects names with no usable characters", () => {
		assert.equal(sanitizeAgentName("Claude Implementer!"), "claude-implementer");
		assert.throws(() => sanitizeAgentName("///"), /Invalid agent name/);
	});

	it("keys reuse panes by agent alone", () => {
		assert.equal(paneNameForReuse("Implementer"), "pi-reuse-implementer");
		assert.equal(resolvePaneName({ runId: "r", stepIndex: 0, childIndex: 3, agent: "impl" }, true), "pi-reuse-impl");
	});

	it("builds a child key from step and child index", () => {
		assert.equal(childKeyFor({ stepIndex: 2, childIndex: 5 }), "s2-c5");
	});

	it("refuses reuse for parallel or worktree children, allows it otherwise", () => {
		assert.throws(
			() => assertReuseAllowed({ agent: "a", parallel: true, worktree: false }),
			/parallel group/,
		);
		assert.throws(
			() => assertReuseAllowed({ agent: "a", parallel: false, worktree: true }),
			/isolated worktree/,
		);
		assert.doesNotThrow(() => assertReuseAllowed({ agent: "a", parallel: false, worktree: false }));
	});
});

describe("tmux-pane ownership lock", () => {
	it("refuses a second owner while the first process is alive", () => {
		const dir = createTempDir();
		try {
			const stateDir = path.join(dir, "pane");
			const release = acquirePaneOwnership(stateDir, {
				pid: process.pid,
				runId: "run-1",
				stepIndex: 0,
				childIndex: 0,
				acquiredAt: Date.now(),
			});

			// A different, definitely-live pid: pid 1 always exists.
			assert.throws(
				() =>
					acquirePaneOwnership(stateDir, {
						pid: 1,
						runId: "run-2",
						stepIndex: 0,
						childIndex: 1,
						acquiredAt: Date.now(),
					}),
				PaneOwnershipError,
			);

			release();
			assert.equal(readPaneOwner(stateDir), undefined);
		} finally {
			removeTempDir(dir);
		}
	});

	it("reclaims a lock whose owning process is gone", () => {
		const dir = createTempDir();
		try {
			const stateDir = path.join(dir, "pane");
			fs.mkdirSync(stateDir, { recursive: true });
			// A pid that cannot be running: max pid + sentinel.
			fs.writeFileSync(
				path.join(stateDir, "owner.json"),
				JSON.stringify({ pid: 2 ** 31 - 1, runId: "old", stepIndex: 0, childIndex: 0, acquiredAt: 0 }),
			);

			const release = acquirePaneOwnership(stateDir, {
				pid: process.pid,
				runId: "run-new",
				stepIndex: 0,
				childIndex: 0,
				acquiredAt: Date.now(),
			});

			assert.equal(readPaneOwner(stateDir)?.runId, "run-new");
			release();
		} finally {
			removeTempDir(dir);
		}
	});

	it("does not release a lock held by a different pid", () => {
		const dir = createTempDir();
		try {
			const stateDir = path.join(dir, "pane");
			const release = acquirePaneOwnership(stateDir, {
				pid: process.pid,
				runId: "run-1",
				stepIndex: 0,
				childIndex: 0,
				acquiredAt: Date.now(),
			});
			// Simulate the lock changing hands before our release runs.
			fs.writeFileSync(
				path.join(stateDir, "owner.json"),
				JSON.stringify({ pid: 1, runId: "other", stepIndex: 0, childIndex: 0, acquiredAt: Date.now() }),
			);
			release();
			assert.equal(readPaneOwner(stateDir)?.runId, "other");
		} finally {
			removeTempDir(dir);
		}
	});
});

describe("tmux-pane hook config", () => {
	it("writes a .cjs hook so a type:module project cannot break require()", () => {
		const dir = createTempDir();
		try {
			const settingsPath = writeHookConfig(dir, { nodePath: "/usr/bin/node", progress: true });
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
				hooks: Record<string, { hooks: { command: string }[] }[]>;
			};

			assert.ok(fs.existsSync(path.join(dir, "hook.cjs")), "hook must be .cjs");
			assert.ok(!fs.existsSync(path.join(dir, "hook.js")));
			const command = settings.hooks.Stop?.[0]?.hooks?.[0]?.command ?? "";
			assert.match(command, /hook\.cjs/);
			assert.ok(fs.existsSync(path.join(dir, "events.jsonl")));
			for (const name of ["UserPromptSubmit", "Stop", "Notification", "PreToolUse", "SessionEnd"]) {
				assert.ok(settings.hooks[name], `missing hook ${name}`);
			}
		} finally {
			removeTempDir(dir);
		}
	});

	it("omits the PreToolUse hook when progress is off", () => {
		const dir = createTempDir();
		try {
			const settingsPath = writeHookConfig(dir, { nodePath: "/usr/bin/node", progress: false });
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { hooks: Record<string, unknown> };
			assert.equal(settings.hooks.PreToolUse, undefined);
			assert.ok(settings.hooks.Stop);
		} finally {
			removeTempDir(dir);
		}
	});
});

describe("tmux-pane event tail", () => {
	it("delivers appended events and resumes from the byte offset", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "events.jsonl"), "");
			const tail = new EventTail(dir);
			const seen: string[] = [];
			tail.subscribe((event) => seen.push(event.hook_event_name));

			appendLocalEvent(dir, { hook_event_name: "UserPromptSubmit" });
			tail.poll();
			appendLocalEvent(dir, { hook_event_name: "Stop" });
			tail.poll();
			// A second poll with no new bytes must not replay.
			tail.poll();

			assert.deepEqual(seen, ["UserPromptSubmit", "Stop"]);
		} finally {
			removeTempDir(dir);
		}
	});

	it("skips pre-existing events after seekToEnd", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "events.jsonl"), "");
			appendLocalEvent(dir, { hook_event_name: "Stop" });
			const tail = new EventTail(dir);
			tail.seekToEnd();
			const seen: string[] = [];
			tail.subscribe((event) => seen.push(event.hook_event_name));
			tail.poll();
			assert.deepEqual(seen, []);

			appendLocalEvent(dir, { hook_event_name: "Notification" });
			tail.poll();
			assert.deepEqual(seen, ["Notification"]);
		} finally {
			removeTempDir(dir);
		}
	});
});

describe("tmux-pane turn state machine", () => {
	it("delivers the task by bracketed paste then Enter, never as raw keys", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const pane = makePane(path.join(dir, "state"), tmux);
		try {
			await pane.send("line one\nline two");
			assert.deepEqual(tmux.pasted, ["line one\nline two"]);
			assert.deepEqual(tmux.keys, ["Enter"]);
		} finally {
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("completes on Stop and takes the deliverable from last_assistant_message", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const stateDir = path.join(dir, "state");
		const pane = makePane(stateDir, tmux);
		const stopDriver = startTailDriver(pane);
		try {
			const turn = await pane.send("do the thing");
			appendLocalEvent(stateDir, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" });
			appendLocalEvent(stateDir, { hook_event_name: "PreToolUse", tool_name: "Bash", prompt_id: "p1" });
			appendLocalEvent(stateDir, {
				hook_event_name: "Stop",
				prompt_id: "p1",
				last_assistant_message: "the deliverable",
			});

			const finished = await pane.awaitTurn(turn, { timeoutMs: 3_000, submitTimeoutMs: 2_000, tickMs: 25 });
			assert.equal(finished.status, "completed");
			assert.equal(finished.text, "the deliverable");
			assert.deepEqual(finished.tools, ["Bash"]);
		} finally {
			stopDriver();
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("ignores a Stop belonging to a different prompt", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const stateDir = path.join(dir, "state");
		const pane = makePane(stateDir, tmux);
		const stopDriver = startTailDriver(pane);
		try {
			const turn = await pane.send("task");
			appendLocalEvent(stateDir, { hook_event_name: "UserPromptSubmit", prompt_id: "mine" });
			appendLocalEvent(stateDir, { hook_event_name: "Stop", prompt_id: "someone-else", last_assistant_message: "no" });
			await delay(60);
			assert.equal(turn.status, "running");

			appendLocalEvent(stateDir, { hook_event_name: "Stop", prompt_id: "mine", last_assistant_message: "yes" });
			const finished = await pane.awaitTurn(turn, { timeoutMs: 3_000, submitTimeoutMs: 2_000, tickMs: 25 });
			assert.equal(finished.text, "yes");
		} finally {
			stopDriver();
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("marks a turn superseded when a human submits another prompt mid-turn", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const stateDir = path.join(dir, "state");
		const pane = makePane(stateDir, tmux);
		const stopDriver = startTailDriver(pane);
		try {
			const turn = await pane.send("task");
			appendLocalEvent(stateDir, { hook_event_name: "UserPromptSubmit", prompt_id: "mine" });
			appendLocalEvent(stateDir, { hook_event_name: "UserPromptSubmit", prompt_id: "human" });

			const finished = await pane.awaitTurn(turn, { timeoutMs: 3_000, submitTimeoutMs: 2_000, tickMs: 25 });
			assert.equal(finished.status, "superseded");
			assert.match(finished.note ?? "", /another prompt/);
		} finally {
			stopDriver();
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("fails a turn when Claude exits, rather than treating a missing Stop as success", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const stateDir = path.join(dir, "state");
		const pane = makePane(stateDir, tmux);
		const stopDriver = startTailDriver(pane);
		try {
			const turn = await pane.send("task");
			appendLocalEvent(stateDir, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" });
			appendLocalEvent(stateDir, { hook_event_name: "SessionEnd", reason: "user exited" });

			const finished = await pane.awaitTurn(turn, { timeoutMs: 3_000, submitTimeoutMs: 2_000, tickMs: 25 });
			assert.equal(finished.status, "session_ended");
			assert.equal(finished.text, undefined);
			assert.equal(pane.ended, true);
		} finally {
			stopDriver();
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("reports submit_failed when no UserPromptSubmit ever arrives", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const pane = makePane(path.join(dir, "state"), tmux);
		try {
			const turn = await pane.send("task");
			const finished = await pane.awaitTurn(turn, { timeoutMs: 5_000, submitTimeoutMs: 40, tickMs: 25 });
			assert.equal(finished.status, "submit_failed");
		} finally {
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("resolves as interrupted on abort, leaving the pane alive for resume", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const stateDir = path.join(dir, "state");
		const pane = makePane(stateDir, tmux);
		try {
			const turn = await pane.send("task");
			appendLocalEvent(stateDir, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" });
			pane.tail.poll();

			const controller = new AbortController();
			const pending = pane.awaitTurn(turn, {
				timeoutMs: 5_000,
				submitTimeoutMs: 2_000,
				tickMs: 25,
				signal: controller.signal,
			});
			controller.abort();
			const finished = await pending;

			assert.equal(finished.status, "interrupted");
			assert.ok(tmux.keys.includes("Escape"), "interrupt must send Escape, not kill the pane");
			assert.equal(tmux.killed, false);
		} finally {
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("excludes blocked time from the turn deadline", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const stateDir = path.join(dir, "state");
		const pane = makePane(stateDir, tmux);
		const stopDriver = startTailDriver(pane);
		try {
			const turn = await pane.send("task");
			appendLocalEvent(stateDir, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" });
			appendLocalEvent(stateDir, { hook_event_name: "Notification", message: "needs permission for Bash" });

			const pending = pane.awaitTurn(turn, { timeoutMs: 120, submitTimeoutMs: 5_000, tickMs: 25 });

			// Stay blocked well past the deadline; the clock must be paused.
			await delay(180);
			assert.equal(turn.status, "running", "a permission prompt must not consume the deadline");

			// Unblock: the accumulated blocked span is banked and the clock resumes.
			appendLocalEvent(stateDir, { hook_event_name: "PreToolUse", tool_name: "Bash", prompt_id: "p1" });
			const finished = await pending;

			assert.equal(finished.status, "timeout");
			assert.ok(
				finished.blockedDurationMs >= 120,
				`expected the blocked span to be banked, got ${finished.blockedDurationMs}ms`,
			);
		} finally {
			stopDriver();
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("subtracts banked blocked time from effective elapsed", () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		const pane = makePane(path.join(dir, "state"), tmux);
		try {
			const now = Date.now();
			const turn = {
				id: "t1",
				status: "running" as const,
				prompt: "p",
				sentAt: now - 1_000,
				tools: [],
				blockedDurationMs: 800,
			};
			assert.equal(pane.effectiveElapsedMs(turn, now), 200);
		} finally {
			pane.detach();
			removeTempDir(dir);
		}
	});

	it("surfaces the workspace trust dialog as a specific error", async () => {
		const dir = createTempDir();
		const tmux = new FakeTmux();
		tmux.captureText = "Quick safety check: Is this a project you created or one you trust?";
		const pane = makePane(path.join(dir, "state"), tmux);
		try {
			await assert.rejects(() => pane.waitForPrompt({ timeoutMs: 500 }), /trust dialog/i);
		} finally {
			pane.detach();
			removeTempDir(dir);
		}
	});
});

describe("tmux-pane claude command", () => {
	it("pre-assigns a session id and points Claude at the generated hook settings", () => {
		const command = buildClaudeCommand({
			identity: { runId: "r", stepIndex: 0, childIndex: 0, agent: "impl" },
			cwd: "/w",
			stateRoot: "/s",
			claudeBin: "claude",
			nodeBin: "node",
			settingsPath: "/s/settings.json",
			claudeSessionId: "sess-1",
			paneName: "pi-r-s0-c0-impl",
			model: "opus",
			permissionMode: "acceptEdits",
			allowedTools: ["Edit"],
			addDirs: ["/extra"],
			extraArgs: ["--verbose"],
		});

		assert.deepEqual(command, [
			"claude",
			"--session-id",
			"sess-1",
			"--settings",
			"/s/settings.json",
			"-n",
			"pi-r-s0-c0-impl",
			"--permission-mode",
			"acceptEdits",
			"--model",
			"opus",
			"--allowedTools",
			"Edit",
			"--add-dir",
			"/extra",
			"--verbose",
		]);
		assert.ok(!command.includes("-p"), "print mode is unavailable on a subscription and must never be used");
	});
});
