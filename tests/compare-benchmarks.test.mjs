import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { compareReports, parseComparisonArgs, readReport, REPORT_LIMIT_BYTES, validateReport } from "../bin/compare-benchmarks.mjs";
import { median, OUTPUT_LIMIT_BYTES } from "../bin/repeat-benchmark.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/compare-benchmarks.mjs", import.meta.url));
const runner = fileURLToPath(new URL("../bin/repeat-benchmark.mjs", import.meta.url));
function report(values = [8, 10, 12], overrides = {}) {
  const middle = median(values);
  const mad = median(values.map((value) => Math.abs(value - middle)));
  return {
    schemaVersion: 1, status: "success", error: null,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
    command: ["node", "workload.mjs"], cwd: "/worktree",
    environment: { node: "v24.0.0", platform: "linux", arch: "x64" },
    plan: { metric: "x", runs: values.length, warmup: 0, timeoutSeconds: 60, outputLimitBytes: OUTPUT_LIMIT_BYTES },
    counts: { warmupAttempted: 0, warmupCompleted: 0, measuredAttempted: values.length, measuredCompleted: values.length },
    trials: values.map((value, index) => ({ phase: "measured", iteration: index + 1, status: "success", exitCode: 0,
      signal: null, durationSeconds: 0.1, outputBytes: 20, metrics: { x: value }, error: null })),
    summary: { x: { count: values.length, median: middle, min: Math.min(...values), max: Math.max(...values), mad: Number.isFinite(mad) ? mad : null } },
    ...overrides,
  };
}
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "compare-benchmark-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const baseline = join(cwd, "baseline.json");
  const candidate = join(cwd, "candidate.json");
  await writeFile(baseline, JSON.stringify(report()));
  await writeFile(candidate, JSON.stringify(report([6, 8, 10])));
  return { cwd, baseline, candidate };
}
async function run(args) {
  try { return { code: 0, ...await exec(process.execPath, [cli, ...args], { timeout: 5000 }) }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

for (const [direction, outcome, improvement] of [["lower", "improved", 20], ["higher", "regressed", -20]]) {
  test(`directional comparison describes ${outcome} without mutating reports`, () => {
    const baseline = report();
    const candidate = report([6, 8, 10]);
    const saved = JSON.stringify([baseline, candidate]);
    const result = compareReports(baseline, candidate, direction);
    assert.equal(result.outcome, outcome);
    assert.equal(result.change, -2);
    assert.equal(result.changePercent, -20);
    assert.equal(result.improvementPercent, improvement);
    assert.deepEqual(result.baseline, { count: 3, median: 10, min: 8, max: 12, mad: 2, runs: 3, warmup: 0 });
    assert.deepEqual(result.warnings, []);
    assert.match(result.interpretation, /No statistical significance/);
    assert.equal(JSON.stringify([baseline, candidate]), saved);
  });
}

test("unchanged and signed baselines retain direction and meaningful percentages", () => {
  assert.equal(compareReports(report(), report(), "lower").outcome, "unchanged");
  const signed = compareReports(report([-10]), report([-5]), "higher");
  assert.equal(signed.changePercent, 50);
  assert.equal(signed.improvementPercent, 50);
  assert.equal(signed.outcome, "improved");
  const zero = compareReports(report([0]), report([-1]), "lower");
  assert.equal(zero.changePercent, null);
  assert.equal(zero.improvementPercent, null);
  assert.equal(zero.outcome, "improved");
  assert.match(zero.warnings.join("\n"), /zero baseline/);
});

test("unrepresentable arithmetic is explicit and never serializes Infinity or NaN as an unexplained null", () => {
  const large = compareReports(report([-Number.MAX_VALUE]), report([Number.MAX_VALUE]), "higher");
  assert.equal(large.change, null);
  assert.equal(large.changePercent, 200);
  assert.equal(large.outcome, "improved");
  assert.match(large.warnings.join("\n"), /Absolute change/);
  const hugeRatio = compareReports(report([Number.MIN_VALUE]), report([1]), "higher");
  assert.equal(hugeRatio.changePercent, null);
  assert.match(hugeRatio.warnings.join("\n"), /Percentage change/);
  const close = compareReports(report([1]), report([1 + Number.EPSILON]), "higher");
  assert.equal(close.change, Number.EPSILON);
  assert.equal(close.changePercent, Number.EPSILON * 100);
});

const invalidCases = [
  ["unsupported schema", (r) => { r.schemaVersion = 2; }, /schemaVersion/],
  ["failed report", (r) => { r.status = "failed"; }, /successful/],
  ["report error", (r) => { r.error = "hidden failure"; }, /successful/],
  ["empty plan", (r) => { r.plan.runs = 0; }, /trial plan/],
  ["unbounded plan", (r) => { r.plan.runs = 101; }, /trial plan/],
  ["bad timeout", (r) => { r.plan.timeoutSeconds = Infinity; }, /trial limits/],
  ["bad output limit", (r) => { r.plan.outputLimitBytes = 0; }, /trial limits/],
  ["wrong attempted count", (r) => { r.counts.measuredAttempted = 4; }, /trial counts/],
  ["wrong completed count", (r) => { r.counts.measuredCompleted = 2; }, /trial counts/],
  ["missing trial", (r) => { r.trials.pop(); }, /trial series/],
  ["extra trial", (r) => { r.trials.push(r.trials[0]); }, /trial series/],
  ["reordered trial", (r) => { r.trials.reverse(); }, /trial order/],
  ["wrong phase", (r) => { r.trials[0].phase = "warmup"; }, /trial order/],
  ["failed trial", (r) => { r.trials[0].status = "failed"; }, /unsuccessful trial/],
  ["nonzero exit", (r) => { r.trials[0].exitCode = 1; }, /unsuccessful trial/],
  ["signal exit", (r) => { r.trials[0].signal = "SIGTERM"; }, /unsuccessful trial/],
  ["trial error", (r) => { r.trials[0].error = "failed"; }, /unsuccessful trial/],
  ["bad duration", (r) => { r.trials[0].durationSeconds = -1; }, /trial measurements/],
  ["output overflow", (r) => { r.trials[0].outputBytes = OUTPUT_LIMIT_BYTES + 1; }, /trial measurements/],
  ["missing metrics", (r) => { r.trials[0].metrics = null; }, /measured metrics/],
  ["missing primary", (r) => { r.trials[0].metrics = { other: 8 }; }, /measured metrics/],
  ["nonfinite sample", (r) => { r.trials[0].metrics.x = NaN; }, /measured metrics/],
  ["dangerous name", (r) => { r.trials[0].metrics.constructor = 5; }, /measured metrics/],
  ["different secondary names", (r) => { r.trials[1].metrics.y = 5; }, /names differ/],
  ["missing summary", (r) => { r.summary = null; }, /summary metric names/],
  ["stale median", (r) => { r.summary.x.median = 1; }, /summary does not match/],
  ["stale count", (r) => { r.summary.x.count = 2; }, /summary does not match/],
  ["stale MAD", (r) => { r.summary.x.mad = 0; }, /summary does not match/],
  ["stale range", (r) => { r.summary.x.min = 0; }, /summary does not match/],
  ["missing command", (r) => { r.command = []; }, /command metadata/],
  ["bad environment", (r) => { r.environment.platform = null; }, /environment metadata/],
  ["missing timestamp", (r) => { r.finishedAt = null; }, /timestamps/],
];
for (const [name, mutate, pattern] of invalidCases) {
  test(`rejects ${name} rather than presenting an improvement`, () => {
    const candidate = report([1, 2, 3]);
    mutate(candidate);
    assert.throws(() => compareReports(report(), candidate, "lower"), pattern);
  });
}

test("valid warmups are excluded and completed warmup counts and metrics are checked", () => {
  const candidate = report();
  candidate.plan.warmup = 1;
  candidate.counts.warmupAttempted = candidate.counts.warmupCompleted = 1;
  candidate.trials.unshift({ ...candidate.trials[0], phase: "warmup", iteration: 1, metrics: null });
  assert.equal(validateReport(candidate).x.median, 10);
  const result = compareReports(report(), candidate, "lower");
  assert.deepEqual(result.warnings, ["Trial plan differs: warmup"]);
  candidate.trials[0].metrics = { x: 1000000 };
  assert.throws(() => validateReport(candidate), /warmup must not contribute/);
  candidate.trials[0].metrics = null;
  candidate.counts.warmupCompleted = 0;
  assert.throws(() => validateReport(candidate), /incomplete trial counts/);
});

test("changed experimental conditions are visible rather than silently deemed comparable", () => {
  const candidate = report([10]);
  candidate.command = ["node", "another.mjs"];
  candidate.cwd = "/other";
  candidate.environment = { node: "v25.0.0", platform: "darwin", arch: "arm64" };
  candidate.plan.timeoutSeconds = 30;
  candidate.trials[0].metrics.y = 4;
  candidate.summary.y = { count: 1, median: 4, min: 4, max: 4, mad: 0 };
  assert.deepEqual(compareReports(report(), candidate, "lower").warnings, [
    "Trial plan differs: runs", "Trial plan differs: timeoutSeconds", "Command arguments differ",
    "Working directories differ", "Environment differs: node", "Environment differs: platform",
    "Environment differs: arch", "Secondary metric names differ",
  ]);
  candidate.plan.metric = "y";
  assert.throws(() => compareReports(report(), candidate, "lower"), /Primary metric names differ/);
});

test("CLI validates required arguments and never executes a command", async (t) => {
  const { baseline, candidate } = await fixture(t);
  const valid = ["--baseline", baseline, "--candidate", candidate, "--direction", "lower"];
  assert.deepEqual(parseComparisonArgs(valid), { baseline, candidate, direction: "lower" });
  for (const args of [[], valid.slice(0, 4), [...valid, "--direction", "higher"], [...valid, "--runs", "3"],
    [...valid.slice(0, 5), "sideways"], ["--baseline"], ["--help", "--candidate", candidate]]) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
  }
  assert.equal((await run(["--help"])).code, 0);
  const result = await run(valid);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, "improved");
  assert.equal(result.stderr, "");
  const regression = await run([...valid.slice(0, 5), "higher"]);
  assert.equal(regression.code, 0);
  assert.equal(JSON.parse(regression.stdout).outcome, "regressed");
});

