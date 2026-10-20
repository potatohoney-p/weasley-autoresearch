import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);

async function run(t, source, signal) {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-metrics-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "--quiet"], { cwd });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "initial"], { cwd });
  await writeFile(join(cwd, "benchmark.cjs"), source);
  await exec("git", ["add", "benchmark.cjs"], { cwd });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "benchmark fixture"], { cwd });
  const tools = new Map();
  const commands = new Map();
  let activeTools = [];
  autoresearchExtension({
    on() {}, registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, appendEntry() {}, sendUserMessage() {},
    getActiveTools: () => activeTools,
    setActiveTools: (next) => { activeTools = next; },
  });
  const ctx = {
    cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort() {}, sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
    ui: { notify() {}, setWidget() {} },
  };
  await commands.get("autoresearch").handler("metric capture", ctx);
  await tools.get("init_experiment").execute("init", { name: "capture", metric_name: "latency" }, undefined, undefined, ctx);
  const result = await tools.get("run_experiment").execute("run", { command: "node benchmark.cjs" }, signal, undefined, ctx);
  if (result.details.fullOutputPath) t.after(() => rm(result.details.fullOutputPath, { force: true }));
  const rendered = tools.get("run_experiment").renderResult(result, { expanded: false, isPartial: false }, {
    fg: (_color, value) => value,
  }).render(240).join("\n");
  return { ...result, rendered };
}

test("structured metrics survive later output evicting their display chunks", async (t) => {
  const result = await run(t, `
    const { once } = require("node:events");
    (async () => {
      process.stdout.write("METRIC latency=12.5\\n");
      for (let i = 0; i < 128; i++) {
        if (!process.stdout.write("noise ".repeat(2048) + "\\n")) await once(process.stdout, "drain");
      }
      process.stdout.write("finished\\n");
    })();
  `);
  assert.equal(result.details.passed, true);
  assert.equal(result.details.parsedPrimary, 12.5);
  assert.equal(result.details.parsedMetrics.latency, 12.5);
  assert.doesNotMatch(result.details.tailOutput, /METRIC latency/);
  assert.match(result.details.tailOutput, /finished/);
  assert.match(await readFile(result.details.fullOutputPath, "utf8"), /METRIC latency=12\.5/);
});

test("failed benchmarks still return parsed metrics and expose capture limits", async (t) => {
  const result = await run(t, `
    process.stdout.write("METRIC latency=3\\n" + "x".repeat(5000) + "\\n");
    process.stdout.write("METRIC " + "n".repeat(129) + "=1\\n");
    for (let i = 0; i < 260; i++) process.stdout.write("METRIC n" + i + "=1\\n");
    process.exitCode = 7;
  `);
  assert.equal(result.details.passed, false);
  assert.equal(result.details.exitCode, 7);
  assert.equal(result.details.parsedPrimary, 3);
  assert.deepEqual(result.details.metricLimits, ["lineBytes", "nameChars", "metrics"]);
  const text = result.content.map((part) => part.text ?? "").join("\n");
  assert.match(text, /4096 UTF-8 bytes.*128 characters.*256 distinct metric names/);
  assert.match(result.rendered, /Structured metric capture exceeded/);
});

test("aborted benchmarks reject instead of returning partial parsed metrics", async (t) => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(t, 'process.stdout.write("METRIC latency=1\\n");', controller.signal), /aborted/);
});
