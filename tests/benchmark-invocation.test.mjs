import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");
const keep = { commit: "abcdef0", metric: 1, status: "keep", description: "candidate" };

async function fixture(t, script = "printf ran > .auto/invoked\nexit 7\n") {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-invocation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "--quiet"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await writeFile(join(cwd, "candidate.txt"), "candidate\n");
  await exec("git", ["add", "candidate.txt"], { cwd });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd });
  await mkdir(join(cwd, ".auto"));
  await writeFile(join(cwd, ".auto", "measure.sh"), script);
  await chmod(join(cwd, ".auto", "measure.sh"), 0o755);
  await writeFile(join(cwd, ".auto", "checks.sh"), "printf checked > .auto/checked\nexit 0\n");
  await writeFile(join(cwd, ".auto", "skip.sh"), "exit 0\n");
  const tools = new Map();
  const commands = new Map();
  const gitCalls = [];
  const checksCalls = [];
  let activeTools = [];
  autoresearchExtension({
    on() {}, registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, appendEntry() {}, sendUserMessage() {},
    getActiveTools: () => activeTools, setActiveTools: (next) => { activeTools = next; },
    async exec(command, args, options) {
      if (command === "git") gitCalls.push(args);
      if (command === "bash") checksCalls.push(args);
      try {
        const { stdout, stderr } = await exec(command, args, options);
        return { code: 0, stdout, stderr };
      } catch (error) {
        return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "", killed: error.killed };
      }
    },
  });
  const ctx = {
    cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort() {}, sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
    ui: { notify() {}, setWidget() {} },
  };
  await commands.get("autoresearch").handler("test benchmark invocation", ctx);
  return {
    cwd, gitCalls, checksCalls,
    call: (name, params) => tools.get(name).execute("test", params, undefined, undefined, ctx),
  };
}

for (const command of [
  "bash -n .auto/measure.sh",
  "bash .auto/measure.sh || true",
  "bash .auto/measure.sh ; true",
  "bash .auto/measure.sh | cat",
  "env --help bash .auto/measure.sh",
  "nice --help bash .auto/measure.sh",
  "nohup --help bash .auto/measure.sh",
  "BASH_ENV=.auto/skip.sh bash .auto/measure.sh",
]) {
  test(`required benchmark rejects a bypass: ${command}`, async (t) => {
    const h = await fixture(t);
    const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: h.cwd })).stdout;
    const index = await readFile(join(h.cwd, ".git", "index"));
    const run = await h.call("run_experiment", { command });
    assert.equal(run.details.passed, false, "an unexecuted or failed benchmark must not become passing evidence");
    assert.match(text(run), /must run|supported.*invocation/i);
    await assert.rejects(access(join(h.cwd, ".auto", "invoked")), { code: "ENOENT" });
    const result = await h.call("log_experiment", keep);
    assert.match(text(result), /Cannot keep.*run_experiment/s);
    assert.equal(result.details.experiment, undefined);
    assert.equal(h.gitCalls.length, 0, "rejection must not stage or commit");
    assert.equal(h.checksCalls.length, 0, "rejection must not run correctness checks");
    await assert.rejects(access(join(h.cwd, ".auto", "checked")), { code: "ENOENT" });
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: h.cwd })).stdout, before);
    assert.deepEqual(await readFile(join(h.cwd, ".git", "index")), index);
    await assert.rejects(access(join(h.cwd, ".auto", "log.jsonl")), { code: "ENOENT" });
  });
}

