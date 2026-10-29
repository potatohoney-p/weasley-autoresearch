/**
 * Deterministic compaction summary for autoresearch sessions.
 *
 * Replaces the default LLM-generated summary with a synthesized view of
 * persisted state — experiment rules, ideas backlog, and recent runs.
 * Everything that matters between iterations already lives on disk, so we
 * skip the LLM call entirely and keep the summary lossless on what counts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  reconstructJsonlState,
  type ReconstructedJsonlState,
  type ReconstructedRun,
} from "./jsonl.ts";
import { AUTO_DIR, sessionFilePath } from "./paths.ts";

const RECENT_RUN_LIMIT = 50;

type RunStatus = ReconstructedRun["status"];
type StatusCounts = Record<RunStatus, number>;

export interface AutoresearchSummaryPaths {
  workDir: string;
  jsonlPath: string;
  mdPath: string;
  ideasPath: string;
}

export function autoresearchSummaryPathsFor(workDir: string): AutoresearchSummaryPaths {
  const currentDir = path.join(workDir, AUTO_DIR);
  if (compactionSourceExists(currentDir)) {
    try {
      // A dangling layout link must not hide all current sources and select
      // stale legacy peers. Empty real directories retain legacy fallback.
      fs.statSync(currentDir);
    } catch (error) {
      throw new CompactionSourceReadError(currentDir, error);
    }
  }
  return {
    workDir,
    jsonlPath: sessionFilePath(workDir, "log", compactionSourceExists),
    mdPath: sessionFilePath(workDir, "prompt", compactionSourceExists),
    ideasPath: sessionFilePath(workDir, "ideas", compactionSourceExists),
  };
}

/**
 * Build the full compaction summary text from persisted autoresearch state.
 * Returns a markdown string that is itself the entire compaction summary.
 */
