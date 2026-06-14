/**
 * Cached git status provider for pi-powerline-footer.
 *
 * PERFORMANCE CONTRACT
 * --------------------
 * The synchronous TUI render path (`render`, `renderPowerlineTopLines`,
 * `getResponsiveLayout`, `buildSegmentContext`, the fixed-editor compositor)
 * reads git state via {@link getGitStatus} / {@link getCurrentBranch}.
 *
 * Those two functions MUST be pure cache reads:
 *   - they never spawn a subprocess,
 *   - they never schedule a background fetch,
 *   - they never perform I/O.
 *
 * All real work (reading `.git/HEAD`, running `git status --porcelain`) happens
 * exclusively in the async refresh worker ({@link refreshGitStatus}) driven by
 * {@link startGitStatusPoller}. If a refresh is already in flight, additional
 * requests reuse the previous cached value (one-in-flight guard).
 *
 * Instrumentation is guarded behind `PI_POWERLINE_FOOTER_PROFILE=1`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { GitStatus } from "./types.ts";

export type GitPollingMode = "full" | "branch" | "off";

// ─────────────────────────────────────────────────────────────────────────────
// Instrumentation (env-guarded, zero-cost when disabled)
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_ENABLED = process.env.PI_POWERLINE_FOOTER_PROFILE === "1";
const SLOW_THRESHOLD_MS = 10;

function profileMark(label: string, started: number): void {
  if (!PROFILE_ENABLED) return;
  const elapsed = Date.now() - started;
  if (elapsed >= SLOW_THRESHOLD_MS) {
    console.debug(`[powerline-footer][profile] ${label} took ${elapsed}ms`);
  }
}

/**
 * Render-path spawn guard. Call this from any function that must never spawn.
 * If instrumentation is enabled and a spawn is attempted, it logs loudly so the
 * regression is caught immediately in CPU profiles.
 */
export function assertRenderPathSpawnFree(label: string): void {
  if (!PROFILE_ENABLED) return;
  console.debug(
    `[powerline-footer][profile] WARNING: render path attempted to spawn git via ${label}; ` +
      `this is a performance regression — git work must happen in the async refresh worker only`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache state
// ─────────────────────────────────────────────────────────────────────────────

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  timestamp: number;
}

interface CachedBranch {
  branch: string | null;
  timestamp: number;
}

/**
 * TTLs (milliseconds).
 * Branch is read from `.git/HEAD` (cheap, no subprocess) so it can refresh
 * relatively quickly. Dirty status requires a `git status --porcelain`
 * subprocess and is refreshed less aggressively.
 */
export const BRANCH_TTL_MS = 5000; // 5s — within the 3–10s requirement
export const STATUS_TTL_MS = 2000; // 2s — within the 1–3s requirement

let cachedStatus: CachedGitStatus | null = null;
let cachedBranch: CachedBranch | null = null;
let pendingFetch: Promise<void> | null = null;
let invalidationCounter = 0;

/** CWD used by the refresh worker. Updated by {@link configureGitStatusCwd}. */
let refreshCwd: string | null = null;

/** Active poller handle (so we can stop it cleanly on dispose). */
interface PollerHandle {
  stop(): void;
}
let activePoller: PollerHandle | null = null;

/**
 * Callback invoked when a refresh changes the cached branch or dirty state.
 * The extension wires this to bump its footer state version + request a render.
 */
let onCacheChange: (() => void) | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Internal: spawn-backed fetch (ASYNC WORKER ONLY — never called from render)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse git status --porcelain output.
 *
 * Format: XY filename
 * X = index status, Y = working tree status, ?? = untracked.
 */
function parseGitStatusOutput(output: string): {
  staged: number;
  unstaged: number;
  untracked: number;
} {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }

  return { staged, unstaged, untracked };
}

/**
 * Spawn git asynchronously. ASYNC WORKER ONLY.
 * Times out and resolves null on failure so render never blocks.
 */
