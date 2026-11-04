#!/usr/bin/env node
/** Read-only, descriptive comparison of complete repeated-benchmark reports. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve the installed file before a relative import, including hosts that keep
// the npm bin symlink as the main module path. Reuse the runner's own statistics.
const moduleUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));
const { median, OUTPUT_LIMIT_BYTES } = await import(new URL("./repeat-benchmark.mjs", moduleUrl));

export const REPORT_LIMIT_BYTES = 16 * 1024 * 1024;
const USAGE = `Usage: weasley-compare --baseline FILE --candidate FILE --direction lower|higher

Reads successful schema-version-1 weasley-benchmark JSON reports without running
commands or modifying files. Recomputes summaries from the complete trial series.
Writes a descriptive JSON comparison, never a significance test or keep decision.
Exit 0 means a valid comparison, including regressions; invalid arguments exit 2,
invalid/unreadable reports exit 1. Each input is limited to 16 MiB.
`;
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value) => typeof value === "string" && value.length > 0;
const validName = (name) => /^[\w.µ]+$/u.test(name) && name.length <= 128 &&
  !["__proto__", "constructor", "prototype"].includes(name);
const sameNames = (left, right) => JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort());

export function parseComparisonArgs(args) {
  if (args.length === 1 && args[0] === "--help") return null;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--baseline", "--candidate", "--direction"].includes(flag)) throw new Error("Unknown option; use --help");
    const key = flag.slice(2);
    if (own(options, key)) throw new Error(`Duplicate option: ${flag}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
    options[key] = args[index + 1];
  }
  if (!options.baseline || !options.candidate) throw new Error("--baseline and --candidate are required");
  if (!["lower", "higher"].includes(options.direction)) throw new Error("--direction must be lower or higher");
  return options;
}

/** Bounded read even if the input grows after the initial stat. */
export function readReport(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Report must be a regular file");
    if (stat.size > REPORT_LIMIT_BYTES) throw new Error("Report exceeds 16 MiB");
    const chunks = [];
    let bytes = 0;
    while (bytes <= REPORT_LIMIT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, REPORT_LIMIT_BYTES + 1 - bytes));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      bytes += count;
    }
    if (bytes > REPORT_LIMIT_BYTES) throw new Error("Report exceeds 16 MiB");
    const buffer = Buffer.concat(chunks);
    const decoded = buffer.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(buffer)) throw new Error("Report is not valid UTF-8");
    try { return JSON.parse(decoded); }
    catch { throw new Error("Report is not valid JSON"); }
  } finally {
    closeSync(fd);
  }
}

/** Reject partial series and stale summaries, not merely a claimed success flag. */
export function validateReport(report, label = "Report") {
  const require = (condition, message) => { if (!condition) throw new Error(`${label}: ${message}`); };
  require(record(report), "expected an object");
  require(report.schemaVersion === 1, "unsupported schemaVersion");
  require(report.status === "success" && report.error === null, "series must be successful");
  const plan = report.plan;
  require(record(plan) && typeof plan.metric === "string" && validName(plan.metric), "invalid primary metric");
  require(integer(plan.runs, 1, 100) && integer(plan.warmup, 0, 20), "invalid trial plan");
  require(finite(plan.timeoutSeconds) && plan.timeoutSeconds >= 0.001 && plan.timeoutSeconds <= 86400 &&
    plan.outputLimitBytes === OUTPUT_LIMIT_BYTES, "invalid trial limits");
  require(Array.isArray(report.command) && report.command.length > 0 &&
    text(report.command[0]) && report.command.every((arg) => typeof arg === "string"), "invalid command metadata");
  require(text(report.cwd) && record(report.environment) &&
    ["node", "platform", "arch"].every((key) => text(report.environment[key])), "invalid environment metadata");
  require([report.startedAt, report.finishedAt].every((value) => text(value) && Number.isFinite(Date.parse(value))), "invalid timestamps");
  require(record(report.counts) && report.counts.warmupAttempted === plan.warmup &&
    report.counts.warmupCompleted === plan.warmup && report.counts.measuredAttempted === plan.runs &&
    report.counts.measuredCompleted === plan.runs, "incomplete trial counts");
  require(Array.isArray(report.trials) && report.trials.length === plan.warmup + plan.runs, "incomplete trial series");
  let firstMetrics;
  const measured = [];
  for (let index = 0; index < report.trials.length; index++) {
    const trial = report.trials[index];
    const warmup = index < plan.warmup;
    require(record(trial) && trial.phase === (warmup ? "warmup" : "measured") &&
      trial.iteration === (warmup ? index + 1 : index - plan.warmup + 1), "invalid trial order");
    require(trial.status === "success" && trial.exitCode === 0 && trial.signal === null && trial.error === null,
      "unsuccessful trial in successful series");
    require(finite(trial.durationSeconds) && trial.durationSeconds >= 0 &&
      integer(trial.outputBytes, 0, OUTPUT_LIMIT_BYTES), "invalid trial measurements");
    if (warmup) {
      require(trial.metrics === null, "warmup must not contribute metrics");
      continue;
    }
    require(record(trial.metrics), "missing measured metrics");
    const entries = Object.entries(trial.metrics);
    require(entries.length > 0 && entries.length <= 256 && own(trial.metrics, plan.metric) &&
      entries.every(([name, value]) => validName(name) && finite(value)), "invalid measured metrics");
    require(!firstMetrics || sameNames(firstMetrics, trial.metrics), "metric names differ between trials");
    firstMetrics ??= trial.metrics;
    measured.push(trial);
  }
  require(record(report.summary) && sameNames(firstMetrics, report.summary), "summary metric names do not match samples");
  const summary = Object.create(null);
  for (const name of Object.keys(firstMetrics)) {
    const values = measured.map((trial) => trial.metrics[name]);
    const middle = median(values);
    const deviation = median(values.map((value) => Math.abs(value - middle)));
    const recomputed = { count: values.length, median: middle, min: Math.min(...values), max: Math.max(...values),
      mad: Number.isFinite(deviation) ? deviation : null };
    require(record(report.summary[name]) && Object.entries(recomputed).every(([key, value]) =>
      own(report.summary[name], key) && report.summary[name][key] === value), `summary does not match samples for ${name}`);
    summary[name] = recomputed;
  }
  return summary;
}

