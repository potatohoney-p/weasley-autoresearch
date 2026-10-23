import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { median, parseArgs, parseMetrics } from "../bin/repeat-benchmark.mjs";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/repeat-benchmark.mjs", import.meta.url));

async function fixture(t, script) {
  const cwd = await mkdtemp(join(tmpdir(), "repeat-benchmark-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = join(cwd, "workload with spaces.mjs");
  await writeFile(command, script);
  return { cwd, command };
}

async function run(cwd, args) {
  try {
    return { code: 0, ...await exec(process.execPath, [cli, ...args], { cwd, timeout: 15000 }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function waitForReadyFile(file, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, "utf8");
      if (text.trim()) return text;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("fixture exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture readiness deadline exceeded");
}

const sequence = `
import fs from 'node:fs';
const count = fs.existsSync('counter') ? Number(fs.readFileSync('counter', 'utf8')) : 0;
fs.writeFileSync('counter', String(count + 1));
const values = [999, 8, 2, 5];
console.log('diagnostic text');
console.log('METRIC latency_ms=' + values[count]);
console.log('METRIC throughput=' + (100 - values[count]));
`;

test("repeat CLI excludes warmups and retains every measured sample with median and MAD", async (t) => {
  const { cwd, command } = await fixture(t, sequence);
  const result = await run(cwd, ["--metric", "latency_ms", "--runs", "3", "--warmup", "1", "--report", "report.json", "--", process.execPath, command]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "METRIC latency_ms=5\nMETRIC throughput=95\n");
  const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "success");
  assert.equal(report.plan.runs, 3);
  assert.equal(report.plan.warmup, 1);
  assert.deepEqual(report.counts, { warmupAttempted: 1, warmupCompleted: 1, measuredAttempted: 3, measuredCompleted: 3 });
  assert.deepEqual(report.trials.map((trial) => trial.phase), ["warmup", "measured", "measured", "measured"]);
  assert.deepEqual(report.trials.slice(1).map((trial) => trial.metrics.latency_ms), [8, 2, 5]);
  assert.deepEqual(report.summary.latency_ms, { count: 3, median: 5, min: 2, max: 8, mad: 3 });
  assert.deepEqual(report.command, [process.execPath, command]);
  assert.equal(report.environment.node, process.version);
  assert.equal(report.environment.platform, process.platform);
  assert.ok(report.trials.every((trial) => trial.durationSeconds >= 0));
  assert.equal("env" in report.environment, false);
  assert.equal(JSON.stringify(report).includes("diagnostic text"), false);
});

test("failed measured trials do not emit a partial aggregate and retain the requested denominator", async (t) => {
  const { cwd, command } = await fixture(t, sequence + "if (count === 2) process.exit(7);\n");
  const result = await run(cwd, ["--metric", "latency_ms", "--runs", "5", "--warmup", "1", "--report", "report.json", "--", process.execPath, command]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
  assert.equal(report.status, "failed");
  assert.equal(report.plan.runs, 5);
  assert.deepEqual(report.counts, { warmupAttempted: 1, warmupCompleted: 1, measuredAttempted: 2, measuredCompleted: 1 });
  assert.equal(report.trials.at(-1).exitCode, 7);
  assert.equal(report.summary, null);
  assert.match(report.error, /exit.*7/);
});

test("missing and non-finite measurements fail instead of disappearing from the sample", async (t) => {
  for (const output of ["METRIC other=2", "METRIC latency_ms=NaN", "METRIC latency_ms=1e999", "METRIC latency_ms=Infinity"]) {
    const { cwd, command } = await fixture(t, `console.log(${JSON.stringify(output)});`);
    const result = await run(cwd, ["--metric", "latency_ms", "--runs", "2", "--report", "report.json", "--", process.execPath, command]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
    assert.equal(report.counts.measuredAttempted, 1);
    assert.equal(report.counts.measuredCompleted, 0);
    assert.equal(report.plan.runs, 2);
    assert.equal(report.summary, null);
  }
});

test("CLI options are bounded and malformed requests do not execute workloads", async (t) => {
  const { cwd, command } = await fixture(t, "throw new Error('must not execute');");
  for (const extra of [["--runs", "0"], ["--runs", "101"], ["--runs", "1.5"], ["--warmup", "21"], ["--timeout-seconds", "0"], ["--runs", "2", "--runs", "3"], ["--unknown", "x"]]) {
    const result = await run(cwd, ["--metric", "latency_ms", ...extra, "--", process.execPath, command]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /must not execute/);
  }
  assert.throws(() => parseArgs(["--metric", "__proto__", "--", "node"]), /valid metric/);
  assert.throws(() => parseArgs(["--metric", "x"]), /executable/);
  assert.equal((await run(cwd, ["--help"])).code, 0);
});

test("npm-style bin symlinks invoke the runner rather than silently exiting", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, command } = await fixture(t, "console.log('METRIC x=42');");
  const link = join(cwd, "weasley-benchmark");
  await symlink(cli, link);
  const result = await exec(link, ["--metric", "x", "--runs", "1", "--report", "report.json", "--", process.execPath, command], { cwd });
  assert.equal(result.stdout, "METRIC x=42\n");
  assert.equal(JSON.parse(await readFile(join(cwd, "report.json"), "utf8")).status, "success");
  const preserved = await exec(process.execPath, ["--preserve-symlinks-main", link, "--metric", "x", "--runs", "1", "--", process.execPath, command], { cwd });
  assert.equal(preserved.stdout, "METRIC x=42\n");
});

test("helpers can be imported from stdin without running the CLI or probing a nonexistent entrypoint", () => {
  const moduleUrl = new URL("../bin/repeat-benchmark.mjs", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--input-type=module", "-"], {
    input: `import { median } from ${JSON.stringify(moduleUrl)}; console.log(median([2, 4]));`, encoding: "utf8",
  });
  assert.equal(result, "3\n");
});

test("metric parser rejects ambiguous records and accepts finite decimal forms", () => {
  for (const output of ["METRIC x=1\nMETRIC x=2", "METRIC x=1\nMETRIC y=NaN", "METRIC x=0x10", "METRIC __proto__=2", "METRIC x=1=2"]) {
    assert.throws(() => parseMetrics(output, "x"));
  }
  assert.deepEqual({ ...parseMetrics("METRIC µs=-.5e2\r\nMETRIC x=+0\n", "µs") }, { µs: -50, x: 0 });
  assert.throws(() => parseMetrics(Array.from({ length: 257 }, (_, i) => `METRIC m${i}=1`).join("\n"), "m0"), /256/);
  assert.equal(median([1e308, 1e308]), 1e308);
  assert.equal(median([Number.MIN_VALUE, Number.MIN_VALUE]), Number.MIN_VALUE);
  assert.equal(median([-1e308, 1e308]), 0);
  assert.equal(median([2, 8]), 5);
});

test("changing secondary metric sets invalidates the whole measured series", async (t) => {
  const { cwd, command } = await fixture(t, sequence + "if (count === 1) console.log('METRIC extra=4');");
  const result = await run(cwd, ["--metric", "latency_ms", "--runs", "3", "--report", "report.json", "--", process.execPath, command]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
  assert.equal(report.counts.measuredCompleted, 1);
  assert.equal(report.trials.length, 2);
  assert.match(report.trials[1].error, /names differ/);
  assert.equal(report.summary, null);
});

test("warmup failure stops before any measured trial; warmup metrics are not required", async (t) => {
  const { cwd, command } = await fixture(t, "process.exit(4);");
  const result = await run(cwd, ["--metric", "x", "--runs", "2", "--warmup", "1", "--report", "report.json", "--", process.execPath, command]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
  assert.equal(report.counts.measuredAttempted, 0);
  assert.equal(report.counts.warmupAttempted, 1);
  assert.equal(report.counts.warmupCompleted, 0);
  assert.equal(report.trials[0].phase, "warmup");

  const second = await fixture(t, sequence.replace("console.log('METRIC latency_ms=' + values[count]);", "if (count > 0) console.log('METRIC latency_ms=' + values[count]);"));
  const passing = await run(second.cwd, ["--metric", "latency_ms", "--runs", "3", "--warmup", "1", "--", process.execPath, second.command]);
  assert.equal(passing.code, 0, passing.stderr);
});

test("timeout and combined output bounds fail without emitting a partial aggregate", async (t) => {
  for (const [script, extra, pattern] of [
    ["setInterval(() => {}, 1000);", ["--timeout-seconds", "0.1"], /exceeded.*seconds/],
    ["process.stdout.write('x'.repeat(600000)); process.stderr.write('y'.repeat(600000));", [], /output bytes/],
  ]) {
    const { cwd, command } = await fixture(t, script);
    const result = await run(cwd, ["--metric", "x", "--runs", "2", ...extra, "--report", "report.json", "--", process.execPath, command]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
    assert.equal(report.counts.measuredAttempted, 1);
    assert.equal(report.counts.measuredCompleted, 0);
    assert.match(report.error, pattern);
  }
});

test("argv is literal, stderr cannot supply measurements, and missing executables are reported", async (t) => {
  const { cwd, command } = await fixture(t, "console.log('METRIC x=' + (process.argv[2] === '; touch INJECTED' ? 7 : 0)); console.error('METRIC x=999');");
  const good = await run(cwd, ["--metric", "x", "--runs", "1", "--", process.execPath, command, "; touch INJECTED"]);
  assert.equal(good.code, 0, good.stderr);
  assert.equal(good.stdout, "METRIC x=7\n");
  await assert.rejects(readFile(join(cwd, "INJECTED")), { code: "ENOENT" });
  await writeFile(command, "console.error('METRIC x=999');");
  const stderrOnly = await run(cwd, ["--metric", "x", "--runs", "1", "--", process.execPath, command]);
  assert.equal(stderrOnly.code, 1);
  assert.equal(stderrOnly.stdout, "");
  const missing = await run(cwd, ["--metric", "x", "--report", "missing.json", "--", join(cwd, "missing-executable")]);
  assert.equal(missing.code, 1);
  const report = JSON.parse(await readFile(join(cwd, "missing.json"), "utf8"));
  assert.match(report.error, /Unable to start.*ENOENT/);
});

test("existing reports are not overwritten and report write errors suppress metrics", async (t) => {
  const { cwd, command } = await fixture(t, sequence);
  await writeFile(join(cwd, "report.json"), "existing evidence\n");
  const exists = await run(cwd, ["--metric", "latency_ms", "--runs", "1", "--report", "report.json", "--", process.execPath, command]);
  assert.equal(exists.code, 2);
  assert.equal(await readFile(join(cwd, "report.json"), "utf8"), "existing evidence\n");
  await assert.rejects(readFile(join(cwd, "counter")), { code: "ENOENT" });
  const failedWrite = await run(cwd, ["--metric", "latency_ms", "--runs", "1", "--report", "absent/report.json", "--", process.execPath, command]);
  assert.equal(failedWrite.code, 1);
  assert.equal(failedWrite.stdout, "");
  await writeFile(command, "import fs from 'node:fs'; fs.writeFileSync('raced.json', 'other writer'); console.log('METRIC x=1');");
  const raced = await run(cwd, ["--metric", "x", "--runs", "1", "--report", "raced.json", "--", process.execPath, command]);
  assert.equal(raced.code, 1);
  assert.equal(raced.stdout, "");
  assert.equal(await readFile(join(cwd, "raced.json"), "utf8"), "other writer");
});

test("interrupt writes a failed report and stops before later measured trials", { skip: process.platform === "win32", timeout: 15000 }, async (t) => {
  const { cwd, command } = await fixture(t, "import fs from 'node:fs'; fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);");
  const child = spawn(process.execPath, [cli, "--metric", "x", "--runs", "3", "--report", "report.json", "--", process.execPath, command], { cwd });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const close = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  await waitForReadyFile(join(cwd, "ready"), child);
  child.kill("SIGINT");
  assert.equal(await close, 1);
  assert.equal(stdout, "");
  const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
  assert.equal(report.error, "Interrupted");
  assert.equal(report.counts.measuredAttempted, 1);
  assert.equal(report.counts.measuredCompleted, 0);
});

for (const detached of [false, true]) {
  test(`timeout completes and escalates cleanup with detached descendant=${detached}`, { skip: process.platform === "win32", timeout: 15000 }, async (t) => {
    const { cwd, command } = await fixture(t, "");
    const descendant = join(cwd, "descendant.mjs");
    await writeFile(descendant, "import fs from 'node:fs'; fs.writeFileSync('descendant.pid', String(process.pid)); process.on('SIGTERM', () => {}); setTimeout(() => fs.writeFileSync('survived', 'yes'), 2000); setInterval(() => {}, 1000);");
    await writeFile(command, `import { spawn } from 'node:child_process'; import fs from 'node:fs'; fs.writeFileSync('parent.pid', String(process.pid)); const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: ${detached}, stdio: ${JSON.stringify(detached ? "inherit" : "ignore")} }); child.unref(); setInterval(() => {}, 1000);`);
    let descendantPid;
    try {
      const child = spawn(process.execPath, [cli, "--metric", "x", "--runs", "2", "--timeout-seconds", "1", "--report", "report.json", "--", process.execPath, command], { cwd });
      t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.resume();
      const completed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
      descendantPid = Number(await waitForReadyFile(join(cwd, "descendant.pid"), child));
      let deadline;
      try {
        assert.equal(await Promise.race([completed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("runner did not settle after timeout cleanup")), 3000); })]), 1);
      } finally { clearTimeout(deadline); }
      assert.equal(output, "");
      const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
      assert.equal(report.counts.measuredAttempted, 1);
      assert.equal(report.counts.measuredCompleted, 0);
      assert.match(report.error, /exceeded 1 seconds/);
      if (!detached) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await assert.rejects(readFile(join(cwd, "survived")), { code: "ENOENT" });
      }
    } finally {
      // The detached fixture deliberately escapes cleanup. Never leak it.
      if (!descendantPid) { try { descendantPid = Number(await readFile(join(cwd, "descendant.pid"), "utf8")); } catch {} }
      if (Number.isInteger(descendantPid) && descendantPid > 1) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
      try {
        const parentPid = Number(await readFile(join(cwd, "parent.pid"), "utf8"));
        if (Number.isInteger(parentPid) && parentPid > 1) process.kill(-parentPid, "SIGKILL");
      } catch {}
    }
  });
}

test("measure.sh feeds the repeat median through run_experiment and log_experiment", async (t) => {
  const { cwd, command } = await fixture(t, sequence.replaceAll("'counter'", "'.auto/counter'"));
  await exec("git", ["init", "--quiet"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "--quiet", "-m", "workload"], { cwd });
  await mkdir(join(cwd, ".auto"));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(cwd, ".auto", "measure.sh"), `#!/usr/bin/env bash\nset -euo pipefail\n${quote(process.execPath)} ${quote(cli)} --metric latency_ms --runs 3 --warmup 1 --report .auto/trials.json -- ${quote(process.execPath)} ${quote(command)}\n`);
  const tools = new Map();
  const commands = new Map();
  let active = [];
  autoresearchExtension({
    on() {}, registerShortcut() {}, appendEntry() {}, sendUserMessage() {},
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => active, setActiveTools: (next) => { active = next; },
    async exec(command, args, options = {}) {
      try { return { code: 0, ...await exec(command, args, { cwd: options.cwd ?? cwd }) }; }
      catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    },
  });
  const ctx = { cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => [] }, ui: { notify() {}, setWidget() {} } };
  const call = (name, params) => tools.get(name).execute("test", params, undefined, undefined, ctx);
  await commands.get("autoresearch").handler("repeat benchmark", ctx);
  await call("init_experiment", { name: "repeat benchmark", metric_name: "latency_ms", metric_unit: "ms" });
  const measured = await call("run_experiment", { command: "bash .auto/measure.sh" });
  assert.equal(measured.details.passed, true);
  assert.equal(measured.details.parsedPrimary, 5);
  assert.deepEqual(measured.details.parsedMetrics, { latency_ms: 5, throughput: 95 });
  const logged = await call("log_experiment", { commit: "unknown", status: "keep", metric: measured.details.parsedPrimary, metrics: { throughput: 95 }, description: "median of three trials", asi: { trial_report: ".auto/trials.json" } });
  assert.equal(logged.details.experiment.metric, 5);
  const entries = (await readFile(join(cwd, ".auto", "log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.at(-1).metric, 5);
  assert.equal(entries.at(-1).asi.trial_report, ".auto/trials.json");
});