export function buildAutoresearchCompactionSummary(paths: AutoresearchSummaryPaths): string {
  const state = loadState(paths.jsonlPath);
  const sections = [
    headerSection(),
    sessionSection(state),
    rulesSection(paths.workDir, paths.mdPath),
    ideasSection(paths.workDir, paths.ideasPath),
    recentRunsSection(state, paths.workDir, paths.jsonlPath),
    nextStepSection(),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function loadState(jsonlPath: string): ReconstructedJsonlState {
  const content = readFileOrEmpty(jsonlPath);
  // Normal session reconstruction is intentionally tolerant, but compaction
  // must not discard conversation history after silently dropping damaged log
  // records. Validate this same read before reconstructing; never reread it.
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new CompactionLogFormatError(jsonlPath, index + 1);
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new CompactionLogFormatError(jsonlPath, index + 1);
    }
  }
  return reconstructJsonlState(content);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function headerSection(): string {
  return [
    "# Autoresearch Compaction Summary",
    "",
    "The conversation history was discarded; the persisted autoresearch state below is the source of truth.",
    "Continue the experiment loop using only what is included here plus the live tools.",
  ].join("\n");
}

function sessionSection(state: ReconstructedJsonlState): string {
  const runs = currentSegmentRuns(state);
  const lines = [
    "## Session",
    "",
    `Goal: ${state.name ?? "—"}`,
    `Metric: ${state.metricName} — ${state.bestDirection} is better`,
    runCountLine(runs),
    ...baselineAndBestLines(runs, state.bestDirection, state.metricUnit),
  ];
  return lines.join("\n");
}

function currentSegmentRuns(state: ReconstructedJsonlState): ReconstructedRun[] {
  return state.results.filter((run) => run.segment === state.currentSegment);
}

function runCountLine(runs: ReconstructedRun[]): string {
  if (runs.length === 0) return "Runs so far: 0";
  const counts = countByStatus(runs);
  const parts = [
    `${counts.keep} keep`,
    counts.discard ? `${counts.discard} discard` : "",
    counts.crash ? `${counts.crash} crash` : "",
    counts.checks_failed ? `${counts.checks_failed} checks_failed` : "",
  ].filter(Boolean);
  return `Runs so far: ${runs.length} (${parts.join(" · ")})`;
}

function countByStatus(runs: ReconstructedRun[]): StatusCounts {
  const counts: StatusCounts = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
  for (const run of runs) counts[run.status]++;
  return counts;
}

function baselineAndBestLines(
  runs: ReconstructedRun[],
  direction: "lower" | "higher",
  unit: string,
): string[] {
  const baseline = runs[0];
  if (!baseline) return [];
  const lines = [`Baseline (#${baseline.run}): ${formatMetricWithUnit(baseline.metric, unit)}`];
  const best = bestRun(runs, direction);
  if (best && best.run !== baseline.run) {
    lines.push(
      `Best     (#${best.run}): ${formatMetricWithUnit(best.metric, unit)}${formatDelta(best.metric, baseline.metric)}`,
    );
  }
  return lines;
}

function formatMetricWithUnit(value: number, unit: string): string {
  return `${formatMetric(value)}${unit}`;
}

function bestRun(runs: ReconstructedRun[], direction: "lower" | "higher"): ReconstructedRun | null {
  const kept = runs.filter((run) => run.status === "keep" && Number.isFinite(run.metric));
  if (kept.length === 0) return null;
  return kept.reduce((best, run) => (isBetter(run.metric, best.metric, direction) ? run : best));
}

function isBetter(value: number, current: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? value < current : value > current;
}

function readablePath(workDir: string, filePath: string): string {
  const relative = path.relative(workDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
  return relative.split(path.sep).join("/");
}

function rulesSection(workDir: string, mdPath: string): string {
  const content = readTrimmedFile(mdPath);
  if (!content) return "";
  return `## Experiment Rules (${readablePath(workDir, mdPath)})\n\n${content}`;
}

function ideasSection(workDir: string, ideasPath: string): string {
  const content = readTrimmedFile(ideasPath);
  if (!content) return "";
  return `## Ideas Backlog (${readablePath(workDir, ideasPath)})\n\n${content}`;
}

function recentRunsSection(state: ReconstructedJsonlState, workDir: string, jsonlPath: string): string {
  const runs = state.results.slice(-RECENT_RUN_LIMIT);
  if (runs.length === 0) {
    return "## Recent Runs\n\nNo runs yet — start with the first hypothesis.";
  }
  const lines = runs.map((run) => formatRunLine(run, baselineFor(run, state.results)));
  return [
    `## Recent Runs (last ${runs.length})`,
    "",
    "Format: `#run status metric (delta) | desc | hyp: ... | next: ... | rollback: ...`",
    "",
    ...lines,
    "",
    `If you need more details, read additional lines from ${readablePath(workDir, jsonlPath)}.`,
  ].join("\n");
}

function nextStepSection(): string {
  return [
    "## Next Step",
    "",
    "Pick the most promising hypothesis (from the ideas backlog or the latest `next:` hints in recent runs)",
    "and run the next experiment immediately. Do not stop until interrupted.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

/** Baseline metric for a run = first run in the same segment across full reconstructed state. */
function baselineFor(run: ReconstructedRun, all: ReconstructedRun[]): number | null {
  const sameSegment = all.find((other) => other.segment === run.segment);
  return sameSegment?.metric ?? null;
}

function formatRunLine(run: ReconstructedRun, baseline: number | null): string {
  const head = `#${run.run} ${padStatus(run.status)} ${formatMetric(run.metric)}${formatDelta(run.metric, baseline)}`;
  const parts = [head, formatDescription(run), ...formatAsiFields(run.asi)];
  return parts.filter(Boolean).join(" | ");
}

function padStatus(status: ReconstructedRun["status"]): string {
  return status.padEnd(STATUS_WIDTH);
}

const STATUS_WIDTH = "checks_failed".length;

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return "—";
  // The summary replaces conversation history, so preserve the persisted
  // number rather than rounding distinct measurements to the same value.
  return String(value);
}

function formatDelta(value: number, baseline: number | null): string {
  if (baseline === null || baseline === 0 || value === baseline) return "";
  const pct = ((value - baseline) / baseline) * 100;
  const sign = pct > 0 ? "+" : "";
  return ` (${sign}${pct.toFixed(1)}%)`;
}

function formatDescription(run: ReconstructedRun): string {
  return run.description ? `desc: ${run.description}` : "";
}

function formatAsiFields(asi: ReconstructedRun["asi"]): string[] {
  if (!asi) return [];
  return [
    formatAsiField(asi, "hypothesis", "hyp"),
    formatAsiField(asi, "next_action_hint", "next"),
    formatAsiField(asi, "rollback_reason", "rollback"),
  ];
}

function formatAsiField(asi: Record<string, unknown>, key: string, label: string): string {
  const value = asi[key];
  if (typeof value !== "string" || value.trim() === "") return "";
  return `${label}: ${value.trim()}`;
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function readTrimmedFile(filePath: string): string {
  return readFileOrEmpty(filePath).trim();
}

export class CompactionLogFormatError extends Error {
  constructor(filePath: string, lineNumber: number) {
    // Do not include JSON.parse errors: they can contain sensitive log data.
    super(`Invalid compaction log record: ${filePath}, line ${lineNumber}. Expected a complete JSON object. Repair the file before retrying.`);
    this.name = "CompactionLogFormatError";
  }
}

export class CompactionSourceReadError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Unable to read compaction source: ${filePath}. Repair the file before retrying.`, { cause });
    this.name = "CompactionSourceReadError";
  }
}

function compactionSourceExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CompactionSourceReadError(filePath, error);
  }
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    // Missing optional sources are allowed, but a dangling symlink is not an
    // absent source. Do not hide permission, directory, or other read failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        fs.lstatSync(filePath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return "";
      }
    }
    throw new CompactionSourceReadError(filePath, error);
  }
}
