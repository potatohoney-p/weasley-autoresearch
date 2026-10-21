import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);
const replacement = { name: "new throughput goal", metric_name: "throughput", metric_unit: "ops/s", direction: "higher" };

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (args) => exec("git", args, { cwd });
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(cwd, ".gitignore"), ".auto/\nautoresearch.*\n");
  await git(["add", ".gitignore"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  const tools = new Map(), commands = new Map(), handlers = new Map(), entries = [], widgets = [];
  let active = [];
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {},
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage() {},
    getActiveTools: () => active,
    setActiveTools: (next) => { active = next; },
    async exec(command, args, options) {
      try {
        const result = await exec(command, args, options);
        return { code: 0, ...result };
      } catch (error) {
        return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
      }
    },
  });
  const ctx = {
    cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => entries },
    ui: { notify() {}, setWidget: (_name, widget) => widgets.push(widget) },
  };
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  const call = async (name, params) => {
    const result = await tools.get(name).execute("test", params, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    if (name === "log_experiment") entries.push({
      type: "message", message: { role: "toolResult", toolName: name, details: result.details },
    });
    return result;
  };
  const record = async (metric) => {
    await call("run_experiment", { command: "exit 0" });
    return call("log_experiment", { commit: "0000000", metric, status: "keep", description: "baseline" });
  };
  const command = (args) => commands.get("autoresearch").handler(args, ctx);
  await command("start recovery test");
  await call("init_experiment", { name: "old latency goal", metric_name: "latency", metric_unit: "ms", direction: "lower" });
  const old = await record(20);
  assert.equal(old.details.state.results.length, 1);
  return { cwd, call, record, command, old, widgets, lifecycle: (event) => handlers.get(event)({}, ctx) };
}

for (const event of ["session_start", "session_tree"]) {
  test(`${event} recovers a new config-only session instead of cleared result history`, async (t) => {
    const h = await fixture(t);
    await h.command("clear");
    await h.command("start new goal");
    const initialized = await h.call("init_experiment", replacement);
    assert.equal(initialized.details.state.results.length, 0);
    const log = join(h.cwd, ".auto", "log.jsonl");
    const persisted = await readFile(log, "utf8");
    assert.equal(persisted.trim().split("\n").length, 1);

    await h.lifecycle(event);
    assert.equal(await readFile(log, "utf8"), persisted, "recovery must not rewrite the log");
    const recovered = (await h.record(100)).details.state;
    assert.equal(recovered.name, replacement.name);
    assert.equal(recovered.metricName, replacement.metric_name);
    assert.equal(recovered.metricUnit, replacement.metric_unit);
    assert.equal(recovered.bestDirection, replacement.direction);
    assert.equal(recovered.currentSegment, 0);
    assert.equal(recovered.bestMetric, 100, "the new result is the baseline");
    assert.equal(recovered.confidence, null);
    assert.equal(recovered.results.length, 1);
    const lines = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.filter((entry) => entry.run !== undefined).map((entry) => entry.run), [1]);
  });
}

test("legacy config-only logs with hook observations remain authoritative", async (t) => {
  const h = await fixture(t);
  await h.command("clear");
  await h.command("start new goal");
  await h.call("init_experiment", replacement);
  const log = join(h.cwd, "autoresearch.jsonl");
  await rename(join(h.cwd, ".auto", "log.jsonl"), log);
  await writeFile(log, (await readFile(log, "utf8")) + '{"type":"hook","stage":"before","exit_code":0}\n');
  await h.lifecycle("session_start");
  const recovered = (await h.record(100)).details.state;
  assert.equal(recovered.name, replacement.name);
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.bestMetric, 100);
});

test("a successfully read empty log does not resurrect historical results", async (t) => {
  const h = await fixture(t);
  const log = join(h.cwd, ".auto", "log.jsonl");
  await writeFile(log, "");
  await h.lifecycle("session_tree");
  assert.equal(h.widgets.at(-1), undefined, "there is no recovered result dashboard");
  const initialized = (await h.call("init_experiment", replacement)).details.state;
  assert.equal(initialized.currentSegment, 0);
  assert.equal(initialized.results.length, 0);
  assert.equal(await readFile(log, "utf8"), JSON.stringify({
    type: "config", name: replacement.name, metricName: replacement.metric_name,
    metricUnit: replacement.metric_unit, bestDirection: replacement.direction,
  }) + "\n");
});

test("result-bearing logs retain their persisted history across recovery", async (t) => {
  const h = await fixture(t);
  await h.call("init_experiment", replacement);
  await h.lifecycle("session_start");
  const recovered = (await h.record(100)).details.state;
  assert.equal(recovered.name, replacement.name);
  assert.equal(recovered.currentSegment, 1);
  assert.equal(recovered.bestMetric, 100);
  assert.deepEqual(recovered.results.map((result) => result.segment), [0, 1]);
});

test("missing logs preserve legacy history fallback without automatic activation", async (t) => {
  const h = await fixture(t);
  await rename(join(h.cwd, ".auto", "log.jsonl"), join(h.cwd, ".auto", "saved.jsonl"));
  await h.lifecycle("session_start");
  assert.equal(h.widgets.at(-1), undefined);
  await h.command("resume legacy history");
  const initialized = (await h.call("init_experiment", replacement)).details.state;
  assert.equal(initialized.results.length, 1);
  assert.equal(initialized.results[0].metric, h.old.details.state.results[0].metric);
  assert.equal(initialized.currentSegment, 1);
});
