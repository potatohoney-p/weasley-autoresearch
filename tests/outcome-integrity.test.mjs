import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
        try { return { code: 0, ...await exec(command, args, { cwd }) }; }
        catch (error) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
      }
      return typeof checks === "function" ? checks(command, args) : checks;
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
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "initial"], { cwd });
  await mkdir(join(cwd, ".auto"));
  return cwd;
}

const keep = { commit: "abcdef0", metric: 1, status: "keep", description: "candidate" };
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

async function assertKeepBlocked(h, pattern) {
  const before = h.gitCalls.length;
  const logPath = join(h.ctx.cwd, ".auto", "log.jsonl");
  const readLog = () => readFile(logPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const logBefore = await readLog();
  const result = await h.call("log_experiment", keep);
  assert.match(text(result), pattern);
  assert.equal(h.gitCalls.length, before, "rejected evidence must not stage or commit files");
  assert.equal(result.details.experiment, undefined);
  assert.deepEqual(await readLog(), logBefore, "rejected evidence must not append to the session log");
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

async function candidateFixture(t) {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "candidate.txt"), "original\n");
  await exec("git", ["add", "candidate.txt"], { cwd });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "candidate"], { cwd });
  return cwd;
}

for (const [name, change] of [
  ["tracked edit", (cwd) => writeFile(join(cwd, "candidate.txt"), "changed\n")],
  ["tracked removal", (cwd) => rm(join(cwd, "candidate.txt"))],
  ["tracked rename", (cwd) => rename(join(cwd, "candidate.txt"), join(cwd, "renamed.txt"))],
  ["untracked addition", (cwd) => writeFile(join(cwd, "new-candidate.txt"), "new\n")],
  ["new checks", (cwd) => writeFile(join(cwd, ".auto", "checks.sh"), "exit 0\n")],
  ["new benchmark", (cwd) => writeFile(join(cwd, ".auto", "measure.sh"), "exit 0\n")],
]) {
  test(`provenance rejects ${name} after a successful benchmark`, async (t) => {
    const cwd = await candidateFixture(t);
    const h = harness(cwd);
    await h.activate();
    await h.call("run_experiment", { command: "exit 0" });
    await change(cwd);
    await assertKeepBlocked(h, /Cannot keep.*candidate.*changed/s);
  });
}

test("provenance rejects benchmark modifications to its own candidate", async (t) => {
  const h = harness(await candidateFixture(t));
  await h.activate();
  const result = await h.call("run_experiment", { command: "printf changed > candidate.txt" });
  assert.match(text(result), /candidate.*changed/s);
  await assertKeepBlocked(h, /Cannot keep.*candidate.*changed/s);
});

test("provenance rejects candidate modifications made by correctness checks", async (t) => {
  const cwd = await candidateFixture(t);
  await writeFile(join(cwd, ".auto", "checks.sh"), "exit 0\n");
  const h = harness(cwd, async () => {
    await writeFile(join(cwd, "candidate.txt"), "changed by checks\n");
    return { code: 0, stdout: "", stderr: "" };
  });
  await h.activate();
  const result = await h.call("run_experiment", { command: "exit 0" });
  assert.match(text(result), /candidate.*changed/s);
  await assertKeepBlocked(h, /Cannot keep.*candidate.*changed/s);
});

test("provenance allows unchanged candidates with mutable session notes", async (t) => {
  const cwd = await candidateFixture(t);
  const h = harness(cwd);
  await h.activate();
  await h.call("init_experiment", { name: "candidate", metric_name: "latency" });
  await h.call("run_experiment", { command: "exit 0" });
  await writeFile(join(cwd, ".auto", "ideas.md"), "new idea\n");
  await writeFile(join(cwd, ".auto", "prompt.md"), "session notes\n");
  assert.equal((await h.call("log_experiment", keep)).details.experiment.status, "keep");
});

test("provenance covers repository files outside a nested working directory", async (t) => {
  const cwd = await candidateFixture(t);
  const subdir = join(cwd, "subdir");
  await mkdir(subdir);
  const h = harness(subdir);
  await h.activate();
  await h.call("run_experiment", { command: "exit 0" });
  await writeFile(join(cwd, "candidate.txt"), "changed outside workdir\n");
  await assertKeepBlocked(h, /Cannot keep.*candidate.*changed/s);
});

