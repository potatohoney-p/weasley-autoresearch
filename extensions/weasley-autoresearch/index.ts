/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - Status widget showing experiment count + best metric
 * - Configurable shortcut to open the fullscreen dashboard overlay
 * - Adds autoresearch guidance to the system prompt and points the agent at .auto/prompt.md
 * - Injects .auto/prompt.md into context on every turn via before_agent_start
 */

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
  type SessionSnapshot,
} from "./hooks.ts";
import {
  parseJsonlEntry,
  isAutoresearchRunEntry,
  extractAutoresearchSessionName,
  reconstructJsonlState,
} from "./jsonl.ts";
import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
  CompactionSourceReadError,
} from "./compaction.ts";
import { resolveAutoresearchShortcuts } from "./shortcuts.ts";
import { sessionFilePath, sessionFileCandidates, ensureParentDir, AUTO_DIR } from "./paths.ts";
import { captureCandidateProvenance, resolveBenchmarkPath } from "./provenance.ts";
import { benchmarkPathFromCommand } from "./benchmark-command.ts";
import { commitKeptCandidate } from "./keep.ts";
import { MetricCollector, metricLimitWarning, type MetricLimit } from "./metrics.ts";

// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Actionable Side Information (ASI) — free-form diagnostics per experiment run.
 * The agent decides what to record. Any key/value pair is valid.
 */
interface ASI {
  [key: string]: unknown;
}

interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Actionable Side Information — structured diagnostics for this run */
  asi?: ASI;
}

interface MetricDef {
  name: string;
  unit: string;
}

interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score (best improvement / noise floor). null if insufficient data. */
  confidence: number | null;
}

export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

type AutoResumeGuardState = Pick<ExperimentState, "results" | "currentSegment">;
type AutoResumeGuardRuntime = {
  autoResumeTurns: number;
  state: AutoResumeGuardState;
};

/** Count trailing rejected results, including correctness failures, in this segment. */
export function countConsecutiveDiscardOrCrashResults(state: AutoResumeGuardState): number {
  let count = 0;
  for (let i = state.results.length - 1; i >= 0; i--) {
    const result = state.results[i];
    if (result.segment !== state.currentSegment) break;
    if (result.status === "discard" || result.status === "crash" || result.status === "checks_failed") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function autoResumeStopReasonFor(runtime: AutoResumeGuardRuntime): string | null {
  if (runtime.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(runtime.state);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes/checks failures`;
  }
  return null;
}

interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Optional synchronous progress delivery failed; execution results remain authoritative. */
  progressUpdateFailed?: boolean;
  /** Metrics parsed from METRIC lines in output. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Resource limits reached while collecting structured metrics. */
  metricLimits: MetricLimit[];
  /** Primary metric value extracted from parsedMetrics (matching metricName). null if not found. */
  parsedPrimary: number | null;
  /** Name of the primary metric (for display) */
  metricName: string;
  metricUnit: string;

}

interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
}

interface AutoresearchRuntime {
  autoresearchMode: boolean;
  /** In-process serialization only; other sessions and external writers are not locked. */
  logInProgress: boolean;
  /** Explicit command-level reconciliation/resume is required after an uncertain keep. */
  keepReconciliationRequired: boolean;
  experimentsThisSession: number;
  autoResumeTurns: number;
  /** Revokes pending benchmark/check completions when evidence is invalidated. */
  runGeneration: number;
  /** Only the latest attempted run in this runtime may authorize a keep. */
  lastRunBenchmark: {
    passed: boolean;
    /** Observed primary value, copied independently of returned tool details. */
    primaryMetric: number | null;
    /** Private snapshot, never shared with returned tool details. */
    observedMetrics: Map<string, number>;
    workDir: string;
    candidateDigest: string;
    invokedBenchmark: string | null;
    provenanceError: string | null;
  } | null;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  runningExperiment: { startedAt: number; command: string } | null;
  state: ExperimentState;
  /** Pending auto-resume timer; cancelled when the agent starts a new run or compacts. */
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Resume message to send when the pending timer fires. */
  pendingResumeMessage: string | null;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

// Node timers clamp overflowing delays to 1 ms. Validate before launching work.
function timeoutMilliseconds(value: unknown, fallback: number, name: string): number {
  const seconds = value === undefined ? fallback : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid ${name}: expected a finite number from 0 to ${MAX_TIMEOUT_SECONDS} seconds (0 disables the timeout).`);
  }
  return seconds === 0 ? 0 : Math.max(1, Math.floor(seconds * 1000));
}

const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600; 0 disables timeout)",
      minimum: 0,
      maximum: MAX_TIMEOUT_SECONDS,
    })
  ),
  checks_timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Kill .auto/checks.sh after this many seconds (default: 300; 0 disables timeout). Validated even when checks are absent.",
      minimum: 0,
      maximum: MAX_TIMEOUT_SECONDS,
    })
  ),
});

const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    })
  ),
  direction: Type.Optional(
    Type.String({
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    })
  ),
});

export const LogParams = Type.Object({
  commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
  metric: Type.Number({
    description:
      "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
  }),
  status: StringEnum(["keep", "discard", "crash", "checks_failed"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
  metrics: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Number(),
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    })
  ),
  asi: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Unknown(),
      description:
        'Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields.',
    })
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

/** Lazy temp file allocator — returns the same path on subsequent calls */
function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Kill a process tree (best effort, tries process group first) */
function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM", allowDirectFallback = true): void {
  try {
    process.kill(-pid, signal);
  } catch {
    if (!allowDirectFallback) return;
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have already exited
    }
  }
}

