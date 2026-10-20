import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);

function harness(cwd, checks = { code: 0, stdout: "", stderr: "" }) {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const gitCalls = [];
  let activeTools = [];
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, appendEntry() {}, sendUserMessage() {},
    getActiveTools: () => activeTools,
    setActiveTools: (next) => { activeTools = next; },
    async exec(command, args) {
      if (command === "git") {
        gitCalls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return checks;
    },
  });
  const ctx = {
    cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
    ui: { notify() {}, setWidget() {} },
  };
  return {
    gitCalls, handlers, ctx,
    activate: () => commands.get("autoresearch").handler("test outcome integrity", ctx),
    call: (name, params, signal) => tools.get(name).execute("test", params, signal, undefined, ctx),
  };
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-outcome-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "--quiet"], { cwd });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "initial"], { cwd });
  await mkdir(join(cwd, ".auto"));
  return cwd;
}

const keep = { commit: "abcdef0", metric: 1, status: "keep", description: "candidate" };
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

async function assertKeepBlocked(h, pattern) {
  const before = h.gitCalls.length;
  const result = await h.call("log_experiment", keep);
  assert.match(text(result), pattern);
  assert.equal(h.gitCalls.length, before, "rejected evidence must not stage or commit files");
  assert.equal(result.details.experiment, undefined);
}

test("keep requires a successful current run, including after restart", async (t) => {
  const cwd = await fixture(t);
  const h = harness(cwd);
  await h.activate();
  await assertKeepBlocked(h, /Cannot keep.*run_experiment/s);
  await h.call("run_experiment", { command: "exit 0" });
  const restarted = harness(cwd);
  await restarted.activate();
  await assertKeepBlocked(restarted, /Cannot keep.*run_experiment/s);
});

test("a failed benchmark invalidates earlier successful evidence", async (t) => {
  const h = harness(await fixture(t));
  await h.activate();
  await h.call("run_experiment", { command: "exit 0" });
  const failed = await h.call("run_experiment", { command: "exit 7" });
  assert.equal(failed.details.passed, false);
  await assertKeepBlocked(h, /Cannot keep.*benchmark/s);
});

test("aborted benchmark cannot reuse an earlier passing run", async (t) => {
  const h = harness(await fixture(t));
  await h.activate();
  await h.call("run_experiment", { command: "exit 0" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call("run_experiment", { command: "exit 0" }, controller.signal), /aborted/);
  await assertKeepBlocked(h, /Cannot keep.*run_experiment/s);
});

for (const checks of [
  { code: 1, stdout: "correctness regression", stderr: "" },
  { code: 0, killed: true, stdout: "", stderr: "checks timed out" },
]) {
  test(`checks failure cannot be kept (killed=${!!checks.killed})`, async (t) => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, ".auto", "checks.sh"), "exit 1\n");
    const h = harness(cwd, checks);
    await h.activate();
    const run = await h.call("run_experiment", { command: "exit 0" });
    assert.equal(run.details.checksPass, false);
    await assertKeepBlocked(h, /checks.sh failed/);
    await h.handlers.get("session_start")({}, h.ctx);
    await assertKeepBlocked(h, /Cannot keep.*run_experiment/s);
  });
}

test("passing evidence is consumed once, and a fresh run can be kept", async (t) => {
  const cwd = await fixture(t);
  const h = harness(cwd);
  await h.activate();
  await h.call("run_experiment", { command: "exit 0" });
  const first = await h.call("log_experiment", keep);
  assert.equal(first.details.experiment.status, "keep");
  await assertKeepBlocked(h, /Cannot keep.*run_experiment/s);
  await h.call("run_experiment", { command: "exit 0" });
  const second = await h.call("log_experiment", keep);
  assert.equal(second.details.state.results.length, 2);
  const lines = (await readFile(join(cwd, ".auto", "log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
});

test("new experiment configuration invalidates previous passing evidence", async (t) => {
  const h = harness(await fixture(t));
  await h.activate();
  await h.call("run_experiment", { command: "exit 0" });
  await h.call("init_experiment", { name: "new target", metric_name: "latency" });
  await assertKeepBlocked(h, /Cannot keep.*run_experiment/s);
});
