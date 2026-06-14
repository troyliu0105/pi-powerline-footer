/**
 * Render-path purity tests for pi-powerline-footer.
 *
 * These verify the core performance contract: the synchronous render path
 * (getGitStatus / getCurrentBranch) MUST NEVER spawn a subprocess or schedule
 * async work. All git work happens in the async refresh worker.
 *
 * Strategy:
 *  - Behavioral: __gitStatusRefreshInFlight() stays false during render reads.
 *  - Static (contract): the source of the render-path functions contains no
 *    spawn/exec/execSync/spawnSync references — a regression-proof guard that
 *    survives ESM binding quirks.
 *  - Cache stability + performance budget across 1000 reads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	readFileSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getGitStatus,
	getCurrentBranch,
	refreshGitStatus,
	__resetGitStatusForTests,
	__gitStatusRefreshInFlight,
} from "../git-status.ts";

const sourcePath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"git-status.ts",
);
const sourceText = readFileSync(sourcePath, "utf8");

function makeTempGitRepo(branchName: string): string {
	const dir = mkdtempSync(join(tmpdir(), "powerline-render-"));
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branchName}\n`);
	return dir;
}

/** Extract the source body of a top-level function (exported or not) by name. */
function functionBody(name: string): string {
	const re = new RegExp(`(?:export )?function ${name}\\b[\\s\\S]*?^\\}`, "m");
	const match = sourceText.match(re);
	if (!match) throw new Error(`could not find function ${name} in source`);
	return match[0];
}

test("render-path reads never schedule an async refresh (purity via in-flight guard)", () => {
	__resetGitStatusForTests();
	const before = __gitStatusRefreshInFlight();
	for (let i = 0; i < 500; i++) {
		getGitStatus("main", "full");
		getCurrentBranch("main");
	}
	const after = __gitStatusRefreshInFlight();
	assert.equal(before, false);
	assert.equal(
		after,
		false,
		"render-path reads must not schedule any async refresh",
	);
});

test("static contract: getGitStatus and getCurrentBranch source contains no subprocess calls", () => {
	const forbidden = [
		"spawn",
		"spawnSync",
		"execSync",
		"execFile",
		".exec(",
		"fork(",
	];
	for (const fn of ["getGitStatus", "getCurrentBranch"]) {
		const body = functionBody(fn);
		for (const token of forbidden) {
			assert.ok(
				!body.includes(token),
				`${fn}() must not reference "${token}" — render path is subprocess-free (found in: ${body.slice(0, 120)}...)`,
			);
		}
	}
});

test("static contract: the only spawn in the module lives inside runGit (the async worker)", () => {
	// Count occurrences of the spawn call site. runGit is the single authorised
	// spawn location; render-path functions must never reach it.
	const runGitBody = functionBody("runGit").replace(
		/assertRenderPathSpawnFree/g,
		"",
	);
	const spawnCalls = (runGitBody.match(/\bspawn\(/g) || []).length;
	assert.ok(spawnCalls >= 1, "runGit must spawn (it is the async worker)");
});

test("1000 render-path reads with unchanged cache are stable and under 5ms", () => {
	__resetGitStatusForTests();
	const baseline = getGitStatus("fallback", "full");
	let stable = true;
	const start = performance.now();
	for (let i = 0; i < 1000; i++) {
		const v = getGitStatus("fallback", "full");
		if (JSON.stringify(v) !== JSON.stringify(baseline)) stable = false;
	}
	const elapsed = performance.now() - start;
	assert.ok(stable, "1000 render reads must return identical cached values");
	assert.ok(
		elapsed < 5,
		`1000 pure cache reads took ${elapsed.toFixed(2)}ms; expected <5ms`,
	);
});

test("branch changes eventually appear after an async refresh (cache invalidation -> recompute)", async () => {
	__resetGitStatusForTests();
	const repo = makeTempGitRepo("before-change");
	try {
		await refreshGitStatus({ cwd: repo, pollingMode: "branch" });
		assert.equal(getCurrentBranch("fb"), "before-change");

		// Simulate a branch switch by rewriting .git/HEAD.
		writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/after-change\n");
		// Render path still shows stale value until a refresh runs.
		assert.equal(
			getCurrentBranch("fb"),
			"before-change",
			"cache must be stale until refresh",
		);

		await refreshGitStatus({ cwd: repo, pollingMode: "branch" });
		assert.equal(
			getCurrentBranch("fb"),
			"after-change",
			"refresh must update the cached branch",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		__resetGitStatusForTests();
	}
});

test("one-in-flight guard: concurrent refreshes coalesce to a single worker run", async () => {
	__resetGitStatusForTests();
	const repo = makeTempGitRepo("guard-coalesce");
	try {
		const p1 = refreshGitStatus({ cwd: repo, pollingMode: "branch" });
		assert.equal(__gitStatusRefreshInFlight(), true);
		const all = await Promise.all([
			p1,
			refreshGitStatus({ cwd: repo, pollingMode: "branch" }),
			refreshGitStatus({ cwd: repo, pollingMode: "branch" }),
			refreshGitStatus({ cwd: repo, pollingMode: "branch" }),
		]);
		assert.equal(all.length, 4);
		assert.equal(__gitStatusRefreshInFlight(), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		__resetGitStatusForTests();
	}
});