test("unreadable, malformed, oversized and non-UTF8 input fails with no comparison or raw payload", async (t) => {
  const { cwd, baseline, candidate } = await fixture(t);
  for (const value of ["{\"SECRET_PAYLOAD\":", Buffer.from([0xff]), JSON.stringify(report([1], { status: "failed" }))]) {
    await writeFile(candidate, value);
    const result = await run(["--baseline", baseline, "--candidate", candidate, "--direction", "lower"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /SECRET_PAYLOAD/);
  }
  await truncate(candidate, REPORT_LIMIT_BYTES + 1);
  assert.throws(() => readReport(candidate), /exceeds 16 MiB/);
  assert.throws(() => readReport(cwd), /regular file/);
  assert.throws(() => readReport(join(cwd, "missing")), /ENOENT/);
});

test("actual repeated-run reports compare read-only, including warmups and secondary metrics", async (t) => {
  const { cwd, baseline, candidate } = await fixture(t);
  const workload = join(cwd, "workload.mjs");
  await writeFile(workload, "console.log('METRIC x=' + process.argv[2]); console.log('METRIC y=7');");
  // Runner requires fresh report destinations, so keep the initial fixtures intact.
  const before = join(cwd, "real-before.json");
  const after = join(cwd, "real-after.json");
  for (const [path, value] of [[before, "10"], [after, "8"]]) {
    await exec(process.execPath, [runner, "--metric", "x", "--runs", "3", "--warmup", "1", "--report", path,
      "--", process.execPath, workload, value], { cwd });
  }
  const bytes = await Promise.all([readFile(before), readFile(after), readFile(baseline), readFile(candidate)]);
  const result = await run(["--baseline", before, "--candidate", after, "--direction", "lower"]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.baseline.count, 3);
  assert.equal(output.baseline.warmup, 1);
  assert.equal(output.improvementPercent, 20);
  assert.deepEqual(output.warnings, ["Command arguments differ"]);
  assert.deepEqual(await Promise.all([readFile(before), readFile(after), readFile(baseline), readFile(candidate)]), bytes);
});

test("npm bin symlinks invoke the comparator and importing does not invoke it", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, baseline, candidate } = await fixture(t);
  const link = join(cwd, "weasley-compare");
  await symlink(cli, link);
  const args = ["--baseline", baseline, "--candidate", candidate, "--direction", "lower"];
  assert.equal(JSON.parse((await exec(link, args)).stdout).outcome, "improved");
  assert.equal(JSON.parse((await exec(process.execPath, ["--preserve-symlinks-main", link, ...args])).stdout).outcome, "improved");
  const imported = execFileSync(process.execPath, ["--input-type=module", "-"], {
    input: `import { compareReports } from ${JSON.stringify(new URL("../bin/compare-benchmarks.mjs", import.meta.url).href)}; console.log(typeof compareReports);`, encoding: "utf8",
  });
  assert.equal(imported, "function\n");
});