function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Compute the median of a numeric array (returns 0 for empty arrays) */
function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`, where
 * best_delta is the improvement of the best kept metric over baseline.
 *
 * Returns null when there are fewer than 3 data points (insufficient data)
 * or when MAD is 0 (all values identical — no measurable noise).
 */
function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // Find best kept metric in current segment
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

/** Get results in the current segment only */
function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

/** Read the config file (.auto/config.json, legacy autoresearch.config.json) from the given directory (always ctx.cwd) */
function readConfig(cwd: string): AutoresearchConfig {
  const configPath = autoresearchConfigPath(cwd);
  if (!fs.existsSync(configPath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid ${path.relative(cwd, configPath) || path.basename(configPath)}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid .auto/config.json: expected a JSON object.");
  }

  const config = parsed as Record<string, unknown>;
  const unknown = Object.keys(config).filter(
    (key) => key !== "maxIterations" && key !== "workingDir"
  );
  if (unknown.length > 0) {
    throw new Error(`Invalid .auto/config.json: unknown field(s): ${unknown.join(", ")}.`);
  }
  if (
    config.maxIterations !== undefined &&
    (!Number.isInteger(config.maxIterations) || (config.maxIterations as number) <= 0)
  ) {
    throw new Error("Invalid .auto/config.json: maxIterations must be a positive integer.");
  }
  if (
    config.workingDir !== undefined &&
    (typeof config.workingDir !== "string" || config.workingDir.trim() === "")
  ) {
    throw new Error("Invalid .auto/config.json: workingDir must be a non-empty string.");
  }
  return config as AutoresearchConfig;
}

/** Read maxExperiments from the config file (if it exists) */
function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return (typeof config.maxIterations === "number" && config.maxIterations > 0)
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from the config file (.auto/config.json) in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 */
function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

function canonicalPath(existingPath: string): string {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return path.resolve(existingPath);
  }
}

function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

const AUTORESEARCH_ACTIVATION_ENTRY = "weasley-autoresearch.activation";

interface AutoresearchActivationEntryData {
  version?: number;
  workDir?: string;
  active?: boolean;
}

export function shouldAutoActivateAutoresearch(
  ctxCwd: string,
  workDir: string,
  hasPersistedLog: boolean,
  recordedDecision: boolean | null = null,
): boolean {
  if (!hasPersistedLog) return false;
  // An explicit `/autoresearch on|off` in this session always wins, so a manual
  // off survives /tree, compaction, and reloads instead of snapping back on.
  if (recordedDecision !== null) return recordedDecision;
  // With no recorded decision, same-cwd sessions default on (a log implies intent);
  // redirected workingDir sessions default off until this session opts in.
  return samePath(ctxCwd, workDir);
}

function autoresearchActivationData(entry: CustomEntry): AutoresearchActivationEntryData | null {
  if (entry.customType !== AUTORESEARCH_ACTIVATION_ENTRY) return null;

  const data = entry.data as AutoresearchActivationEntryData | undefined;
  if (typeof data?.workDir !== "string") return null;

  return data;
}

function recordedActivationDecision(ctx: ExtensionContext, workDir: string): boolean | null {
  const canonicalWorkDir = canonicalPath(workDir);
  let decision: boolean | null = null;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;

    const data = autoresearchActivationData(entry);
    if (!data || canonicalPath(data.workDir) !== canonicalWorkDir) continue;

    decision = data.active === true;
  }

  return decision;
}

/**
 * Validate that the resolved working directory exists.
 * Returns an error message if it doesn't exist, or null if OK.
 */
function validateWorkDir(ctxCwd: string): string | null {
  let workDir: string;
  try {
    workDir = resolveWorkDir(ctxCwd);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  return null;
}

/**
 * Return a fail-closed activation error without modifying the repository.
 * Session artifacts are excluded; every other staged, tracked, or untracked
 * change belongs to the user and must never be swept into git add/clean later.
 */
export function worktreeActivationError(workDir: string): string | null {
  const status = spawnSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude,glob)**/.auto/**",
      ":(exclude,glob)**/autoresearch.*",
      ":(exclude,glob)**/autoresearch.*/**",
    ],
    { cwd: workDir, encoding: "utf8", timeout: 5000 }
  );
  if (status.error) {
    return `Cannot verify a clean git worktree: ${status.error.message}`;
  }
  if (status.status !== 0) {
    const detail = (status.stderr || status.stdout || "git status failed").trim();
    return `Cannot verify a clean git worktree: ${detail}`;
  }
  if (status.stdout.trim()) {
    return (
      "Autoresearch requires a clean git worktree before activation. " +
      "Commit or stash your existing changes, then try again."
    );
  }
  return null;
}

/** Baseline = first experiment in current segment */
function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/** Best = optimal metric across kept experiments in current segment (min for lower, max for higher) */
function findBestMetric(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const kept = currentResults(results, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

// -----------------------------------------------------------------------
// Session file paths (single source of truth for autoresearch.* filenames)
// -----------------------------------------------------------------------

const autoresearchJsonlPath  = (dir: string) => sessionFilePath(dir, "log");
const autoresearchMdPath     = (dir: string) => sessionFilePath(dir, "prompt");
const autoresearchIdeasPath  = (dir: string) => sessionFilePath(dir, "ideas");
const autoresearchChecksPath = (dir: string) => sessionFilePath(dir, "checks");
const autoresearchScriptPath = (dir: string) => sessionFilePath(dir, "measure");
const autoresearchConfigPath = (dir: string) => sessionFilePath(dir, "config");

function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/** Metric names are user data, including names inherited from Object.prototype. */
function ownMetric(metrics: Record<string, number>, name: string): number | undefined {
  return Object.hasOwn(metrics, name) ? metrics[name] : undefined;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (ownMetric(base, sm.name) === undefined) {
        for (const r of cur) {
          const val = ownMetric(r.metrics ?? {}, sm.name);
          if (val !== undefined) {
            Object.defineProperty(base, sm.name, {
              value: val, enumerable: true, writable: true, configurable: true,
            });
            break;
          }
        }
      }
    }
  }

  return base;
}

function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateDisplayText(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…", true);
}

function joinPartsToWidth(parts: string[], width: number): string {
  let line = "";
  for (const part of parts) {
    if (!part) continue;
    const next = line + part;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    return truncateToWidth(line || part, width, "…", true);
  }
  return truncateToWidth(line, width, "…", true);
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: Theme,
  candidates: string[]
): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) continue;
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

function getTuiSize(tui: { terminal?: { columns?: number; rows?: number } }): { width: number; height: number } {
  return {
    width: tui.terminal?.columns ?? process.stdout.columns ?? 120,
    height: tui.terminal?.rows ?? process.stdout.rows ?? 40,
  };
}

function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
  };
}

function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    logInProgress: false,
    keepReconciliationRequired: false,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    runGeneration: 0,
    lastRunBenchmark: null,
    lastRunChecks: null,
    lastRunDuration: null,
    runningExperiment: null,
    state: createExperimentState(),
    pendingResumeTimer: null,
    pendingResumeMessage: null,
  };
}

function invalidateRunEvidence(runtime: AutoresearchRuntime): void {
  runtime.runGeneration++;
  runtime.lastRunBenchmark = null;
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  runtime.runningExperiment = null;
}

function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHints: string[] = []
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  const confSuffix = st.confidence !== null
    ? (() => {
        const confStr = st.confidence!.toFixed(1);
        const confColor: Parameters<typeof th.fg>[0] = st.confidence! >= 2.0 ? "success" : st.confidence! >= 1.0 ? "warning" : "error";
        return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
      })()
    : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics — wrap into lines that fit width, indented
    if (st.secondaryMetrics.length > 0) {
      const indent = "            "; // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length; // 2 for leading "  "

      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = ownMetric(bestSecondary, sm.name);
        const bv = ownMetric(baselineSec, sm.name);
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines
      if (secParts.length > 0) {
        let curLine = "";
        let curVisW = 0;
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
        }
      }
    }
  }

  lines.push("");

  // Determine visible rows once — used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const rowsToRender = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    rowsToRender.some((r) => ownMetric(r.metrics ?? {}, sm.name) !== undefined)
  );

  // Column definitions
  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (st.metricName || "metric");
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), visibleWidth(primaryLabel) + 1));
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 };
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;

  // Compute each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColWidths: number[] = secMetrics.map((sm) => {
    let maxW = visibleWidth(sm.name);
    for (const r of rowsToRender) {
      const val = ownMetric(r.metrics ?? {}, sm.name);
      if (val !== undefined) {
        maxW = Math.max(maxW, visibleWidth(formatNum(val, sm.unit)));
      }
    }
    return maxW + 1;
  });

  const totalSecWidth = () => secColWidths.slice(0, visibleSecMetrics.length).reduce((a, b) => a + b, 0);

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (visibleSecMetrics.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth());

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(truncateToWidth(primaryLabel, col.primary - 1).padEnd(col.primary)))}`;

  for (let si = 0; si < visibleSecMetrics.length; si++) {
    const sm = visibleSecMetrics[si];
    headerLine += th.fg(
      "muted",
      sm.name.padEnd(secColWidths[si])
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(
    headerHints.length > 0
      ? appendRightAlignedAdaptiveHint(headerLine, width, th, headerHints)
      : truncateToWidth(headerLine, width, "…", true)
  );
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  const baselineIndex = st.results.findIndex((x) => x.segment === st.currentSegment);

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === baselineIndex;

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const colW = secColWidths[si];
      const val = ownMetric(rowMetrics, sm.name);
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = ownMetric(baselineSecondary, sm.name);
          if (isBaseline) {
            secColor = "text";
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(colW));
      } else {
        rowLine += th.fg("dim", "—".padEnd(colW));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const BENCHMARK_GUARDRAIL =
    "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

  // Outlasts pi's internal retry (setTimeout 0) and compaction-continue
  // (setTimeout 100); see badlogic/pi-mono#2023, #2110.
  const SETTLED_WINDOW_MS = 800;
  const shortcuts = resolveAutoresearchShortcuts();

  const dashboardHintVariants = (): string[] => {
    if (!shortcuts.fullscreenDashboard) return [];
    return [
      `${shortcuts.fullscreenDashboard} fullscreen`,
      shortcuts.fullscreenDashboard,
    ];
  };

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  // Registering through this gates the tool, so a new one can't slip in ungated.
  const gatedToolNames = new Set<string>();
  const registerGatedTool = (tool: Parameters<typeof pi.registerTool>[0]): void => {
    gatedToolNames.add(tool.name);
    pi.registerTool(tool);
  };

  // The one place mode flips: gated tools follow the flag, never drifting from it.
  const setAutoresearchMode = (ctx: ExtensionContext, enabled: boolean): void => {
    getRuntime(ctx).autoresearchMode = enabled;
    const activeTools = new Set(pi.getActiveTools()); // setActiveTools replaces the whole set
    for (const tool of gatedToolNames) {
      enabled ? activeTools.add(tool) : activeTools.delete(tool);
    }
    pi.setActiveTools([...activeTools]);
  };

  const recordAutoresearchActivation = (workDir: string, active: boolean): void => {
    pi.appendEntry(AUTORESEARCH_ACTIVATION_ENTRY, {
      version: 1,
      workDir: canonicalPath(workDir),
      active,
    });
  };

  const isAgentSettled = (ctx: ExtensionContext): boolean =>
    ctx.isIdle() && !ctx.hasPendingMessages();

  const hasPendingResume = (runtime: AutoresearchRuntime): boolean =>
    runtime.pendingResumeMessage !== null;

  const pausePendingResume = (runtime: AutoresearchRuntime): void => {
    if (!runtime.pendingResumeTimer) return;
    clearTimeout(runtime.pendingResumeTimer);
    runtime.pendingResumeTimer = null;
  };

  const cancelPendingResume = (runtime: AutoresearchRuntime): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = null;
  };

  const logBusyResult = () => ({
    content: [{ type: "text" as const, text: "An experiment log operation is in progress. Wait for its outcome before changing the session or running another experiment." }],
    details: {},
    isError: true,
  });

  const reconciliationResult = () => ({
    content: [{ type: "text" as const, text: "A previous experiment operation has an uncertain Git or log outcome. Inspect HEAD, the index and the session log and reconcile them, then explicitly resume with /autoresearch <goal>. Automatic retries are blocked." }],
    details: {},
    isError: true,
  });

  const pauseUncertainKeep = (ctx: ExtensionContext, workDir: string): string => {
    const runtime = getRuntime(ctx);
    // Stop automatic continuation even if persisting the OFF record or aborting fails.
    runtime.autoresearchMode = false;
    runtime.keepReconciliationRequired = true;
    cancelPendingResume(runtime);
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    const warnings: string[] = [];
    for (const [label, action] of [
      ["disable tools", () => setAutoresearchMode(ctx, false)],
      ["persist session pause", () => recordAutoresearchActivation(workDir, false)],
      ["abort current loop", () => ctx.abort()],
    ] as const) {
      try { action(); }
      catch (error) { warnings.push(`Could not ${label}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return warnings.length ? `\n${warnings.join("\n")}` : "";
  };

  const markAutoResumeSent = (runtime: AutoresearchRuntime): void => {
    runtime.autoResumeTurns++;
  };

  const sendPendingResumeIfReady = (ctx: ExtensionContext, runtime: AutoresearchRuntime): void => {
    const message = runtime.pendingResumeMessage;

    if (!message) return;
    if (!runtime.autoresearchMode) {
      cancelPendingResume(runtime);
      return;
    }
    if (!isAgentSettled(ctx)) return;
    const stopReason = autoResumeStopReasonFor(runtime);
    if (stopReason !== null) {
      cancelPendingResume(runtime);
      notifyAutoResumeLimitReached(ctx, stopReason);
      return;
    }

    cancelPendingResume(runtime);
    markAutoResumeSent(runtime);
    pi.sendUserMessage(message);
  };

  const schedulePendingResume = (ctx: ExtensionContext, runtime: AutoresearchRuntime, message: string): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = message;
    runtime.pendingResumeTimer = setTimeout(
      () => sendPendingResumeIfReady(ctx, runtime),
      SETTLED_WINDOW_MS,
    );
  };

  const reschedulePendingResume = (ctx: ExtensionContext, runtime: AutoresearchRuntime): void => {
    if (!hasPendingResume(runtime)) return;
    schedulePendingResume(ctx, runtime, runtime.pendingResumeMessage!);
  };

  const hasRunExperimentsThisSession = (runtime: AutoresearchRuntime): boolean =>
    runtime.experimentsThisSession > 0;

  // Why the experiment gate: a chat-only turn would otherwise loop forever,
  // because every agent_end would re-prompt the agent, which would chat again.
  const shouldAutoResumeAfterTurn = (runtime: AutoresearchRuntime): boolean =>
    runtime.autoresearchMode && hasRunExperimentsThisSession(runtime);

  const shouldAutoResumeAfterCompact = (runtime: AutoresearchRuntime): boolean =>
    runtime.autoresearchMode;

  const notifyAutoResumeLimitReached = (ctx: ExtensionContext, reason?: string | null): void => {
    ctx.ui.notify(reason ?? `Autoresearch auto-resume limit reached`, "info");
  };

  const composeResumeMessage = (_ctx: ExtensionContext): string => {
    return [
      "Run the next iteration now.",
      "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
      BENCHMARK_GUARDRAIL,
    ].join(" ");
  };

  const composeCompactionResumeMessage = (_ctx: ExtensionContext): string => {
    // The compaction summary already contains the rules, ideas, and recent
    // runs — so this resume message just kicks the loop forward.
    return [
      "Run the next iteration now.",
      "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
      "Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them.",
      BENCHMARK_GUARDRAIL,
    ].join(" ");
  };

  const autoresearchCompactionFor = (
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
  ) => {
    if (!getRuntime(ctx).autoresearchMode) return undefined;
    return {
      compaction: {
        summary: buildAutoresearchCompactionSummary(
          autoresearchSummaryPathsFor(resolveWorkDir(ctx.cwd)),
        ),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  };

  const sendWhenReady = (ctx: ExtensionContext, message: string): void => {
    if (ctx.isIdle()) {
      pi.sendUserMessage(message);
      return;
    }
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  };

  const hasAutoresearchRules = (ctx: ExtensionContext): boolean =>
    fs.existsSync(autoresearchMdPath(resolveWorkDir(ctx.cwd)));

  const readJsonlLines = (workDir: string): string[] => {
    const jsonlPath = autoresearchJsonlPath(workDir);
    if (!fs.existsSync(jsonlPath)) return [];
    return fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  };

  const readLastRun = (workDir: string): Record<string, unknown> | null => {
    const lines = readJsonlLines(workDir);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseJsonlEntry(lines[i]);
      if (isAutoresearchRunEntry(entry)) return entry;
    }
    return null;
  };

  const buildSessionSnapshot = (state: ExperimentState): SessionSnapshot => ({
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.bestMetric,
    best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  });

  const fireHook = async (payload: HookPayload): Promise<string | null> => {
    const result = await runHook(payload);
    appendHookLogEntryIfConfigured(autoresearchJsonlPath(payload.cwd), payload.event, result);
    return steerMessageFor(payload.event, result);
  };

  // Running experiment state (for spinner in fullscreen overlay)
  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const clearOverlay = () => {
    overlayTui = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    clearOverlay();
    if (ctx.hasUI) {
      ctx.ui.setWidget("autoresearch", undefined);
    }
  };

  const autoresearchHelp = () =>
    [
      "Usage: /autoresearch [off|clear|export|<text>]",
      "",
      "<text> enters autoresearch mode and starts or resumes the loop.",
      "off leaves autoresearch mode.",
      "clear deletes the session log (.auto/log.jsonl) and turns autoresearch mode off.",
      "export opens a local live dashboard for the session log in your browser.",

      "",
      "Examples:",
      "  /autoresearch optimize unit test runtime, monitor correctness",
      "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target",
      "  /autoresearch export",
    ].join("\n");

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    cancelPendingResume(runtime);
    invalidateRunEvidence(runtime);
    runtime.experimentsThisSession = 0;
    runtime.autoResumeTurns = 0;
    runtime.state = createExperimentState();

    let state = runtime.state;

    // Resolve effective working directory only after strict config validation.
    const workDirError = validateWorkDir(ctx.cwd);
    if (workDirError) {
      setAutoresearchMode(ctx, false);
      if (ctx.hasUI) ctx.ui.notify(`Autoresearch disabled: ${workDirError}`, "error");
      updateWidget(ctx);
      return;
    }
    const workDir = resolveWorkDir(ctx.cwd);

    // Primary: read from .auto/log.jsonl (alongside .auto/prompt.md and .auto/measure.sh)
    const jsonlPath = autoresearchJsonlPath(workDir);
    const hasPersistedLog = fs.existsSync(jsonlPath);
    let loadedFromJsonl = false;
    try {
      if (hasPersistedLog) {
        const reconstructed = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"));
        state.name = reconstructed.name;
        state.metricName = reconstructed.metricName;
        state.metricUnit = reconstructed.metricUnit;
        state.bestDirection = reconstructed.bestDirection;
        state.currentSegment = reconstructed.currentSegment;
        state.results = reconstructed.results.map((result) => ({
          ...result,
          metrics: { ...result.metrics },
        }));
        state.secondaryMetrics = reconstructed.secondaryMetrics.map((metric) => ({ ...metric }));

        // A successfully read log is authoritative even before its first result.
        // Falling back here would resurrect history from a cleared session.
        loadedFromJsonl = true;
        if (state.results.length > 0) {
          state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
          state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
        }
      }
    } catch {
      // Fall through to session history
    }

    // Fallback: reconstruct from session history (backward compat)
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          runtime.state = cloneExperimentState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
            if (r.confidence === undefined) r.confidence = null;
          }
          if (state.confidence === undefined) {
            state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
          }
        }
      }
    }


    // Read max experiments from config file
    state.maxExperiments = readMaxExperiments(ctx.cwd);

    // Auto-enter autoresearch mode only when a persisted experiment log exists.
    // A recorded `/autoresearch on|off` in this session wins; otherwise same-cwd
    // sessions default on and redirected workingDir sessions default off, so
    // unrelated chats launched from a shared cwd never activate it.
    const shouldActivate = shouldAutoActivateAutoresearch(
      ctx.cwd,
      workDir,
      hasPersistedLog,
      recordedActivationDecision(ctx, workDir),
    );
    const activationError = shouldActivate ? worktreeActivationError(workDir) : null;
    setAutoresearchMode(ctx, shouldActivate && !activationError);
    if (activationError && ctx.hasUI) {
      ctx.ui.notify(`Autoresearch disabled: ${activationError}`, "error");
    }

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const runtime = getRuntime(ctx);
    const state = runtime.state;

    if (!runtime.autoresearchMode) {
      ctx.ui.setWidget("autoresearch", undefined);
      return;
    }

    if (state.results.length === 0) {
      if (!runtime.runningExperiment) {
        ctx.ui.setWidget("autoresearch", undefined);
        return;
      }

      ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const runningLine = joinPartsToWidth(
            [
              theme.fg("accent", "🔬"),
              theme.fg("warning", " running…"),
              state.name ? theme.fg("dim", ` │ ${state.name}`) : "",
              theme.fg("dim", ` │ ${runtime.runningExperiment?.command ?? ""}`),
              theme.fg("dim", " │ waiting for first logged result"),
            ],
            safeWidth
          );
          return [runningLine];
        },
        invalidate(): void {},
      }));
      return;
    }

    // Full dashboard table rendered as widget
    ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const title = truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, safeWidth - 5)
          );
          const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);
          const rows = safeWidth < 95 ? 4 : 6;

          return [
            truncateToWidth(
              theme.fg("borderMuted", "───") +
                theme.fg("accent", ` ${title} `) +
                theme.fg("borderMuted", "─".repeat(fillLen)),
              safeWidth,
              "…",
              true
            ),
            ...renderDashboardLines(
              state,
              safeWidth,
              theme,
              rows,
              dashboardHintVariants()
            ),
          ];
        },
        invalidate(): void {},
      }));
  };

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async (_e, ctx) => {
    invalidateRunEvidence(getRuntime(ctx));
    clearOverlay();
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    invalidateRunEvidence(getRuntime(ctx));
    clearSessionUi(ctx);
    cancelPendingResume(getRuntime(ctx));
    runtimeStore.clear(getSessionKey(ctx));
    stopDashboardServer();
  });

  pi.on("agent_start", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.experimentsThisSession = 0;
    pausePendingResume(runtime);
  });

  const ensurePendingResume = (
    ctx: ExtensionContext,
    gate: (runtime: AutoresearchRuntime) => boolean,
    composeMessage: (ctx: ExtensionContext) => string = composeResumeMessage,
  ): void => {
    const runtime = getRuntime(ctx);
    if (hasPendingResume(runtime)) {
      reschedulePendingResume(ctx, runtime);
      return;
    }
    if (!gate(runtime)) return;
    const stopReason = autoResumeStopReasonFor(runtime);
    if (stopReason !== null) {
      notifyAutoResumeLimitReached(ctx, stopReason);
      return;
    }
    schedulePendingResume(ctx, runtime, composeMessage(ctx));
  };

  pi.on("session_before_compact", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    pausePendingResume(runtime);
    try {
      return autoresearchCompactionFor(ctx, event);
    } catch (error) {
      // The host catches thrown extension errors and may continue with default
      // compaction. Return explicit cancellation so failed source reads cannot
      // replace history with an incomplete summary or resume message.
      cancelPendingResume(runtime);
      const detail = error instanceof CompactionSourceReadError
        ? error.message
        : "Unable to prepare persisted session sources. Repair them before retrying.";
      try {
        ctx.ui.notify(`Autoresearch compaction canceled: ${detail}`, "error");
      } catch {
        // Notification delivery must not suppress the cancellation contract.
      }
      return { cancel: true };
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    ensurePendingResume(ctx, shouldAutoResumeAfterCompact, composeCompactionResumeMessage);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.runningExperiment = null;
    if (overlayTui) overlayTui.requestRender();
    ensurePendingResume(ctx, shouldAutoResumeAfterTurn);
  });

  // When in autoresearch mode, add a static note to the system prompt.
  // Only a short pointer — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (!runtime.autoresearchMode) return;

    const workDir = resolveWorkDir(ctx.cwd);
    const mdPath = autoresearchMdPath(workDir);
    const ideasPath = autoresearchIdeasPath(workDir);
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = autoresearchChecksPath(workDir);
    const hasChecks = fs.existsSync(checksPath);

    let extra =
      "\n\n## Autoresearch Mode (ACTIVE)" +
      "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
      "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
      "\nWrite promising but deferred optimizations as bullet points to .auto/ideas.md — don't let good ideas get lost." +
      `\n${BENCHMARK_GUARDRAIL}` +
      "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
        "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
        "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // -----------------------------------------------------------------------
  // init_experiment tool — one-time setup
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "init_experiment",
    label: "Init Experiment",
    description:
      "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to .auto/log.jsonl.",
    promptSnippet:
      "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
      "If the session log (.auto/log.jsonl) already exists with a config, do NOT call init_experiment again.",
      "If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
    ],
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      if (runtime.logInProgress) return logBusyResult();
      if (runtime.keepReconciliationRequired) return reconciliationResult();
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const isReinit = state.results.length > 0;
      invalidateRunEvidence(runtime);
      // Keep the currently published goal/baseline intact until its replacement
      // is persisted. A failed append may have written bytes, so it must pause
      // through the same explicit reconciliation gate as an uncertain keep.
      const nextState = {
        ...state,
        name: params.name,
        metricName: params.metric_name,
        metricUnit: params.metric_unit ?? "",
        bestDirection: params.direction === "lower" || params.direction === "higher"
          ? params.direction : state.bestDirection,
        currentSegment: state.currentSegment + (isReinit ? 1 : 0),
        bestMetric: null,
        secondaryMetrics: [],
        confidence: null,
        maxExperiments: readMaxExperiments(ctx.cwd),
      };

      // Write config header to jsonl (append for re-init, create for first)
      const workDir = resolveWorkDir(ctx.cwd);
      try {
        const jsonlPath = autoresearchJsonlPath(workDir);
        ensureParentDir(jsonlPath);
        const config = JSON.stringify({
          type: "config",
          name: nextState.name,
          metricName: nextState.metricName,
          metricUnit: nextState.metricUnit,
          bestDirection: nextState.bestDirection,
        });
        if (fs.existsSync(jsonlPath)) {
          fs.appendFileSync(jsonlPath, config + "\n");
        } else {
          fs.writeFileSync(jsonlPath, config + "\n");
        }
      } catch (e) {
        const pauseWarnings = pauseUncertainKeep(ctx, workDir);
        return {
          content: [{
            type: "text",
            text: `❌ Experiment initialization persistence is uncertain: ${e instanceof Error ? e.message : String(e)}\nThe previous in-memory goal and baseline are unchanged. The config write may have partially or completely succeeded. Autoresearch is paused. Inspect and reconcile .auto/log.jsonl, then explicitly resume. Do not automatically retry initialization.${pauseWarnings}`,
          }],
          details: { state: cloneExperimentState(state) },
          isError: true,
        };
      }

      Object.assign(state, nextState);
      broadcastDashboardUpdate(workDir);

      const wasInactive = !runtime.autoresearchMode;
      recordAutoresearchActivation(workDir, true);
      setAutoresearchMode(ctx, true);
      updateWidget(ctx);

      if (wasInactive) {
        const steer = await fireHook({
          event: "before",
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: readLastRun(workDir),
          session: buildSessionSnapshot(state),
        });
        if (steer) pi.sendUserMessage(steer, { deliverAs: "steer" });
      }

      const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
      const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from .auto/config.json)` : "";
      const workDirNote = workDir !== ctx.cwd ? `\nWorking directory: ${workDir}` : "";
      return {
        content: [{
          type: "text",
          text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to .auto/log.jsonl. Now run the baseline with run_experiment.`,
        }],
        details: { state: cloneExperimentState(state) },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("init_experiment "));
      text += theme.fg("accent", args.name ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // run_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result.",
      "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",

    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      if (runtime.logInProgress) return logBusyResult();
      if (runtime.keepReconciliationRequired) return reconciliationResult();
      const state = runtime.state;

      // TODO(/tree): replace compaction-based resume with a checkpoint-per-iteration model.
      // Every attempted run supersedes prior evidence, including a rejected
      // invocation. Never let a validation failure revive an earlier success.
      invalidateRunEvidence(runtime);
      const runGeneration = runtime.runGeneration;
      const assertCurrentRun = () => {
        if (runtime.runGeneration !== runGeneration) {
          throw new Error("Experiment run superseded by another attempt or session change; its evidence was not published.");
        }
        if (signal?.aborted) {
          invalidateRunEvidence(runtime);
          throw new Error("aborted");
        }
      };
      assertCurrentRun();

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(ctx.cwd);

      // Block if max experiments limit already reached
      if (state.maxExperiments !== null) {
        const segCount = currentResults(state.results, state.currentSegment).length;
        if (segCount >= state.maxExperiments) {
          return {
            content: [{ type: "text", text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.` }],
            details: {},
          };
        }
      }

      let timeout: number;
      let checksTimeout: number;
      try {
        timeout = timeoutMilliseconds(params.timeout_seconds, 600, "timeout_seconds");
        checksTimeout = timeoutMilliseconds(params.checks_timeout_seconds, 300, "checks_timeout_seconds");
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `❌ ${(error as Error).message}` }],
          details: {},
        };
      }

      // Guard: if the benchmark script exists, require a complete supported
      // invocation, not merely a prefix whose shell status could hide failure.
      const autoresearchShPath = autoresearchScriptPath(workDir);
      const benchmarkScriptRel = path.relative(workDir, autoresearchShPath) || path.basename(autoresearchShPath);
      const benchmarkCommandPath = benchmarkPathFromCommand(params.command);
      if (fs.existsSync(autoresearchShPath) && !benchmarkCommandPath) {
        return {
          content: [{
            type: "text",
            text: `❌ ${benchmarkScriptRel} exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${params.command}\n\nUse a supported literal invocation such as run_experiment({ command: "bash ${benchmarkScriptRel}" }). Literal script arguments, quoted paths, and basic env/time/nice/nohup wrappers are supported. Put pipelines, redirection, chaining, expansion, or complex setup inside the benchmark script and propagate failures; syntax-only/help shell modes are not supported.`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
          } as RunDetails,
        };
      }

      let candidateDigest: string;
      let invokedBenchmark: string | null;
      try {
        invokedBenchmark = resolveBenchmarkPath(workDir, benchmarkCommandPath);
        candidateDigest = captureCandidateProvenance(workDir, invokedBenchmark);
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ Cannot run_experiment — cannot capture candidate provenance: ${error instanceof Error ? error.message : String(error)}. Fix the unsupported or unreadable input, then rerun.` }],
          details: {},
        };
      }
      // Do not launch already-cancelled work, even briefly.
      if (signal?.aborted) throw new Error("aborted");

      // TODO(/tree): replace compaction-based resume with a checkpoint-per-iteration model.
      runtime.runningExperiment = { startedAt: Date.now(), command: params.command };
      updateWidget(ctx);
      if (overlayTui) overlayTui.requestRender();

      const t0 = Date.now();
      let progressUpdateFailed = false;

      // Spawn the process directly (like the bash tool) for streaming output
      const getTempFile = createTempFileAllocator();
      const metricCollector = new MetricCollector();
      const { exitCode, killed: timedOut, output, tempFilePath: streamTempFile, actualTotalBytes, completedAt } = await new Promise<{
        exitCode: number | null;
        killed: boolean;
        output: string;
        tempFilePath: string | undefined;
        actualTotalBytes: number;
        completedAt: number;
      }>((resolve, reject) => {
        let processTimedOut = false;

        const child = spawn("bash", ["-c", params.command], {
          cwd: workDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Rolling buffer for tail truncation (keep 2x what we need)
        const chunks: Buffer[] = [];
        const rawPrefix: Buffer[] = [];
        const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
        const ended = new Set<string>();
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        // Temp file for full output when it overflows
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;
        let outputError: Error | undefined;
        let outputFinished: Promise<void> | undefined;
        const failOutput = (error: unknown): void => {
          outputError ??= error instanceof Error ? error : new Error(String(error));
          stop();
        };

        // Cache for Buffer.concat — only rebuild when chunks change
        let chunksGeneration = 0;
        let cachedGeneration = -1;
        let cachedText = "";

        function getBufferText(): string {
          if (cachedGeneration === chunksGeneration) return cachedText;
          cachedText = Buffer.concat(chunks).toString("utf-8");
          cachedGeneration = chunksGeneration;
          return cachedText;
        }

        // Timer interval — update every second with elapsed time + tail output
        const timerInterval = setInterval(() => {
          if (!onUpdate || progressUpdateFailed) return;
          const elapsed = formatElapsed(Date.now() - t0);
          const trunc = truncateTail(getBufferText(), {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          try {
            onUpdate({
              content: [{ type: "text", text: trunc.content || "" }],
              details: {
                phase: "running",
                elapsed,
                truncation: trunc.truncated ? trunc : undefined,
                fullOutputPath: tempFilePath,
              },
            });
          } catch {
            // The host progress callback is optional and synchronous. Do not let a
            // display failure escape this timer and terminate the host process.
            // Disable only this run's observer; never replay the benchmark.
            progressUpdateFailed = true;
          }
        }, 1000);

        // Both readable pipes feed one sink. Pause both when it asks for pressure;
        // otherwise stderr can continue filling the same queue while stdout waits.
        const writeOutput = (data: Buffer): void => {
          try {
            if (tempFileStream && !tempFileStream.write(data)) {
              child.stdout?.pause();
              child.stderr?.pause();
            }
          } catch (error) { failOutput(error); }
        };

        const handleData = (data: Buffer, pipe: "stdout" | "stderr") => {
          metricCollector.write(pipe, data);
          totalBytes += data.length;

          // Start writing to temp file once we exceed the threshold
          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            try {
              tempFilePath = getTempFile();
              tempFileStream = createWriteStream(tempFilePath);
              const stream = tempFileStream;
              stream.on("drain", () => {
                if (!outputError && !finished) {
                  child.stdout?.resume();
                  child.stderr?.resume();
                }
              });
              // Observe failures immediately, but settle only after child cleanup.
              // Resolve on error too so there is no unhandled rejected promise.
              outputFinished = new Promise<void>((done) => {
                stream.once("error", (error) => { failOutput(error); done(); });
                stream.once("finish", done);
                stream.once("close", () => {
                  if (!stream.writableFinished && !outputError) failOutput(new Error("Output stream closed before finishing"));
                  done();
                });
              });
              for (const chunk of rawPrefix) writeOutput(chunk);
              rawPrefix.length = 0;
            } catch (error) {
              failOutput(error);
            }
          }

          if (tempFileStream && !outputError) {
            writeOutput(data);
          }

          if (!tempFilePath) rawPrefix.push(data);
          appendText(decoders[pipe].write(data));
        };

        const appendText = (text: string) => {
          if (!text) return;
          const data = Buffer.from(text, "utf8");
          // Each chunk contains whole decoded codepoints, never mixed pipe fragments.
          chunks.push(data);
          chunksBytes += data.length;

          // Evict old chunks, then trim the first surviving chunk to a line
          // boundary. This avoids splitting multi-byte UTF-8 characters that
          // straddle chunk boundaries (which would produce U+FFFD on decode).
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
          // Trim first surviving chunk to a newline boundary
          if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
            const buf = chunks[0];
            const nlIdx = buf.indexOf(0x0a); // '\n'
            if (nlIdx !== -1 && nlIdx < buf.length - 1) {
              chunks[0] = buf.subarray(nlIdx + 1);
              chunksBytes -= nlIdx + 1;
            }
          }

          chunksGeneration++;
        };

        const endText = (pipe: "stdout" | "stderr") => {
          if (ended.has(pipe)) return;
          ended.add(pipe);
          appendText(decoders[pipe].end());
          metricCollector.end(pipe);
        };
        child.stdout?.on("data", (data) => handleData(data, "stdout"));
        child.stderr?.on("data", (data) => handleData(data, "stderr"));
        child.stdout?.on("end", () => endText("stdout"));
        child.stderr?.on("end", () => endText("stderr"));

        // Cancellation is a bounded cleanup phase, not just a signal request.
        // Keep escalation alive even if the direct child exits first: descendants
        // in its process group can still be running or retaining output pipes.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let escalationHandle: ReturnType<typeof setTimeout> | undefined;
        let stopping = false;
        let finished = false;
        let observedExitCode: number | null = null;
        let childExited = false;

        const finish = async (error?: Error) => {
          if (finished) return;
          finished = true;
          endText("stdout");
          endText("stderr");
          const completedAt = Date.now();
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (escalationHandle) clearTimeout(escalationHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();
          if (outputFinished) await outputFinished;
          if (outputError) {
            reject(new Error(`Failed to persist benchmark output: ${outputError.message}`));
            return;
          }
          if (error || signal?.aborted) {
            reject(error ?? new Error("aborted"));
            return;
          }

          metricCollector.end("stdout");
          metricCollector.end("stderr");
          resolve({
            exitCode: observedExitCode,
            killed: processTimedOut,
            output: Buffer.concat(chunks).toString("utf-8"),
            tempFilePath,
            actualTotalBytes: totalBytes,
            completedAt,
          });
        };
        const stop = () => {
          if (stopping || finished) return;
          stopping = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (child.pid) killTree(child.pid, "SIGTERM", !childExited);
          else child.once("spawn", () => { if (child.pid) killTree(child.pid); });
          escalationHandle = setTimeout(() => {
            if (child.pid) killTree(child.pid, "SIGKILL", !childExited);
            // An escaped descendant may retain inherited pipes indefinitely.
            // Release only our handles; do not claim those jobs were terminated.
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            finish();
          }, 250);
        };
        const onAbort = () => stop();
        child.on("exit", (code) => { childExited = true; observedExitCode = code; });
        child.on("error", (err) => finish(err));
        child.on("close", (code) => {
          observedExitCode = code;
          if (!stopping) finish();
        });
        if (timeout > 0) {
          timeoutHandle = setTimeout(() => {
            processTimedOut = true;
            stop();
          }, timeout);
        }
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }).finally(() => {
        if (runtime.runGeneration === runGeneration) {
          runtime.runningExperiment = null;
          updateWidget(ctx);
          if (overlayTui) overlayTui.requestRender();
        }
      });

      assertCurrentRun();
      const durationSeconds = (completedAt - t0) / 1000;
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;

      const checksPath = autoresearchChecksPath(workDir);
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const ct0 = Date.now();
        try {
          const checksResult = await pi.exec("bash", [checksPath], {
            signal,
            timeout: checksTimeout,
            cwd: workDir,
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = !!checksResult.killed;
          checksPass = checksResult.code === 0 && !checksResult.killed;
          checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
        } catch (e) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
      }

      assertCurrentRun();
      // Snapshot work stays outside benchmark/check duration measurements.
      let provenanceError: string | null = null;
      if (benchmarkPassed && checksPass !== false) {
        try {
          if (captureCandidateProvenance(workDir, invokedBenchmark) !== candidateDigest) {
            provenanceError = "candidate or benchmark/check inputs changed during the benchmark or correctness checks";
          }
        } catch (error) {
          provenanceError = `cannot verify candidate provenance: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const passed = benchmarkPassed && (checksPass === null || checksPass) && !provenanceError;

      // Reuse streaming temp file if it exists, otherwise create one for large output
      let fullOutputPath: string | undefined = streamTempFile;
      const totalLines = output.split("\n").length;
      if (!fullOutputPath && (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
        fullOutputPath = getTempFile();
        fs.writeFileSync(fullOutputPath, output);
      }

      // Wider truncation for TUI display (details.tailOutput)
      const displayTruncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      // Tight truncation for LLM context (10 lines / 4KB)
      const llmTruncation = truncateTail(output, {
        maxLines: EXPERIMENT_MAX_LINES,
        maxBytes: EXPERIMENT_MAX_BYTES,
      });

      // Collected before display eviction; each pipe has its own line decoder.
      const { values: parsedMetricMap, limits: metricLimits } = metricCollector.snapshot();
      const parsedMetrics = parsedMetricMap.size > 0
        ? Object.fromEntries(parsedMetricMap)
        : null;
      const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

      const details: RunDetails = {
        command: params.command,
        exitCode,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut,
        tailOutput: displayTruncation.content,
        checksPass,
        checksTimedOut,
        checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
        checksDuration,
        ...(progressUpdateFailed ? { progressUpdateFailed: true } : {}),
        parsedMetrics,
        metricLimits,
        parsedPrimary,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
      };

      // Build LLM response
      let text = "";
      if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (.auto/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (.auto/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
      } else if (provenanceError) {
        text += `⚠️ Benchmark completed, but ${provenanceError}.\n`;
        text += "Cannot keep this result. Generate nonignored outputs before benchmarking or ignore disposable build artifacts, then rerun the benchmark.\n";
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      if (progressUpdateFailed) {
        text += "⚠ Progress updates stopped after a callback failure; benchmark and checks results are unchanged.\n";
      }

      if (state.bestMetric !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      if (metricLimits.length) text += `⚠️ ${metricLimitWarning(metricLimits)}\n`;

      // Show parsed METRIC lines to the LLM
      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

        // Human-readable summary
        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) {
          text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        }
        for (const [name, value] of secondary) {
          // Infer unit from name suffix for display
          const sm = state.secondaryMetrics.find((m) => m.name === name);
          const unit = sm?.unit ?? "";
          text += ` ${name}=${formatNum(value, unit)}`;
        }

        // Machine-ready values for log_experiment (raw numbers, not formatted)
        text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
      }

      text += `\n${llmTruncation.content}`;

      if (llmTruncation.truncated) {
        if (llmTruncation.truncatedBy === "lines") {
          text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
        } else {
          text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        }
        if (fullOutputPath) {
          text += ` Full output: ${fullOutputPath}`;
        }
        text += `]`;
      }

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
      }

      // Publish only after the current call has finished preparing its result.
      // Late completions must not revive evidence invalidated while awaiting.
      assertCurrentRun();
      runtime.lastRunBenchmark = { passed: benchmarkPassed, primaryMetric: parsedPrimary, observedMetrics: new Map(parsedMetricMap), workDir, candidateDigest, invokedBenchmark, provenanceError };
      runtime.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;
      runtime.lastRunDuration = durationSeconds;
      return {
        content: [{ type: "text", text }],
        details: { ...details, truncation: llmTruncation.truncated ? llmTruncation : undefined, fullOutputPath },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const PREVIEW_LINES = 5;

      if (isPartial) {
        // Streaming: show elapsed timer + tail of output
        const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
        const elapsed = d?.elapsed ?? "";
        const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

        // Always show tail of streaming output (like bash tool shows preview lines)
        if (outputText) {
          const lines = outputText.split("\n");
          const maxLines = expanded ? 20 : PREVIEW_LINES;
          const tail = lines.slice(-maxLines).join("\n");
          if (tail.trim()) {
            text += "\n" + theme.fg("dim", tail);
          }
        }

        return new Text(text, 0, 0);
      }

      const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
      if (!d || typeof d.durationSeconds !== "number") {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      // Helper: append tail output preview or full output
      const appendOutput = (text: string, output: string): string => {
        const warning = metricLimitWarning(d.metricLimits ?? []);
        if (warning) text += "\n" + theme.fg("warning", warning);
        if (!output) return text;
        const lines = output.split("\n");
        if (expanded) {
          text += "\n" + theme.fg("dim", output.slice(-2000));
        } else {
          const tail = lines.slice(-PREVIEW_LINES).join("\n");
          if (tail.trim()) {
            const hidden = lines.length - PREVIEW_LINES;
            if (hidden > 0) {
              text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
            }
            text += "\n" + theme.fg("dim", tail);
          }
        }
        return text;
      };

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      // Helper: format parsed primary metric suffix (empty string if not available)
      const parsedSuffix = d.parsedPrimary !== null
        ? theme.fg("accent", `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`)
        : "";

      if (d.checksTimedOut) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.checksPass === false) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) + parsedSuffix;
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      let text = theme.fg("success", "✅ ");

      // Show wall-clock and parsed primary metric together
      const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
      if (d.parsedPrimary !== null) {
        parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
      }
      text += theme.fg("accent", parts.join(", "));

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
      }

      if (d.truncation?.truncated && d.fullOutputPath) {
        text += theme.fg("warning", " (truncated)");
      }

      text = appendOutput(text, d.tailOutput);

      if (expanded && d.truncation?.truncated && d.fullOutputPath) {
        if (d.truncation.truncatedBy === "lines") {
          text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
        } else {
          text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet:
      "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result.",
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
      "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
      "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to .auto/ideas.md. Don't let good ideas get lost.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      if (runtime.logInProgress) return logBusyResult();
      if (runtime.keepReconciliationRequired) return reconciliationResult();
      runtime.logInProgress = true;
      try {
        // A keep is published only after its Git outcome and log append succeed.
        const state = params.status === "keep" ? cloneExperimentState(runtime.state) : runtime.state;

        // Validate working directory exists
        const workDirError = validateWorkDir(ctx.cwd);
        if (workDirError) {
          return {
            content: [{ type: "text", text: `❌ ${workDirError}` }],
            details: {},
          };
        }
        const workDir = resolveWorkDir(ctx.cwd);
        const secondaryMetrics = params.metrics ?? {};

        // A replayed session, interrupted command, or already-consumed result is
        // not evidence that the current working tree passed its benchmark.
        if (params.status === "keep" &&
            (!runtime.lastRunBenchmark || runtime.lastRunBenchmark.workDir !== workDir)) {
          return {
            content: [{ type: "text", text: "❌ Cannot keep — run_experiment must complete successfully in this working directory first. Re-run after a restart, interruption, or previously logged result." }],
            details: {},
          };
        }
        if (params.status === "keep" && !runtime.lastRunBenchmark?.passed) {
          return {
            content: [{ type: "text", text: "❌ Cannot keep — the latest benchmark failed or timed out. Log as 'crash' or run a successful benchmark first." }],
            details: {},
          };
        }

        // A caller may transcribe a manual metric only when the run did not
        // observe the primary METRIC. Never publish a conflicting measured value.
        const observedPrimary = runtime.lastRunBenchmark?.primaryMetric;
        if (params.status === "keep" && observedPrimary != null && params.metric !== observedPrimary) {
          return {
            content: [{ type: "text", text: `❌ Cannot keep — primary metric must match the latest observed value (${observedPrimary}). Correct metric to that value or rerun the benchmark; force does not override measurement evidence.` }],
            details: {},
          };
        }

        if (params.status === "keep") {
          const observed = runtime.lastRunBenchmark!.observedMetrics;
          for (const [name, value] of Object.entries(secondaryMetrics)) {
            if (observed.has(name) && value !== observed.get(name)) {
              return {
                content: [{ type: "text", text: `❌ Cannot keep — secondary metric "${name}" must match the latest observed value (${observed.get(name)}). Correct the value or rerun the benchmark; force does not override measurement evidence.` }],
                details: {},
              };
            }
          }
        }

        // Gate: prevent "keep" when last run's checks failed
        if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
          return {
            content: [{
              type: "text",
              text: `❌ Cannot keep — .auto/checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
            }],
            details: {},
          };
        }

        if (params.status === "keep") {
          const evidence = runtime.lastRunBenchmark!;
          let provenanceError = evidence.provenanceError;
          if (!provenanceError) {
            try {
              if (captureCandidateProvenance(workDir, evidence.invokedBenchmark) !== evidence.candidateDigest) {
                provenanceError = "candidate or benchmark/check inputs changed after the benchmark";
              }
            } catch (error) {
              provenanceError = `cannot verify candidate provenance: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          if (provenanceError) {
            // An observed mismatch disqualifies this run, even if files are later
            // restored. Only a fresh run may produce new passing evidence.
            evidence.provenanceError = provenanceError;
            return {
              content: [{ type: "text", text: `❌ Cannot keep — ${provenanceError}. Rerun run_experiment after preparing the candidate; ignore disposable generated artifacts if needed.` }],
              details: {},
            };
          }
        }

        // Validate secondary metrics consistency (after first experiment establishes them)
        if (state.secondaryMetrics.length > 0) {
          const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
          const providedNames = new Set(Object.keys(secondaryMetrics));

          // Check for missing metrics
          const missing = [...knownNames].filter((n) => !providedNames.has(n));
          if (missing.length > 0) {
            return {
              content: [{
                type: "text",
                text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
              }],
              details: {},
            };
          }

          // Check for new metrics not yet tracked
          const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
          if (newMetrics.length > 0 && !params.force) {
            return {
              content: [{
                type: "text",
                text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
              }],
              details: {},
            };
          }
        }

        const loggedGeneration = runtime.runGeneration;
        const wallClockSeconds = runtime.lastRunDuration;

        // ASI: agent-supplied free-form diagnostics
        const mergedASI = (params.asi && Object.keys(params.asi).length > 0)
          ? params.asi as ASI
          : undefined;

        const experiment: ExperimentResult = {
          commit: params.commit.slice(0, 7),
          metric: params.metric,
          metrics: secondaryMetrics,
          status: params.status,
          description: params.description,
          timestamp: Date.now(),
          segment: state.currentSegment,
          confidence: null,
          asi: mergedASI,
        };

        state.results.push(experiment);
        if (params.status !== "keep") runtime.experimentsThisSession++;

        // Register any new secondary metric names
        for (const name of Object.keys(secondaryMetrics)) {
          if (!state.secondaryMetrics.find((m) => m.name === name)) {
            let unit = "";
            if (name.endsWith("µs")) unit = "µs";
            else if (name.endsWith("_ms")) unit = "ms";
            else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
            else if (name.endsWith("_kb")) unit = "kb";
            else if (name.endsWith("_mb")) unit = "mb";
            state.secondaryMetrics.push({ name, unit });
          }
        }

        // Baseline = first run in current segment
        state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

        // Compute confidence score (best improvement as multiple of noise floor)
        state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
        experiment.confidence = state.confidence;

        // Build response text
        const segmentCount = currentResults(state.results, state.currentSegment).length;
        let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

        if (state.bestMetric !== null) {
          text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
          if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
            const delta = params.metric - state.bestMetric;
            const pct = ((delta / state.bestMetric) * 100).toFixed(1);
            const sign = delta > 0 ? "+" : "";
            text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
          }
        }

        // Show secondary metrics
        if (Object.keys(secondaryMetrics).length > 0) {
          const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
          const parts: string[] = [];
          for (const [name, value] of Object.entries(secondaryMetrics)) {
            const def = state.secondaryMetrics.find((m) => m.name === name);
            const unit = def?.unit ?? "";
            let part = `${name}: ${formatNum(value, unit)}`;
            const bv = ownMetric(baselines, name);
            if (bv !== undefined && state.results.length > 1 && bv !== 0) {
              const d = value - bv;
              const p = ((d / bv) * 100).toFixed(1);
              const s = d > 0 ? "+" : "";
              part += ` (${s}${p}%)`;
            }
            parts.push(part);
          }
          text += `\nSecondary: ${parts.join("  ")}`;
        }

        // Show ASI summary
        if (mergedASI) {
          const asiParts: string[] = [];
          for (const [k, v] of Object.entries(mergedASI)) {
            const s = typeof v === "string" ? v : JSON.stringify(v);
            asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
          }
          if (asiParts.length > 0) {
            text += `\n📋 ASI: ${asiParts.join(" | ")}`;
          }
        }

        // Show confidence score
        if (state.confidence !== null) {
          const confStr = state.confidence.toFixed(1);
          if (state.confidence >= 2.0) {
            text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
          } else if (state.confidence >= 1.0) {
            text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
          } else {
            text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
          }
        }

        text += `\n(${segmentCount} experiments`;
        if (state.maxExperiments !== null) {
          text += ` / ${state.maxExperiments} max`;
        }
        text += `)`;

        // Auto-commit only on keep — discards/crashes get reverted anyway
        let verifiedCommit: string | undefined;
        if (params.status === "keep") {
          const resultData: Record<string, unknown> = {
            status: params.status,
            [state.metricName || "metric"]: params.metric,
            ...secondaryMetrics,
          };
          const commitMsg = `${params.description}\n\nResult: ${JSON.stringify(resultData)}`;
          const outcome = await commitKeptCandidate((...args) => pi.exec(...args), workDir, commitMsg);
          if (!outcome.ok) {
            const pauseWarnings = outcome.uncertain ? pauseUncertainKeep(ctx, workDir) : "";
            const guidance = outcome.uncertain
              ? "Git outcome is uncertain. Autoresearch is paused. Inspect HEAD, the index and the session log, reconcile them, then explicitly resume. Do not automatically retry this keep."
              : "No commit was attempted. Inspect and repair the reported problem before retrying; any staging already performed is preserved.";
            return {
              content: [{ type: "text", text: `❌ Keep was not recorded (${outcome.phase}): ${outcome.message}\n${guidance}${outcome.beforeHead ? `\nHEAD before operation: ${outcome.beforeHead}` : ""}${pauseWarnings}` }],
              details: { keepOutcome: outcome },
              isError: true,
            };
          }
          verifiedCommit = outcome.commit;
          experiment.commit = outcome.commit.slice(0, 7);
          text += outcome.createdCommit
            ? `\n📝 Git: committed — ${experiment.commit}`
            : `\n📝 Git: nothing to commit; using current HEAD ${experiment.commit}`;
        }

        const jsonlEntry: Record<string, unknown> = {
          run: state.results.length,
          ...experiment,
        };
        if (!mergedASI) delete jsonlEntry.asi;
        const jsonlLine = JSON.stringify(jsonlEntry);

        try {
          const jsonlPath = autoresearchJsonlPath(workDir);
          ensureParentDir(jsonlPath);
          fs.appendFileSync(jsonlPath, jsonlLine + "\n");
        } catch (e) {
          if (params.status === "keep") {
            const pauseWarnings = pauseUncertainKeep(ctx, workDir);
            return {
              content: [{ type: "text", text: `❌ Keep log persistence is uncertain: ${e instanceof Error ? e.message : String(e)}\nVerified Git HEAD: ${verifiedCommit}\nAutoresearch is paused. The append may have written a partial or complete entry. Inspect HEAD, the index and the session log, reconcile them, then explicitly resume. Do not automatically retry or append a duplicate.${pauseWarnings}` }],
              details: { keepOutcome: { ok: false, phase: "append", uncertain: true, commit: verifiedCommit } },
              isError: true,
            };
          }
          text += `\n⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
        }

        if (params.status === "keep") {
          // Preserve the state object captured by an open fullscreen dashboard.
          Object.assign(runtime.state, state);
          runtime.experimentsThisSession++;
        }
        // Consume per-run state at publication, before fallible hooks or UI work.
        // A failure in those follow-up actions does not undo the recorded result.
        if (runtime.runGeneration === loggedGeneration) invalidateRunEvidence(runtime);

        try { broadcastDashboardUpdate(workDir); }
        catch (error) {
          text += `\n⚠️ Dashboard refresh failed: ${error instanceof Error ? error.message : String(error)}`;
        }

        if (params.status !== "keep") {
          try {
            const revertScript = `
              set -e
              git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
              git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**'
            `;
            const rollback = await pi.exec("bash", ["-c", revertScript], { cwd: workDir, timeout: 10000 });
            if (rollback.code !== 0 || rollback.killed) {
              throw new Error(`exit ${rollback.code}${rollback.killed ? ", terminated" : ""}: ${(rollback.stderr || rollback.stdout || "no diagnostic output").slice(0, 500)}`);
            }
            text += `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`;
          } catch (e) {
            const pauseWarnings = pauseUncertainKeep(ctx, workDir);
            text += `\n❌ Git rollback did not complete: ${e instanceof Error ? e.message : String(e)}\nThe experiment outcome has already been recorded in memory and its log append was attempted. Do not repeat log_experiment. Autoresearch is paused. Inspect HEAD, the index, working tree and session log, reconcile them, then explicitly resume.${pauseWarnings}`;
            return {
              content: [{ type: "text", text }],
              details: {
                experiment: { ...experiment, metrics: { ...experiment.metrics } },
                state: cloneExperimentState(state),
                wallClockSeconds,
                rollbackOutcome: { ok: false, uncertain: true },
              },
              isError: true,
            };
          }
        }

        const runPostLogHook = async (payload: HookPayload): Promise<void> => {
          const label = payload.event === "after" ? "After" : "Before";
          let steer: string | null;
          try {
            steer = await fireHook(payload);
          } catch (error) {
            text += `\n⚠️ ${label} hook failed: ${error instanceof Error ? error.message : String(error)}`;
            return;
          }
          if (steer) {
            try {
              await pi.sendUserMessage(steer, { deliverAs: "steer" });
            } catch (error) {
              text += `\n⚠️ ${label} hook steering failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        };

        await runPostLogHook({
          event: "after",
          cwd: workDir,
          run_entry: jsonlEntry,
          session: buildSessionSnapshot(state),
        });

        const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
        if (limitReached) {
          text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
          recordAutoresearchActivation(workDir, false);
          setAutoresearchMode(ctx, false);
          ctx.abort();
        } else if (runtime.autoresearchMode) {
          await runPostLogHook({
            event: "before",
            cwd: workDir,
            next_run: state.results.length + 1,
            last_run: jsonlEntry,
            session: buildSessionSnapshot(state),
          });
        }

        updateWidget(ctx);

        // Refresh fullscreen overlay if open
        if (overlayTui) overlayTui.requestRender();

        return {
          content: [{ type: "text", text }],
          details: {
            experiment: { ...experiment, metrics: { ...experiment.metrics } },
            state: cloneExperimentState(state),
            wallClockSeconds,
          } as LogDetails,
        };
      } finally {
        runtime.logInProgress = false;
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash" || args.status === "checks_failed"
            ? "error"
            : "warning";
      text += theme.fg(color, args.status);
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (result.isError || !d?.experiment || !d.state) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.results.length}`);

      // Show wall-clock and primary metric together
      const metricParts: string[] = [];
      if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
        metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
      }
      if (exp.metric > 0) {
        metricParts.push(`${s.metricName}: ${formatNum(exp.metric, s.metricUnit)}`);
      }
      if (metricParts.length > 0) {
        text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
      }

      text += " " + theme.fg("muted", exp.description);

      // Show best metric for context (overall best, not just this run)
      if (s.bestMetric !== null) {
        // Find the actual best kept metric in the current segment
        let best = s.bestMetric;
        for (const r of s.results) {
          if (r.segment === s.currentSegment && r.status === "keep" && r.metric > 0) {
            if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
          }
        }
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", `★ best: ${formatNum(best, s.metricUnit)}`);
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // Fullscreen scrollable dashboard overlay shortcut
  // -----------------------------------------------------------------------

  if (shortcuts.fullscreenDashboard) {
    pi.registerShortcut(shortcuts.fullscreenDashboard, {
      description: "Fullscreen autoresearch dashboard",
      handler: async (ctx) => {
        const runtime = getRuntime(ctx);
        const state = runtime.state;
        if (!runtime.autoresearchMode) {
          ctx.ui.notify("Autoresearch mode is not active", "info");
          return;
        }
        if (state.results.length === 0) {
          ctx.ui.notify("No experiments yet", "info");
          return;
        }

        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) => {
          let scrollOffset = 0;
          let lastViewportRows = 8;
          let lastTotalRows = 0;
          overlayTui = tui;

          spinnerInterval = setInterval(() => {
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            if (runtime.runningExperiment) tui.requestRender();
          }, 80);

          const buildOverlayContent = (renderWidth: number): string[] => {
            const content = renderDashboardLines(state, renderWidth, theme, 0);
            if (runtime.runningExperiment) {
              const elapsed = formatElapsed(Date.now() - runtime.runningExperiment.startedAt);
              const frame = SPINNER[spinnerFrame % SPINNER.length];
              const nextIdx = state.results.length + 1;
              content.push(
                truncateToWidth(
                  `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                    theme.fg("warning", `${frame} running… ${elapsed}`),
                  renderWidth,
                  "…",
                  true
                )
              );
            }
            return content;
          };

          return {
            render(width: number): string[] {
              const { height } = getTuiSize(tui);
              const safeWidth = Math.max(1, width || getTuiSize(tui).width);
              const viewportRows = Math.max(4, height - 4);
              const content = buildOverlayContent(safeWidth);

              const totalRows = content.length;
              const maxScroll = Math.max(0, totalRows - viewportRows);
              scrollOffset = clamp(scrollOffset, 0, maxScroll);
              lastViewportRows = viewportRows;
              lastTotalRows = totalRows;

              const out: string[] = [];

              const title = truncateDisplayText(
                `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
                Math.max(0, safeWidth - 5)
              );
              const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);

              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "───") +
                    theme.fg("accent", ` ${title} `) +
                    theme.fg("borderMuted", "─".repeat(fillLen)),
                  safeWidth,
                  "…",
                  true
                )
              );

              const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
              for (const line of visible) out.push(truncateToWidth(line, safeWidth, "…", true));
              for (let i = visible.length; i < viewportRows; i++) out.push("");

              const scrollInfo = totalRows > viewportRows
                ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
                : "";
              const helpText = safeWidth >= 85
                ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
                : ` j/k scroll • esc close${scrollInfo} `;
              const footFill = Math.max(0, safeWidth - visibleWidth(helpText));

              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "─".repeat(footFill)) + theme.fg("dim", helpText),
                  safeWidth,
                  "…",
                  true
                )
              );

              return out;
            },

            handleInput(data: string): void {
              const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);

              if (matchesKey(data, "escape") || data === "q") {
                done(undefined);
                return;
              }
              if (matchesKey(data, "up") || data === "k") {
                scrollOffset = Math.max(0, scrollOffset - 1);
              } else if (matchesKey(data, "down") || data === "j") {
                scrollOffset = Math.min(maxScroll, scrollOffset + 1);
              } else if (matchesKey(data, "pageUp") || data === "u") {
                scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
              } else if (matchesKey(data, "pageDown") || data === "d") {
                scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
              } else if (data === "g") {
                scrollOffset = 0;
              } else if (data === "G") {
                scrollOffset = maxScroll;
              }
              tui.requestRender();
            },

            invalidate(): void {},

            dispose(): void {
              clearOverlay();
            },
          };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "95%",
              maxHeight: "90%",
              anchor: "center" as const,
            },
          }
        );
      },
    });
  }

  // -----------------------------------------------------------------------
  // Export: local live dashboard
  // -----------------------------------------------------------------------

  const TITLE_PLACEHOLDER = "__AUTORESEARCH_TITLE__";
  const LOGO_PLACEHOLDER = "__AUTORESEARCH_LOGO__";

  let cachedPackageRoot: string | null = null;

  function packageRoot(): string {
    if (cachedPackageRoot) return cachedPackageRoot;
    const extensionDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    cachedPackageRoot = path.resolve(extensionDir, "../..");
    return cachedPackageRoot;
  }

  function templatePath(): string {
    return path.join(packageRoot(), "assets/template.html");
  }

  function readTemplate(): string {
    return fs.readFileSync(templatePath(), "utf-8");
  }

  let cachedLogoDataUrl: string | null = null;

  function logoDataUrl(): string {
    if (cachedLogoDataUrl) return cachedLogoDataUrl;
    const logoPath = path.join(packageRoot(), "assets/weasley-autoresearch-hero.png");
    const bytes = fs.readFileSync(logoPath);
    cachedLogoDataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    return cachedLogoDataUrl;
  }

  function readJsonlContent(workDir: string): string {
    return fs.readFileSync(autoresearchJsonlPath(workDir), "utf-8").trim();
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectDataIntoTemplate(template: string, title: string): string {
    const escapedTitle = escapeHtml(title);
    return template.replace(TITLE_PLACEHOLDER, () => escapedTitle);
  }

  let dashboardServer: Server | null = null;
  let dashboardServerPort: number | null = null;
  let dashboardServerWorkDir: string | null = null;
  let dashboardServerHtmlPath: string | null = null;
  let dashboardGeneration = 0;
  let pendingDashboard: {
    server: Server;
    workDir: string;
    promise: Promise<number>;
    reject: (error: Error) => void;
  } | null = null;
  const dashboardSseClients = new Set<ServerResponse>();

  function openInBrowser(url: string): void {
    const child = process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          shell: true,
          stdio: "ignore",
        })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          detached: true,
          stdio: "ignore",
        });
    // Swallow launcher errors (e.g. xdg-open missing); caller prints the URL
    // so the user can open it manually.
    child.on("error", () => { /* ignore */ });
    child.unref();
  }

  function stopDashboardServer(): void {
    dashboardGeneration++;
    if (pendingDashboard) {
      const pending = pendingDashboard;
      pendingDashboard = null;
      pending.reject(new Error("Dashboard export cancelled"));
      try { pending.server.close(); } catch { /* ignore */ }
    }
    for (const client of dashboardSseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    dashboardSseClients.clear();

    if (dashboardServer) {
      try { dashboardServer.close(); } catch { /* ignore */ }
    }

    dashboardServer = null;
    dashboardServerPort = null;
    dashboardServerWorkDir = null;
    dashboardServerHtmlPath = null;
  }

  function writeDashboardFile(workDir: string): string {
    const jsonlContent = readJsonlContent(workDir);
    const sessionName = extractAutoresearchSessionName(jsonlContent);
    const html = injectDataIntoTemplate(readTemplate(), sessionName)
      .replace(LOGO_PLACEHOLDER, logoDataUrl());
    const exportDir = fs.mkdtempSync(path.join(tmpdir(), "weasley-autoresearch-dashboard-"));
    const dest = path.join(exportDir, "index.html");
    fs.writeFileSync(dest, html);
    return dest;
  }

  const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".jsonl": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
  };

  function fileContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
  }

  function resolveServedFile(workDir: string, requestPath: string): string | null {
    if (requestPath === "/") return dashboardServerHtmlPath;
    if (requestPath === "/autoresearch.jsonl") return autoresearchJsonlPath(workDir);
    return null;
  }

  function registerSseClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    dashboardSseClients.add(res);
    res.on("close", () => dashboardSseClients.delete(res));
  }

  function broadcastDashboardUpdate(workDir: string): void {
    if (!dashboardServer || dashboardServerWorkDir !== workDir) return;
    for (const res of dashboardSseClients) {
      try {
        res.write("event: jsonl-updated\n");
        res.write(`data: ${Date.now()}\n\n`);
      } catch {
        dashboardSseClients.delete(res);
      }
    }
  }

  function startStaticServer(workDir: string, dashboardHtmlPath: string): Promise<number> {
    const resolvedWorkDir = path.resolve(workDir);
    const resolvedDashboardHtmlPath = path.resolve(dashboardHtmlPath);
    if (dashboardServer && dashboardServerWorkDir === resolvedWorkDir && dashboardServerPort) {
      dashboardServerHtmlPath = resolvedDashboardHtmlPath;
      return Promise.resolve(dashboardServerPort);
    }
    if (pendingDashboard?.workDir === resolvedWorkDir) {
      dashboardServerHtmlPath = resolvedDashboardHtmlPath;
      return pendingDashboard.promise;
    }

    stopDashboardServer();
    const generation = dashboardGeneration;
    dashboardServerHtmlPath = resolvedDashboardHtmlPath;
    let resolve!: (port: number) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<number>((res, rej) => { resolve = res; reject = rej; });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/events") {
        registerSseClient(res);
        return;
      }

      const filePath = resolveServedFile(resolvedWorkDir, url.pathname);
      if (!filePath) {
        res.writeHead(404);
        res.end();
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": fileContentType(filePath) });
        res.end(data);
      });
    });

    pendingDashboard = { server, workDir: resolvedWorkDir, promise, reject };
    const fail = (error: Error) => {
      // The error handler also remains active after listen succeeds. Retire only
      // this server's ownership; a late error from a replaced server is harmless.
      if (dashboardServer === server) stopDashboardServer();
      if (pendingDashboard?.server === server) pendingDashboard = null;
      try { server.close(); } catch { /* ignore */ }
      reject(error);
    };
    server.on("error", fail);
    try {
      server.listen(0, "127.0.0.1", () => {
        if (generation !== dashboardGeneration) {
          server.close();
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") {
          fail(new Error("Failed to bind dashboard server"));
          return;
        }
        pendingDashboard = null;
        dashboardServer = server;
        dashboardServerPort = address.port;
        dashboardServerWorkDir = resolvedWorkDir;
        resolve(address.port);
      });

    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  async function exportDashboard(ctx: ExtensionContext): Promise<void> {
    const workDirError = validateWorkDir(ctx.cwd);
    if (workDirError) {
      ctx.ui.notify(`Export failed: ${workDirError}`, "error");
      return;
    }
    const workDir = resolveWorkDir(ctx.cwd);
    const jsonlPath = autoresearchJsonlPath(workDir);

    if (!fs.existsSync(jsonlPath)) {
      ctx.ui.notify(`No ${path.basename(jsonlPath)} found \u2014 run some experiments first`, "error");
      return;
    }

    try {
      const dashboardHtmlPath = writeDashboardFile(workDir);
      const starting = startStaticServer(workDir, dashboardHtmlPath);
      const generation = dashboardGeneration;
      const port = await starting;
      if (generation !== dashboardGeneration) return;
      const url = `http://127.0.0.1:${port}`;
      openInBrowser(url);
      ctx.ui.notify(`Dashboard at ${url} (live updates)`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  // -----------------------------------------------------------------------
  // /autoresearch command — enter autoresearch mode
  // -----------------------------------------------------------------------

  pi.registerCommand("autoresearch", {
    description: "Start, stop, clear, or resume autoresearch mode",
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        ctx.ui.notify(autoresearchHelp(), "info");
        return;
      }

      if (command === "off") {
        const wasRunning = !ctx.isIdle();
        let workDir = ctx.cwd;
        try {
          workDir = resolveWorkDir(ctx.cwd);
        } catch {
          // A malformed config must never prevent the emergency OFF path.
        }

        recordAutoresearchActivation(workDir, false);
        setAutoresearchMode(ctx, false);
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        invalidateRunEvidence(runtime);
        cancelPendingResume(runtime);
        stopDashboardServer();
        clearSessionUi(ctx);
        if (wasRunning) ctx.abort();
        ctx.ui.notify(
          wasRunning ? "Autoresearch mode OFF — aborting current run" : "Autoresearch mode OFF",
          "info"
        );
        return;
      }

      if (command === "export") {
        await exportDashboard(ctx);
        return;
      }

      if (runtime.logInProgress) {
        ctx.ui.notify("An experiment log operation is in progress. Wait for its outcome before clearing or restarting the session; /autoresearch off remains available.", "warning");
        return;
      }

      if (command === "clear") {
        let workDir = ctx.cwd;
        try {
          workDir = resolveWorkDir(ctx.cwd);
        } catch {
          // Clear remains available to recover from a malformed config.
        }
        const jsonlPaths = sessionFileCandidates(workDir, "log");
        recordAutoresearchActivation(workDir, false);
        setAutoresearchMode(ctx, false);
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        invalidateRunEvidence(runtime);
        cancelPendingResume(runtime);
        runtime.state = createExperimentState();
        stopDashboardServer();
        updateWidget(ctx);

        const deletedPaths: string[] = [];
        for (const jsonlPath of Object.values(jsonlPaths)) {
          if (!fs.existsSync(jsonlPath)) continue;
          try {
            fs.unlinkSync(jsonlPath);
            deletedPaths.push(path.relative(workDir, jsonlPath) || path.basename(jsonlPath));
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete ${path.relative(workDir, jsonlPath) || path.basename(jsonlPath)}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
        }

        runtime.keepReconciliationRequired = false;
        if (deletedPaths.length > 0) {
          ctx.ui.notify(`Deleted ${deletedPaths.join(", ")} and turned autoresearch mode OFF`, "info");
        } else {
          ctx.ui.notify("No session log found. Autoresearch mode OFF", "info");
        }
        return;
      }

      if (runtime.autoresearchMode) {
        ctx.ui.notify("Autoresearch already active — use '/autoresearch off' to stop first", "info");
        return;
      }

      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        ctx.ui.notify(`Autoresearch not activated: ${workDirError}`, "error");
        return;
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const activationError = worktreeActivationError(workDir);
      if (activationError) {
        ctx.ui.notify(`Autoresearch not activated: ${activationError}`, "error");
        return;
      }
      const reconciling = runtime.keepReconciliationRequired;
      if (reconciling) {
        try {
          // Explicit resume reads the user's reconciled log, never stale tool history.
          // Do not repair/truncate bytes or silently skip a partially appended line.
          const content = fs.readFileSync(autoresearchJsonlPath(workDir), "utf8");
          if (content && !content.endsWith("\n")) throw new Error("The log must end with a newline before another append.");
          for (const line of content.split("\n")) {
            if (line.trim() && !parseJsonlEntry(line)) throw new Error("Every nonempty log line must be a complete JSON object.");
          }
          const restored = {
            ...createExperimentState(),
            ...reconstructJsonlState(content),
            maxExperiments: readMaxExperiments(ctx.cwd),
          };
          restored.bestMetric = findBaselineMetric(restored.results, restored.currentSegment);
          restored.confidence = computeConfidence(restored.results, restored.currentSegment, restored.bestDirection);
          Object.assign(runtime.state, restored);
          runtime.lastRunChecks = null;
          runtime.lastRunDuration = null;
          runtime.runningExperiment = null;
          runtime.experimentsThisSession = 0;
          cancelPendingResume(runtime);
        } catch (error) {
          ctx.ui.notify(`Cannot resume from the reconciled session log: ${error instanceof Error ? error.message : String(error)} Repair it manually, or explicitly clear the session to reset it. Autoresearch remains paused.`, "error");
          return;
        }
      }
      try {
        recordAutoresearchActivation(workDir, true);
        setAutoresearchMode(ctx, true);
      } catch (error) {
        if (!reconciling) throw error;
        const warnings = pauseUncertainKeep(ctx, workDir);
        ctx.ui.notify(`Could not resume the reconciled session: ${error instanceof Error ? error.message : String(error)}${warnings}`, "error");
        return;
      }
      runtime.keepReconciliationRequired = false;
      runtime.autoResumeTurns = 0;
      const rulesLoaded = hasAutoresearchRules(ctx);
      // No .auto/prompt.md yet — load the create skill so the agent follows the
      // setup guidelines. `/skill:<name>` is expanded to the full SKILL.md by
      // pi's input pipeline (requires `enableSkillCommands`), and trailing args
      // are appended as the session goal. Must be sent as its own message that
      // STARTS with `/skill:` so expansion triggers — don't prepend hook output.
      const kickoff = rulesLoaded
        ? `Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        : `/skill:autoresearch-create ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`.replace(/\s+/g, " ").trim();

      ctx.ui.notify(
        rulesLoaded
          ? "Autoresearch mode ON — rules loaded from .auto/prompt.md"
          : "Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill",
        "info",
      );

      const state = runtime.state;
      const activationSteer = await fireHook({
        event: "before",
        cwd: workDir,
        next_run: state.results.length + 1,
        last_run: readLastRun(workDir),
        session: buildSessionSnapshot(state),
      });

      // Prepend hook output only when prompt.md exists; otherwise the message
      // must stay `/skill:...`-prefixed for command expansion.
      const message = activationSteer && rulesLoaded ? `${activationSteer}\n\n${kickoff}` : kickoff;
      sendWhenReady(ctx, message);
    },
  });
}

