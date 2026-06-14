import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGitStatus,
  getCurrentBranch,
  refreshGitStatus,
  startGitStatusPoller,
  stopGitStatusPoller,
  setGitStatusChangeListener,
  configureGitStatusCwd,
  invalidateGitStatus,
  invalidateGitBranch,
  __resetGitStatusForTests,
  __gitStatusRefreshInFlight,
  __readBranchFromGitHead,
} from "../git-status.ts";

function makeTempGitRepo(branchName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "powerline-git-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branchName}\n`);
  return dir;
}

test("getGitStatus supports disabling extension git polling (off mode returns zeros)", () => {
  __resetGitStatusForTests();
  assert.deepEqual(getGitStatus("main", "off"), {
    branch: "main",
    staged: 0,
    unstaged: 0,
    untracked: 0,
  });
});

test("getGitStatus is a pure render-path read: repeated calls never spawn or schedule", async () => {
  __resetGitStatusForTests();
  // No poller running, no refresh triggered. getGitStatus must return a stable
  // value derived ONLY from the cache (empty here) + provider branch, with zero
  // side effects and no in-flight refresh created.
  const before = __gitStatusRefreshInFlight();
  const a = getGitStatus("dev", "full");
  const b = getGitStatus("dev", "full");
  const after = __gitStatusRefreshInFlight();
  assert.equal(before, false);
  assert.equal(after, false, "getGitStatus must not schedule any async refresh");
  assert.deepEqual(a, b);
  assert.equal(a.branch, "dev");
});

test("readBranchFromGitHead reads branch name directly from .git/HEAD (no subprocess)", () => {
  const repo = makeTempGitRepo("feature/perf-fix");
  try {
    assert.equal(__readBranchFromGitHead(repo), "feature/perf-fix");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("readBranchFromGitHead handles detached HEAD sha", () => {
  const dir = mkdtempSync(join(tmpdir(), "powerline-detached-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    const branch = __readBranchFromGitHead(dir);
    assert.ok(branch?.includes("detached"), `expected detached marker, got ${branch}`);
    assert.ok(branch?.startsWith("0123456"), `expected short sha prefix, got ${branch}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBranchFromGitHead returns null outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "powerline-nogit-"));
  try {
    assert.equal(__readBranchFromGitHead(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshGitStatus populates branch cache from .git/HEAD so render reads see it", async () => {
  __resetGitStatusForTests();
  const repo = makeTempGitRepo("render-safe-branch");
  configureGitStatusCwd(repo);
  try {
    // Before refresh, render read falls back to provider branch.
    assert.equal(getCurrentBranch("provider-fallback"), "provider-fallback");
    await refreshGitStatus({ cwd: repo, pollingMode: "branch" });
    // After async refresh, render read returns the real branch from cache.
    assert.equal(getCurrentBranch("provider-fallback"), "render-safe-branch");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    __resetGitStatusForTests();
  }
});

test("one-in-flight guard: concurrent refreshes do not spawn overlapping work", async () => {
  __resetGitStatusForTests();
  const repo = makeTempGitRepo("guard-test");
  configureGitStatusCwd(repo);
  try {
    const p1 = refreshGitStatus({ cwd: repo, pollingMode: "branch" });
    assert.equal(__gitStatusRefreshInFlight(), true, "first refresh should be in flight");
    const p2 = refreshGitStatus({ cwd: repo, pollingMode: "branch" });
    const p3 = refreshGitStatus({ cwd: repo, pollingMode: "branch" });
    await Promise.all([p1, p2, p3]);
    assert.equal(__gitStatusRefreshInFlight(), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    __resetGitStatusForTests();
  }
});

test("on-change listener fires when the cached branch value changes after refresh", async () => {
  __resetGitStatusForTests();
  let changeCalls = 0;
  setGitStatusChangeListener(() => {
    changeCalls++;
  });
  const repo = makeTempGitRepo("change-detect");
  configureGitStatusCwd(repo);
  try {
    await refreshGitStatus({ cwd: repo, pollingMode: "branch" });
    assert.ok(changeCalls >= 1, "listener should fire when branch cache populates from null -> value");
    // Second refresh with the same branch should NOT fire the listener.
    const callsBefore = changeCalls;
    await refreshGitStatus({ cwd: repo, pollingMode: "branch" });
    assert.equal(changeCalls, callsBefore, "listener must NOT fire when value is unchanged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    __resetGitStatusForTests();
  }
});

test("poller primes and refreshes on interval, then stops cleanly", async () => {
  __resetGitStatusForTests();
  const repo = makeTempGitRepo("poller-branch");
  let changeCount = 0;
  setGitStatusChangeListener(() => {
    changeCount++;
  });
  try {
    const handle = startGitStatusPoller({
      cwd: () => repo,
      pollingMode: () => "branch",
      intervalMs: 20,
    });
    // Prime call is synchronous-ish; await a microtask flush.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(getCurrentBranch(null), "poller-branch");
    assert.ok(changeCount >= 1, "poller prime should trigger the change listener");
    handle.stop();
    stopGitStatusPoller();
  } finally {
    rmSync(repo, { recursive: true, force: true });
    __resetGitStatusForTests();
  }
});

test("invalidateGitStatus / invalidateGitBranch clear caches", async () => {
  __resetGitStatusForTests();
  const repo = makeTempGitRepo("invalidate-test");
  configureGitStatusCwd(repo);
  try {
    await refreshGitStatus({ cwd: repo, pollingMode: "full" });
    assert.equal(getCurrentBranch("fb"), "invalidate-test");

    // invalidateGitBranch: render read falls back to provider branch.
    invalidateGitBranch();
    assert.equal(getCurrentBranch("fb"), "fb", "invalidateGitBranch should fall back to provider branch");

    // invalidateGitStatus: clears the dirty-status cache so the next refresh
    // repopulates it. Render reads stay pure (return zeros until refresh).
    invalidateGitStatus();
    const afterInvalidate = getGitStatus("fallback", "full");
    assert.equal(afterInvalidate.staged, 0, "invalidateGitStatus should clear dirty counts to zero");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    __resetGitStatusForTests();
  }
});