test("non-regular FIFO inputs are rejected without waiting for a writer", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, baseline } = await fixture(t);
  const fifo = join(cwd, "pipe.json");
  await exec("mkfifo", [fifo]);
  const result = await run(["--baseline", baseline, "--candidate", fifo, "--direction", "lower"]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /regular file/);
});

test("Unicode metrics, blank argv entries and additive metadata retain compatibility", () => {
  const convert = (r) => {
    r.plan.metric = "latency_µs";
    for (const trial of r.trials) trial.metrics = { "latency_µs": trial.metrics.x };
    r.summary = { "latency_µs": r.summary.x };
    r.command.push("");
    r.extraMetadata = { future: true };
    return r;
  };
  const result = compareReports(convert(report()), convert(report([6, 8, 10])), "lower");
  assert.equal(result.metric, "latency_µs");
  assert.equal(result.improvementPercent, 20);
});

test("metric bounds apply to every measured sample", () => {
  for (const metrics of [
    Object.fromEntries(Array.from({ length: 257 }, (_, index) => [index ? `m${index}` : "x", 1])),
    { x: 1, ["n".repeat(129)]: 2 },
    Object.fromEntries([["x", 1], ["__proto__", 3]]),
  ]) {
    const candidate = report([1]);
    candidate.trials[0].metrics = metrics;
    assert.throws(() => validateReport(candidate), /invalid measured metrics/);
  }
});