for (const script of [".auto/measure.sh", "autoresearch.sh"]) {
  test(`provenance preserves the ordinary ${script} workflow`, async (t) => {
    const cwd = await candidateFixture(t);
    await writeFile(join(cwd, script), "exit 0\n");
    const h = harness(cwd);
    await h.activate();
    const run = await h.call("run_experiment", { command: `bash ${script}` });
    assert.equal(run.details.passed, true);
    assert.equal((await h.call("log_experiment", keep)).details.experiment.status, "keep");
  });
}

for (const invoked of ["autoresearch.sh", "nested/.auto/measure.sh"]) {
  test(`provenance fingerprints invoked ${invoked} when current controls coexist`, async (t) => {
    const cwd = await candidateFixture(t);
    await mkdir(join(cwd, "nested", ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto", "measure.sh"), "exit 0\n");
    await writeFile(join(cwd, invoked), "exit 0\n");
    const h = harness(cwd);
    await h.activate();
    assert.equal((await h.call("run_experiment", { command: `bash ${invoked}` })).details.passed, true);
    await writeFile(join(cwd, invoked), "exit 1\n");
    await assertKeepBlocked(h, /Cannot keep.*candidate.*changed/s);
  });
}

test("a provenance rejection leaves counters unchanged and a fresh run can be kept", async (t) => {
  const cwd = await candidateFixture(t);
  const h = harness(cwd);
  await h.activate();
  await h.call("run_experiment", { command: "exit 0" });
  await writeFile(join(cwd, "candidate.txt"), "new candidate\n");
  await assertKeepBlocked(h, /Cannot keep.*candidate.*changed/s);
  await h.call("run_experiment", { command: "exit 0" });
  const result = await h.call("log_experiment", keep);
  assert.equal(result.details.state.results.length, 1);
});

for (const flag of ["assume-unchanged", "skip-worktree"]) {
  test(`provenance rejects ${flag} before run and keep without changing index flags`, async (t) => {
    const cwd = await candidateFixture(t);
    const h = harness(cwd);
    await h.activate();
    await h.call("run_experiment", { command: "exit 0" });
    await exec("git", ["update-index", `--${flag}`, "candidate.txt"], { cwd });
    await assertKeepBlocked(h, new RegExp(`Cannot keep.*${flag}`, "s"));
    const index = await readFile(join(cwd, ".git", "index"));
    const run = await h.call("run_experiment", { command: "printf ran > unexpected.txt" });
    assert.match(text(run), new RegExp(`Cannot run_experiment.*${flag}`, "s"));
    await assert.rejects(readFile(join(cwd, "unexpected.txt")), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(cwd, ".git", "index")), index);
    await exec("git", ["update-index", `--no-${flag}`, "candidate.txt"], { cwd });
    await assertKeepBlocked(h, /Cannot keep.*run_experiment/s);
    await h.call("run_experiment", { command: "exit 0" });
    assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
  });
}

test("post-check capture failure cannot certify a candidate even after restoration", async (t) => {
  const cwd = await candidateFixture(t);
  await writeFile(join(cwd, ".auto", "checks.sh"), "exit 0\n");
  const file = join(cwd, "candidate.txt");
  const h = harness(cwd, async () => {
    await rm(file);
    await mkdir(file);
    return { code: 0, stdout: "", stderr: "" };
  });
  await h.activate();
  const result = await h.call("run_experiment", { command: "exit 0" });
  assert.equal(result.details.passed, false);
  assert.match(text(result), /cannot verify candidate provenance.*Unsupported candidate file kind/s);
  await rm(file, { recursive: true });
  await writeFile(file, "original\n");
  await assertKeepBlocked(h, /Cannot keep.*cannot verify candidate provenance/s);
});

for (const unreadable of [false, true]) {
  test(`observed pre-keep ${unreadable ? "capture failure" : "edit"} requires a new run after restoration`, async (t) => {
    const cwd = await candidateFixture(t);
    const file = join(cwd, "candidate.txt");
    const h = harness(cwd);
    await h.activate();
    await h.call("run_experiment", { command: "exit 0" });
    if (unreadable) {
      await rm(file);
      await mkdir(file);
    } else {
      await writeFile(file, "changed\n");
    }
    const failure = unreadable ? /Cannot keep.*cannot verify candidate provenance/s : /Cannot keep.*candidate.*changed/s;
    await assertKeepBlocked(h, failure);
    if (unreadable) await rm(file, { recursive: true });
    await writeFile(file, "original\n");
    await assertKeepBlocked(h, failure);
    await h.call("run_experiment", { command: "exit 0" });
    assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
  });
}