function runGit(args: string[], cwd: string | null, timeoutMs = 200): Promise<string | null> {
  assertRenderPathSpawnFree("runGit");
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      profileMark(`runGit ${args.join(" ")}`, started);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
    proc.on("error", () => finish(null));

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: `.git/HEAD` direct read (no subprocess)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk up from `startDir` looking for a `.git` entry. Supports a `.git` file
 * (gitdir pointer, used by worktrees) by resolving the referenced gitdir.
 * Returns `{ gitDir, workTree }` or null when not inside a git repository.
 */
function resolveGitDir(startDir: string): { gitDir: string; workTree: string } | null {
  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      return { gitDir: dotGit, workTree: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read the current branch directly from `.git/HEAD` — no subprocess.
 *
 * - `ref: refs/heads/<name>` => `<name>`
 * - detached HEAD (40-hex sha) => `<short> (detached)`
 * - anything else => null (caller falls back to git / provider)
 *
 * Safe in the render path (single small file read), but we still cache it behind
 * a TTL via the refresh worker so even this read is amortised.
 */
function readBranchFromGitHead(cwd: string): string | null {
  const started = Date.now();
  try {
    const resolved = resolveGitDir(cwd);
    if (!resolved) return null;

    let gitDir = resolved.gitDir;
    // Worktree/submodule: `.git` is a file pointing at the real gitdir.
    try {
      const stat = readFileSync(gitDir, "utf8").trim();
      if (stat.startsWith("gitdir:")) {
        const pointer = stat.slice("gitdir:".length).trim();
        gitDir = pointer;
      }
    } catch {
      // `.git` is a real directory — keep gitDir as-is.
    }

    const headPath = join(gitDir, "HEAD");
    const head = readFileSync(headPath, "utf8").trim();
    profileMark("readBranchFromGitHead", started);

    const refMatch = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];

    // Detached HEAD: raw object sha (40 hex) or partial.
    if (/^[0-9a-f]{4,40}$/i.test(head)) {
      return `${head.slice(0, 7)} (detached)`;
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async refresh worker (one-in-flight guard)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchGitStatusAsync(cwd: string, pollingMode: GitPollingMode): Promise<void> {
  if (pendingFetch) return; // one-in-flight guard: reuse previous cached value
  const fetchId = invalidationCounter;
  pendingFetch = (async () => {
    const started = Date.now();
    let branchChanged = false;
    let statusChanged = false;

    // Branch via .git/HEAD (no subprocess) for branch/full modes.
    if (pollingMode !== "off") {
      const branch = readBranchFromGitHead(cwd);
      if (fetchId === invalidationCounter) {
        const previous = cachedBranch?.branch ?? null;
        cachedBranch = { branch, timestamp: Date.now() };
        branchChanged = branch !== previous;
      }
    }

    // Dirty status via `git status --porcelain` (full mode only).
    if (pollingMode === "full") {
      const output = await runGit(["status", "--porcelain"], cwd, 500);
      if (fetchId === invalidationCounter) {
        const parsed = output === null ? null : parseGitStatusOutput(output);
        const next: CachedGitStatus = parsed
          ? {
              staged: parsed.staged,
              unstaged: parsed.unstaged,
              untracked: parsed.untracked,
              timestamp: Date.now(),
            }
          : { staged: 0, unstaged: 0, untracked: 0, timestamp: Date.now() };
        const prev = cachedStatus;
        statusChanged =
          !prev || prev.staged !== next.staged || prev.unstaged !== next.unstaged || prev.untracked !== next.untracked;
        cachedStatus = next;
      }
    }

    profileMark("fetchGitStatusAsync", started);

    if ((branchChanged || statusChanged) && onCacheChange) {
      try {
        onCacheChange();
      } catch {
        // Listener errors must never break the refresh loop.
      }
    }
  })();

  try {
    await pendingFetch;
  } finally {
    pendingFetch = null;
  }
}

/**
 * Trigger an async refresh. Safe to call repeatedly — one refresh runs at a
 * time; concurrent callers reuse the previous cached value. NEVER call this
 * from the render path (the render path uses {@link getGitStatus}).
 */
export async function refreshGitStatus(opts?: { cwd?: string; pollingMode?: GitPollingMode }): Promise<void> {
  const cwd = opts?.cwd ?? refreshCwd;
  const pollingMode = opts?.pollingMode ?? "full";
  // No cwd known yet: nothing to refresh. The render path returns provider
  // defaults until configureGitStatusCwd() is called.
  if (!cwd) return;
  await fetchGitStatusAsync(cwd, pollingMode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Synchronous cache reads (render path) — pure, no side effects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the cached current git branch. PURE READ — never spawns, never schedules.
 * Returns the cached branch (may be stale within BRANCH_TTL_MS) or the provider
 * branch when no cached value exists yet.
 */
export function getCurrentBranch(providerBranch: string | null): string | null {
  if (cachedBranch) return cachedBranch.branch;
  return providerBranch;
}

/**
 * Get the cached git status. PURE READ — never spawns, never schedules.
 * Designed for synchronous render() calls. Background refresh happens via the
 * poller started with {@link startGitStatusPoller}.
 */
export function getGitStatus(providerBranch: string | null, pollingMode: GitPollingMode = "full"): GitStatus {
  const branch = pollingMode === "off" ? providerBranch : getCurrentBranch(providerBranch);

  if (pollingMode !== "full") {
    return { branch, staged: 0, unstaged: 0, untracked: 0 };
  }

  if (cachedStatus) {
    return {
      branch,
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  return { branch, staged: 0, unstaged: 0, untracked: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the cwd the refresh worker uses. Called by the extension when the
 * project cwd is known.
 */
export function configureGitStatusCwd(cwd: string): void {
  refreshCwd = cwd;
}

/**
 * Set the callback invoked when a refresh changes the cached branch or dirty
 * state. The extension uses this to request a TUI render so updated values
 * eventually appear.
 */
export function setGitStatusChangeListener(listener: (() => void) | null): void {
  onCacheChange = listener;
}

/** Force-refresh: clear caches so the next refresh re-populates them. */
export function invalidateGitStatus(): void {
  cachedStatus = null;
  invalidationCounter++;
}

/** Force-refresh: clear branch cache. */
export function invalidateGitBranch(): void {
  cachedBranch = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Periodic poller (started/stopped by the extension)
// ─────────────────────────────────────────────────────────────────────────────

export interface GitStatusPollerOptions {
  cwd: () => string;
  pollingMode: () => GitPollingMode;
  intervalMs?: number;
}

/**
 * Start a background poller that refreshes git state on an interval. Timers are
 * `unref()`'d so they never keep the process alive. Only one poller may be
 * active at a time; starting again stops the previous one.
 */
export function startGitStatusPoller(options: GitStatusPollerOptions): {
  stop: () => void;
} {
  stopGitStatusPoller();
  const intervalMs = options.intervalMs ?? STATUS_TTL_MS;

  const tick = () => {
    void refreshGitStatus({
      cwd: options.cwd(),
      pollingMode: options.pollingMode(),
    });
  };

  // Prime immediately so the first render after start has a value quickly.
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  const handle: PollerHandle = {
    stop() {
      clearInterval(timer);
    },
  };
  activePoller = handle;
  return handle;
}

/** Stop the active git status poller, if any. */
export function stopGitStatusPoller(): void {
  if (activePoller) {
    activePoller.stop();
    activePoller = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers (exported for unit tests; not part of the render contract)
// ─────────────────────────────────────────────────────────────────────────────

/** @internal Reset all caches and counters. Tests only. */
export function __resetGitStatusForTests(): void {
  cachedStatus = null;
  cachedBranch = null;
  pendingFetch = null;
  invalidationCounter = 0;
  refreshCwd = null;
  onCacheChange = null;
  stopGitStatusPoller();
}

/** @internal Expose whether a refresh is currently in flight. Tests only. */
export function __gitStatusRefreshInFlight(): boolean {
  return pendingFetch !== null;
}

/** @internal Expose parsed branch-from-head for direct unit testing. */
export function __readBranchFromGitHead(cwd: string): string | null {
  return readBranchFromGitHead(cwd);
}