export function compareReports(baseline, candidate, direction) {
  if (!["lower", "higher"].includes(direction)) throw new Error("Direction must be lower or higher");
  const baselineSummary = validateReport(baseline, "Baseline");
  const candidateSummary = validateReport(candidate, "Candidate");
  if (baseline.plan.metric !== candidate.plan.metric) throw new Error("Primary metric names differ between reports");
  const metric = baseline.plan.metric;
  const before = baselineSummary[metric].median;
  const after = candidateSummary[metric].median;
  const change = after - before;
  // Scale only an overflowing subtraction; preserve close-value differences.
  const ratio = Number.isFinite(change) ? change / Math.abs(before)
    : (after / 2 - before / 2) / (Math.abs(before) / 2);
  const percent = before === 0 ? null : ratio * 100;
  const warnings = [];
  for (const key of ["runs", "warmup", "timeoutSeconds"]) {
    if (baseline.plan[key] !== candidate.plan[key]) warnings.push(`Trial plan differs: ${key}`);
  }
  if (JSON.stringify(baseline.command) !== JSON.stringify(candidate.command)) warnings.push("Command arguments differ");
  if (baseline.cwd !== candidate.cwd) warnings.push("Working directories differ");
  for (const key of ["node", "platform", "arch"]) {
    if (baseline.environment[key] !== candidate.environment[key]) warnings.push(`Environment differs: ${key}`);
  }
  if (!sameNames(baselineSummary, candidateSummary)) warnings.push("Secondary metric names differ");
  if (before === 0) warnings.push("Percentage change is undefined for a zero baseline");
  if (!Number.isFinite(change)) warnings.push("Absolute change is outside the finite numeric range");
  if (percent !== null && !Number.isFinite(percent)) warnings.push("Percentage change is outside the finite numeric range");
  const changePercent = percent !== null && Number.isFinite(percent) ? percent : null;
  return {
    schemaVersion: 1, metric, direction,
    baseline: { ...baselineSummary[metric], runs: baseline.plan.runs, warmup: baseline.plan.warmup },
    candidate: { ...candidateSummary[metric], runs: candidate.plan.runs, warmup: candidate.plan.warmup },
    outcome: before === after ? "unchanged" : (direction === "lower" ? after < before : after > before) ? "improved" : "regressed",
    change: Number.isFinite(change) ? change : null,
    changePercent,
    improvementPercent: changePercent === null ? null : (direction === "lower" ? -changePercent : changePercent),
    warnings,
    interpretation: "Descriptive sample comparison only. No statistical significance, reproducibility, or keep/discard decision is established.",
  };
}

export function main(args) {
  let options;
  try {
    options = parseComparisonArgs(args);
    if (!options) { process.stdout.write(USAGE); return 0; }
  } catch (error) {
    process.stderr.write(`weasley-compare: ${error.message}\n`);
    return 2;
  }
  try {
    const comparison = compareReports(readReport(options.baseline), readReport(options.candidate), options.direction);
    process.stdout.write(JSON.stringify(comparison, null, 2) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`weasley-compare: ${error.message}\n`);
    return 1;
  }
}

function isEntrypoint() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
if (isEntrypoint()) process.exitCode = main(process.argv.slice(2));
