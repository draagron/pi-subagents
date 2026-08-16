import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	capabilityCeilingUnenforceableRunnerMessage,
	SUBAGENT_CAPABILITY_CEILING_VERSION,
	type ResolvedSubagentCapabilityCeiling,
} from "../../src/runs/shared/capability-ceiling.ts";
import { isNonPiRunnerType } from "../../src/shared/types.ts";

function makeCeiling(sources: string[] = ["test-harness"]): ResolvedSubagentCapabilityCeiling {
	return { version: SUBAGENT_CAPABILITY_CEILING_VERSION, allowedTools: ["Read"], denyExtensions: true, sources };
}

const ceiling = makeCeiling();

describe("capability ceiling on runners Pi cannot constrain", () => {
	it("refuses a tmux-pane launch while a ceiling is active", () => {
		const message = capabilityCeilingUnenforceableRunnerMessage("claude-implementer", "tmux-pane", ceiling);
		assert.ok(message, "an active ceiling must refuse a runner it cannot constrain");
		assert.match(message, /runner\.type='tmux-pane'/);
		assert.match(message, /enforced by the child application, not by Pi/);
	});

	it("allows a tmux-pane launch when no ceiling is active", () => {
		assert.equal(capabilityCeilingUnenforceableRunnerMessage("claude-implementer", "tmux-pane", undefined), undefined);
	});

	it("leaves Pi-enforceable runners alone", () => {
		// Pi builds these children's tool sets, so the ceiling is genuinely enforced.
		assert.equal(capabilityCeilingUnenforceableRunnerMessage("a", "pi", ceiling), undefined);
		assert.equal(capabilityCeilingUnenforceableRunnerMessage("a", "external-cli", ceiling), undefined);
		assert.equal(capabilityCeilingUnenforceableRunnerMessage("a", undefined, ceiling), undefined);
	});

	it("names the ceiling's sources so the refusal is actionable", () => {
		const sourced = makeCeiling(["session-policy", "parent-run"]);
		const message = capabilityCeilingUnenforceableRunnerMessage("a", "tmux-pane", sourced) ?? "";
		assert.match(message, /session-policy, parent-run/);
	});
});

describe("isNonPiRunnerType", () => {
	it("classifies every runner that is not a Pi child", () => {
		assert.equal(isNonPiRunnerType("external-cli"), true);
		assert.equal(isNonPiRunnerType("external-job"), true);
		assert.equal(isNonPiRunnerType("tmux-pane"), true);
		assert.equal(isNonPiRunnerType("pi"), false);
		assert.equal(isNonPiRunnerType(undefined), false);
	});
});