test("a rejected invocation invalidates prior passing evidence", async (t) => {
  const h = await fixture(t, "exit 0\n");
  assert.equal((await h.call("run_experiment", { command: "bash .auto/measure.sh" })).details.passed, true);
  const rejected = await h.call("run_experiment", { command: "echo unrelated" });
  assert.equal(rejected.details.passed, false);
  const result = await h.call("log_experiment", keep);
  assert.match(text(result), /Cannot keep.*run_experiment/s);
  assert.equal(result.details.experiment, undefined);
  assert.equal(h.gitCalls.length, 0);
  await assert.rejects(access(join(h.cwd, ".auto", "log.jsonl")), { code: "ENOENT" });
  assert.equal((await h.call("run_experiment", { command: "bash .auto/measure.sh" })).details.passed, true);
  const recovered = await h.call("log_experiment", keep);
  assert.equal(recovered.details.experiment.status, "keep");
  assert.equal(recovered.details.state.results.length, 1);
  const entries = (await readFile(join(h.cwd, ".auto", "log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(entries.length, 1);
});

for (const prefix of [
  "bash", "sh -eu --", "source", "", "env RUNS=2 bash",
  "time -p bash", "nice -n 0 bash", "nohup bash",
  "time -p env RUNS=2 LABEL='two words' nice -n 0 nohup bash --",
  "RUNS=2 bash",
]) {
  test(`literal invocation executes the benchmark and preserves arguments: ${prefix || "direct"}`, async (t) => {
    const h = await fixture(t, `#!/usr/bin/env bash
printf '%s\\n' "$@" > .auto/invoked
printf 'METRIC metric=1\\n'
exit 0
`);
    const command = `${prefix} ./.auto/measure.sh 'two words' 'literal | ; $value'`.trim();
    const run = await h.call("run_experiment", { command });
    assert.equal(run.details.passed, true, text(run));
    assert.equal(run.details.checksPass, true);
    assert.equal(h.checksCalls.length, 1);
    assert.equal(await readFile(join(h.cwd, ".auto", "invoked"), "utf8"), "two words\nliteral | ; $value\n");
    assert.equal((await h.call("log_experiment", keep)).details.experiment.status, "keep");
  });
}

test("quoted absolute paths bind the script that actually executes", async (t) => {
  const h = await fixture(t, "exit 0\n");
  const dir = join(h.cwd, ".auto", "researcher's path", ".auto");
  await mkdir(dir, { recursive: true });
  const script = join(dir, "measure.sh");
  await writeFile(script, "printf ran > .auto/invoked\nexit 0\n");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  assert.equal((await h.call("run_experiment", { command: `bash ${quote(script.replaceAll("\\", "/"))}` })).details.passed, true);
  assert.equal(await readFile(join(h.cwd, ".auto", "invoked"), "utf8"), "ran");
  await writeFile(script, "exit 7\n");
  const result = await h.call("log_experiment", keep);
  assert.match(text(result), /Cannot keep.*candidate.*changed/s);
  assert.equal(h.gitCalls.length, 0);
});

test("custom shell commands remain available when no benchmark file exists", async (t) => {
  const h = await fixture(t);
  await rm(join(h.cwd, ".auto", "measure.sh"));
  const run = await h.call("run_experiment", { command: "false || printf custom > .auto/invoked" });
  assert.equal(run.details.passed, true);
  assert.equal(await readFile(join(h.cwd, ".auto", "invoked"), "utf8"), "custom");
  assert.equal((await h.call("log_experiment", keep)).details.experiment.status, "keep");
});

test("an executed failing required benchmark remains failed", async (t) => {
  const h = await fixture(t);
  const run = await h.call("run_experiment", { command: "bash .auto/measure.sh" });
  assert.equal(run.details.exitCode, 7);
  assert.equal(run.details.passed, false);
  assert.equal(await readFile(join(h.cwd, ".auto", "invoked"), "utf8"), "ran");
  assert.equal(h.checksCalls.length, 0);
  const result = await h.call("log_experiment", keep);
  assert.match(text(result), /Cannot keep.*benchmark/s);
  assert.equal(h.gitCalls.length, 0);
  await assert.rejects(access(join(h.cwd, ".auto", "log.jsonl")), { code: "ENOENT" });
});

for (const suffix of ["\r", "\u00a0"]) {
  test(`trailing ${JSON.stringify(suffix)} cannot substitute a different benchmark file`, {
    skip: process.platform === "win32" && suffix === "\r" ? "Windows cannot create a CR-suffixed filename" : false,
  }, async (t) => {
    const h = await fixture(t);
    await writeFile(join(h.cwd, ".auto", `measure.sh${suffix}`), "printf wrong > .auto/wrong\nexit 0\n");
    const run = await h.call("run_experiment", { command: `bash .auto/measure.sh${suffix}` });
    assert.equal(run.details.passed, false);
    await assert.rejects(access(join(h.cwd, ".auto", "wrong")), { code: "ENOENT" });
    assert.match(text(await h.call("log_experiment", keep)), /Cannot keep.*run_experiment/s);
    assert.equal(h.gitCalls.length, 0);
  });
}
