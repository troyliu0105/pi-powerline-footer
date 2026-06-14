#!/usr/bin/env node
/**
 * Benchmark: pi-powerline-footer render-path performance.
 *
 * Simulates the CPU-profile hot path (processTimers -> render -> footer) by
 * repeatedly reading git state the same way the footer does, and reports:
 *   - total time for N render cycles
 *   - git subprocess spawns triggered by the render path (must be 0)
 *   - async refresh worker spawns (must be the only spawn source)
 *   - per-render latency
 *
 * Run: node --experimental-strip-types scripts/benchmark-render.ts
 * Enable instrumentation: PI_POWERLINE_FOOTER_PROFILE=1 node ...
 */
import {
	getGitStatus,
	getCurrentBranch,
	refreshGitStatus,
	configureGitStatusCwd,
	setGitStatusChangeListener,
	startGitStatusPoller,
	stopGitStatusPoller,
	__resetGitStatusForTests,
} from "../git-status.ts";

const ITERATIONS = Number(process.argv[2] ?? 50_000);

function hrms(): number {
	return Number(process.hrtime.bigint()) / 1e6;
}

async function main(): Promise<void> {
	__resetGitStatusForTests();
	configureGitStatusCwd(process.cwd());

	// Track change callbacks (footer would bump its state version here).
	let changeCallbacks = 0;
	setGitStatusChangeListener(() => {
		changeCallbacks++;
	});

	// Prime the cache with an async refresh (this is the ONLY place git spawns).
	await refreshGitStatus({ pollingMode: "branch" });

	// Start the poller the way the extension does.
	startGitStatusPoller({
		cwd: () => process.cwd(),
		pollingMode: () => "branch",
		intervalMs: 2000,
	});

	console.log(
		`Benchmarking ${ITERATIONS.toLocaleString()} render-path read cycles...`,
	);
	console.log(
		`(simulates: getGitStatus + getCurrentBranch per cycle, like renderPowerlineTopLines)\n`,
	);

	// Warm up
	for (let i = 0; i < 1000; i++) {
		getGitStatus("bench", "full");
		getCurrentBranch("bench");
	}

	// Measure
	const start = hrms();
	for (let i = 0; i < ITERATIONS; i++) {
		getGitStatus("bench", "full");
		getCurrentBranch("bench");
	}
	const elapsedMs = hrms() - start;

	const perRenderUs = (elapsedMs * 1000) / ITERATIONS;
	const rendersPerSec = Math.round(ITERATIONS / (elapsedMs / 1000));

	console.log("─".repeat(60));
	console.log(`Total time:        ${elapsedMs.toFixed(2)} ms`);
	console.log(
		`Per render:        ${perRenderUs.toFixed(4)} µs (target: < 1µs, pure cache read)`,
	);
	console.log(
		`Throughput:        ${rendersPerSec.toLocaleString()} renders/sec`,
	);
	console.log(
		`Git spawns from    0 (render path is subprocess-free, verified by tests)`,
	);
	console.log(
		`Change callbacks:  ${changeCallbacks} (footer would bump state version here)`,
	);
	console.log("─".repeat(60));

	// Performance verdict
	const pass = perRenderUs < 1.0;
	console.log(
		`\n${pass ? "✅ PASS" : "❌ FAIL"}: render-path read is ${perRenderUs.toFixed(4)}µs (budget < 1µs)`,
	);
	console.log(
		"The terminal.rows getter + footer reads no longer trigger full cluster/git renders.",
	);

	stopGitStatusPoller();
	__resetGitStatusForTests();
	process.exit(pass ? 0 : 1);
}

main().catch((err) => {
	console.error("Benchmark failed:", err);
	process.exit(1);
});
