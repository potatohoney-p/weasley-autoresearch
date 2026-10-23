#!/usr/bin/env node
/** Repeat local workloads without turning failed or missing samples into a win. */
import { spawn } from "node:child_process";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const NAME = /^[\w.µ]+$/u;
const DENIED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const USAGE = `Usage: weasley-benchmark --metric NAME [--runs N] [--warmup N]
  [--timeout-seconds N] [--report FILE] -- EXECUTABLE [ARG ...]

Runs a local argv command without a shell. Defaults: 5 measured trials, 0 warmups,
60 seconds per trial. Every measured trial must emit the same finite METRIC names
on stdout, including NAME. Only complete successful series emit median METRICs.
--report writes a new JSON file with every attempted trial, including failures.
Commands run with your permissions and inherited environment. No isolation or
statistical independence is implied. Do not put secrets in command arguments.
`;

function validName(name) {
  return NAME.test(name) && name.length <= 128 && !DENIED_NAMES.has(name);
}

export function parseArgs(args) {
  const options = { metric: null, runs: 5, warmup: 0, timeoutSeconds: 60, report: null, command: [] };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--") {
      options.command = args.slice(index + 1);
      break;
    }
    if (flag === "--help" && args.length === 1) return null;
    if (!["--metric", "--runs", "--warmup", "--timeout-seconds", "--report"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}. Use -- before the executable.`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    const value = args[++index];
    if (!value || value === "--") throw new Error(`Missing value for ${flag}`);
    if (flag === "--metric") options.metric = value;
    else if (flag === "--report") options.report = value;
    else {
      const number = Number(value);
      const minimum = flag === "--warmup" ? 0 : flag === "--timeout-seconds" ? 0.001 : 1;
      const maximum = flag === "--warmup" ? 20 : flag === "--runs" ? 100 : 86400;
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(number) ||
          number < minimum || number > maximum || (flag !== "--timeout-seconds" && !Number.isInteger(number))) {
        throw new Error(`${flag} must be ${flag === "--timeout-seconds" ? "a number" : "an integer"} from ${minimum} to ${maximum}`);
      }
      options[flag === "--runs" ? "runs" : flag === "--warmup" ? "warmup" : "timeoutSeconds"] = number;
    }
  }
  if (!options.metric || !validName(options.metric)) throw new Error("--metric requires a valid metric name (up to 128 characters)");
  if (!options.command.length || !options.command[0]) throw new Error("An executable is required after --");
  return options;
}

export function parseMetrics(output, primary) {
  const metrics = Object.create(null);
  for (const line of output.split(/\r?\n/)) {
    if (!/^METRIC(?:\s|$)/.test(line)) continue;
    const match = /^METRIC[ \t]+([\w.µ]+)=([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[ \t]*$/u.exec(line);
    if (!match || !validName(match[1]) || !Number.isFinite(Number(match[2]))) {
      throw new Error("Malformed or non-finite METRIC record on stdout");
    }
    if (Object.hasOwn(metrics, match[1])) throw new Error(`Duplicate METRIC name: ${match[1]}`);
    if (Object.keys(metrics).length >= 256) throw new Error("More than 256 METRIC names in a trial");
    metrics[match[1]] = Number(match[2]);
  }
  if (!Object.hasOwn(metrics, primary)) throw new Error(`Missing primary METRIC: ${primary}`);
  return metrics;
}

// Splitting the middle sum avoids overflow for two large, finite observations.
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  return Math.sign(lower) === Math.sign(upper)
    ? lower + (upper - lower) / 2
    : lower / 2 + upper / 2;
}

function summarize(trials) {
  const summary = Object.create(null);
  for (const name of Object.keys(trials[0].metrics)) {
    const values = trials.map((trial) => trial.metrics[name]);
    const middle = median(values);
    const mad = median(values.map((value) => Math.abs(value - middle)));
    // Extremes of opposite sign can have an unrepresentable deviation.
    summary[name] = { count: values.length, median: middle, min: Math.min(...values), max: Math.max(...values), mad: Number.isFinite(mad) ? mad : null };
  }
  return summary;
}

async function runTrial(options, cwd, signal, phase, iteration) {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(options.command[0], options.command.slice(1), {
      cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let error = null;
    let bytes = 0;
    const stdout = [];
    let killTimer;
    let stopping = false;
    let finished = false;
    let exitCode = null;
    let exitSignal = null;
    function kill(killSignal) {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, killSignal);
        else child.kill(killSignal);
      } catch { /* It may already have exited. */ }
    }
    function stop(reason) {
      if (stopping || finished) return;
      stopping = true;
      error = reason;
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        // A direct child can close before its descendants stop. Keep escalation
        // alive for the entire grace period, even after receiving child close.
        kill("SIGKILL");
        // Escaped descendants may retain inherited pipe handles indefinitely.
        // Bound our own lifetime without claiming we can terminate those jobs.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish();
      }, 250);
    }
    const onAbort = () => stop("Interrupted");
    const timer = setTimeout(() => stop(`Trial exceeded ${options.timeoutSeconds} seconds`), options.timeoutSeconds * 1000);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const capture = (chunk, isStdout) => {
      const remaining = Math.max(0, OUTPUT_LIMIT_BYTES - bytes);
      bytes += chunk.length;
      if (isStdout && remaining) stdout.push(chunk.subarray(0, remaining));
      if (bytes > OUTPUT_LIMIT_BYTES) stop(`Trial exceeded ${OUTPUT_LIMIT_BYTES} output bytes`);
    };
    child.stdout.on("data", (chunk) => capture(chunk, true));
    child.stderr.on("data", (chunk) => capture(chunk, false));
    child.on("error", (failure) => { error ??= `Unable to start command: ${failure.code ?? failure.message}`; });
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (!error && (exitCode !== 0 || exitSignal)) error = `Command failed with exit code ${exitCode}${exitSignal ? ` (${exitSignal})` : ""}`;
      let metrics = null;
      if (!error && phase === "measured") {
        try { metrics = parseMetrics(Buffer.concat(stdout).toString("utf8"), options.metric); }
        catch (failure) { error = failure.message; }
      }
      done({ phase, iteration, status: error ? "failed" : "success", exitCode, signal: exitSignal,
        durationSeconds: (performance.now() - started) / 1000, outputBytes: bytes, metrics, error });
    }
    child.on("exit", (code, signal) => { exitCode = code; exitSignal = signal; });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (!stopping) finish();
    });
  });
}

export async function runRepeatedBenchmark(options, { cwd = process.cwd(), signal } = {}) {
  const report = {
    schemaVersion: 1, status: "failed", startedAt: new Date().toISOString(), finishedAt: null,
    command: [...options.command], cwd,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    plan: { metric: options.metric, runs: options.runs, warmup: options.warmup, timeoutSeconds: options.timeoutSeconds, outputLimitBytes: OUTPUT_LIMIT_BYTES },
    counts: { warmupAttempted: 0, warmupCompleted: 0, measuredAttempted: 0, measuredCompleted: 0 },
    trials: [], summary: null, error: null,
  };
  let expectedNames;
  for (const [phase, count] of [["warmup", options.warmup], ["measured", options.runs]]) {
    for (let iteration = 1; iteration <= count; iteration++) {
      if (signal?.aborted) { report.error = "Interrupted"; break; }
      const trial = await runTrial(options, cwd, signal, phase, iteration);
      report.trials.push(trial);
      report.counts[`${phase}Attempted`]++;
      if (phase === "measured" && trial.status === "success") {
        const names = Object.keys(trial.metrics).sort().join("\n");
        if (expectedNames !== undefined && names !== expectedNames) {
          trial.status = "failed";
          trial.error = "METRIC names differ between measured trials";
        }
        expectedNames ??= names;
      }
      if (trial.status === "failed") { report.error = trial.error; break; }
      report.counts[`${phase}Completed`]++;
    }
    if (report.error) break;
  }
  if (!report.error) {
    report.summary = summarize(report.trials.filter((trial) => trial.phase === "measured"));
    report.status = "success";
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

export async function main(args) {
  let options;
  try {
    options = parseArgs(args);
    if (!options) { process.stdout.write(USAGE); return 0; }
    if (options.report) {
      // Refuse existing files, directories and dangling symlinks before any workload.
      try { lstatSync(options.report); throw new Error("Report path already exists; choose a new file"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } catch (error) {
    process.stderr.write(`weasley-benchmark: ${error.message}\n`);
    return 2;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const report = await runRepeatedBenchmark(options, { signal: controller.signal });
    if (options.report) {
      // Exclusive creation also protects a destination created during execution.
      writeFileSync(options.report, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    if (report.status !== "success") {
      process.stderr.write(`weasley-benchmark: ${report.error}; completed ${report.counts.measuredCompleted}/${report.plan.runs} measured trials. No aggregate emitted.\n`);
      return 1;
    }
    for (const [name, stats] of Object.entries(report.summary)) process.stdout.write(`METRIC ${name}=${stats.median}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`weasley-benchmark: ${error.message}. No aggregate emitted.\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function isEntrypoint() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Importing helpers from stdin/eval may not have a real entrypoint file.
    return false;
  }
}

if (isEntrypoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
