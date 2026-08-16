/**
 * Pane identity and cross-process ownership.
 *
 * This is the deliberate departure from the `claude-tmux` extension this runner
 * is ported from. That extension keys panes by agent name and reuses a live
 * pane so successive tasks keep context, which is right for an interactive
 * assistant driven by a human.
 *
 * It is wrong for `runs.all` fan-out. Two parallel children of the same agent
 * would resolve to one pane name, and the second delegation would either be
 * refused as "still working on a turn" or interleave two turns into a single
 * Claude conversation - with both children editing different worktrees through
 * one context. Pane names are therefore keyed per logical child, and reuse by
 * agent name is opt-in only.
 *
 * Ownership cannot live in memory either: async runs execute in a detached node
 * process that cannot see the parent's state. The registry is tmux user options
 * plus an `owner.json` lock in the state dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const OWNER_FILE = "owner.json";

/** Identifies one logical child of one run. */
export interface ChildIdentity {
	runId: string;
	stepIndex: number;
	childIndex: number;
	agent: string;
}

export interface PaneOwner {
	pid: number;
	runId: string;
	stepIndex: number;
	childIndex: number;
	acquiredAt: number;
}

export class PaneOwnershipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PaneOwnershipError";
	}
}

/** Lowercase, collapse anything outside [a-z0-9_-] to a single dash, trim dashes. */
export function sanitizeNameSegment(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function sanitizeAgentName(name: string): string {
	const clean = sanitizeNameSegment(name);
	if (!clean) throw new Error(`Invalid agent name: ${JSON.stringify(name)}`);
	return clean;
}

/** Stable key for a child within its run, e.g. `s0-c2`. */
export function childKeyFor(identity: Pick<ChildIdentity, "stepIndex" | "childIndex">): string {
	return `s${identity.stepIndex}-c${identity.childIndex}`;
}

/**
 * Pane name unique per logical child.
 *
 * `pi-<runId>-s<stepIndex>-c<childIndex>-<agent>`. Uniqueness across children
 * is what makes parallel fan-out safe; do not weaken it.
 */
export function paneNameForChild(identity: ChildIdentity): string {
	const runId = sanitizeNameSegment(identity.runId) || "run";
	const agent = sanitizeAgentName(identity.agent);
	return `pi-${runId}-${childKeyFor(identity)}-${agent}`;
}

/**
 * Pane name for opt-in `reuse: true`, keyed by agent alone so context carries
 * across runs. Only valid for a lone child with no worktree - see
 * `assertReuseAllowed`.
 */
export function paneNameForReuse(agent: string): string {
	return `pi-reuse-${sanitizeAgentName(agent)}`;
}

/**
 * Reuse shares one Claude conversation across delegations. That is incoherent
 * when children run concurrently (interleaved turns) or in separate worktrees
 * (one context, several working trees), so both are refused rather than
 * silently producing cross-talk.
 */
export function assertReuseAllowed(options: { agent: string; parallel: boolean; worktree: boolean }): void {
	const reasons: string[] = [];
	if (options.parallel) reasons.push("the child is part of a parallel group");
	if (options.worktree) reasons.push("the child uses an isolated worktree");
	if (reasons.length === 0) return;
	throw new Error(
		`Agent '${options.agent}' sets runner.reuse=true, which is not supported when ${reasons.join(" and ")}. ` +
			`Reuse shares a single Claude conversation, so concurrent or differently-rooted children would interleave in one context.`,
	);
}

function isEexist(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

/** Whether a pid is still running. EPERM means alive but owned by another user. */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM";
	}
}

export function readPaneOwner(stateDir: string): PaneOwner | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, OWNER_FILE), "utf-8")) as PaneOwner;
		return typeof parsed?.pid === "number" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Take exclusive ownership of a pane's state dir, returning a release function.
 *
 * Uses an exclusive create (`wx`) so two processes cannot both believe they own
 * the pane. A lock whose owning process is gone is stale and is reclaimed; a
 * lock held by a live process is an error, never a silent takeover.
 */
export function acquirePaneOwnership(stateDir: string, owner: PaneOwner): () => void {
	fs.mkdirSync(stateDir, { recursive: true });
	const file = path.join(stateDir, OWNER_FILE);
	const payload = JSON.stringify(owner, null, 2);

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(file, "wx", 0o600);
			try {
				fs.writeFileSync(fd, payload);
			} finally {
				fs.closeSync(fd);
			}
			return () => releasePaneOwnership(stateDir, owner.pid);
		} catch (error) {
			if (!isEexist(error)) throw error;
			const existing = readPaneOwner(stateDir);
			if (existing && existing.pid !== owner.pid && isProcessAlive(existing.pid)) {
				throw new PaneOwnershipError(
					`Pane state dir ${stateDir} is already owned by pid ${existing.pid} ` +
						`(run ${existing.runId}, ${childKeyFor(existing)}). Two processes must never drive one pane.`,
				);
			}
			// Stale lock, or a re-acquire by this same process. Clear and retry once.
			try {
				fs.unlinkSync(file);
			} catch {
				// Lost the race to another reclaimer; the retry will surface it.
			}
		}
	}

	throw new PaneOwnershipError(`Could not acquire ownership of pane state dir ${stateDir}.`);
}

/** Release ownership, but only if this pid still holds it. */
export function releasePaneOwnership(stateDir: string, pid: number): void {
	const existing = readPaneOwner(stateDir);
	if (existing && existing.pid !== pid) return;
	try {
		fs.unlinkSync(path.join(stateDir, OWNER_FILE));
	} catch {
		// Already released.
	}
}
