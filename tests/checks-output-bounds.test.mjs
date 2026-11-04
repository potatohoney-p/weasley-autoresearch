import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);
const LIMIT = 4096;
const text = (result) => result.content.map((item) => item.text ?? "").join("\n");
const keep = { commit: "ignored", metric: 1, status: "keep", description: "candidate" };

async function fixture(t, outcome, { checks = true, realChecks = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-checks-output-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (args) => exec("git", args, { cwd });
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(cwd, ".gitignore"), ".auto/\n");
  await writeFile(join(cwd, "candidate.txt"), "candidate\n");
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  await mkdir(join(cwd, ".auto"));
  await writeFile(join(cwd, ".auto", "measure.sh"), 'if [ "$1" = fail ]; then exit 7; fi\nprintf "METRIC latency=1\\n"\n');
  if (checks) await writeFile(join(cwd, ".auto", "checks.sh"), realChecks
    ? `"${process.execPath}" -e 'process.stdout.write("x".repeat(100000) + "REAL_CHECK_FAILURE"); process.exitCode = 7;'\n`
    : "exit 0\n");
  const tools = new Map(), commands = new Map(), handlers = new Map(), entries = [], gitCalls = [];
  let nextOutcome = outcome;
  let checkCalls = 0;
  let active = [];
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, sendUserMessage() {},
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    getActiveTools: () => active, setActiveTools: (next) => { active = next; },
    async exec(command, args, options) {
      if (command === "git") gitCalls.push(args);
      if (command === "bash") {
        checkCalls++;
        if (!realChecks) {
          if (nextOutcome?.throw !== undefined) throw nextOutcome.throw;
          return nextOutcome;
        }
      }
      try { return { code: 0, ...await exec(command, args, options) }; }
      catch (error) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "", killed: error.killed }; }
    },
  });
  const ctx = { cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => entries }, ui: { notify() {}, setWidget() {} } };
  const call = (name, params) => tools.get(name).execute("test", params, undefined, undefined, ctx);
  await commands.get("autoresearch").handler("start output test", ctx);
  await call("init_experiment", { name: "candidate", metric_name: "latency" });
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  return { cwd, git, gitCalls, call, tools, get checkCalls() { return checkCalls; },
    setOutcome: (value) => { nextOutcome = value; },
    run: (suffix = "") => call("run_experiment", { command: `bash .auto/measure.sh${suffix}` }) };
}

function assertBounded(result, suffix, { pass = false, timedOut = false, by = "bytes" } = {}) {
  assert.equal(result.details.passed, pass);
  assert.equal(result.details.checksPass, pass);
  assert.equal(result.details.checksTimedOut, timedOut);
  assert.ok(Buffer.byteLength(result.details.checksOutput, "utf8") <= LIMIT, "check diagnostics exceed byte budget");
  assert.ok(result.details.checksOutput.split("\n").length <= 80);
  assert.ok(result.details.checksOutput.endsWith(suffix), "final diagnostic must remain visible");
  assert.doesNotMatch(result.details.checksOutput, /�/);
  assert.equal(result.details.checksTruncation?.truncatedBy, by);
  assert.equal(result.details.checksTruncation?.outputBytes, Buffer.byteLength(result.details.checksOutput, "utf8"));
  assert.equal("content" in result.details.checksTruncation, false, "metadata must not duplicate output");
  assert.match(text(result), /Checks output truncated/);
  assert.ok(Buffer.byteLength(text(result), "utf8") < LIMIT + 1600, "model response includes unbounded check diagnostics");
}

for (const scenario of ["stdout", "stderr", "combined", "timeout", "error", "string", "success"]) {
  test(`check diagnostics are byte-bounded for ${scenario}`, async (t) => {
    const output = "x".repeat(100000) + "FINAL_DIAGNOSTIC";
    const outcome = { code: scenario === "success" || scenario === "timeout" ? 0 : 7, stdout: output, stderr: "", killed: scenario === "timeout" };
    if (scenario === "stderr") { outcome.stdout = ""; outcome.stderr = output; }
    if (scenario === "combined") { outcome.stdout = output; outcome.stderr = output; }
    if (scenario === "error") outcome.throw = new Error(output);
    if (scenario === "string") outcome.throw = output;
    const h = await fixture(t, outcome);
    const result = await h.run();
    assertBounded(result, "FINAL_DIAGNOSTIC", { pass: scenario === "success", timedOut: scenario === "timeout" });
    assert.equal(h.checkCalls, 1);
    assert.equal(result.details.checksTruncation.totalBytes, Buffer.byteLength(scenario === "combined" ? `${output}\n${output}` : output));
    if (scenario !== "success") {
      const beforeLog = await readFile(join(h.cwd, ".auto", "log.jsonl"));
      const beforeHead = (await h.git(["rev-parse", "HEAD"])).stdout;
      const calls = h.gitCalls.length;
      const denied = await h.call("log_experiment", { ...keep, force: true });
      assert.match(text(denied), /Cannot keep.*checks.sh failed/s);
      assert.match(text(denied), /FINAL_DIAGNOSTIC/);
      assert.equal(denied.details.experiment, undefined);
      assert.equal(h.gitCalls.length, calls);
      assert.equal((await h.git(["rev-parse", "HEAD"])).stdout, beforeHead);
      assert.deepEqual(await readFile(join(h.cwd, ".auto", "log.jsonl")), beforeLog);
    } else {
      assert.equal((await h.call("log_experiment", keep)).details.experiment?.status, "keep");
    }
  });
}

for (const characters of ["한", "😀", "한😀"]) {
  test(`check truncation preserves UTF-8 boundaries for ${characters}`, async (t) => {
    const h = await fixture(t, { code: 7, stdout: characters.repeat(10000) + "END", stderr: "" });
    const result = await h.run();
    assertBounded(result, "END");
    assert.match(result.details.checksOutput, new RegExp(`^(?:${characters === "한😀" ? "한|😀" : characters})+END$`, "u"));
    const denied = text(await h.call("log_experiment", keep));
    assert.equal(denied.isWellFormed(), true, "keep-refusal diagnostic must not split a surrogate pair");
    assert.doesNotMatch(denied, /�/);
    assert.match(denied, /END/);
  });
}

test("line-limited checks disclose omitted diagnostics and keep the last 80 lines", async (t) => {
  const output = Array.from({ length: 120 }, (_, index) => `line-${index}`).join("\n");
  const h = await fixture(t, { code: 7, stdout: output, stderr: "" });
  const result = await h.run();
  assertBounded(result, "line-119", { by: "lines" });
  assert.equal(result.details.checksOutput, output.split("\n").slice(-80).join("\n"));
  assert.equal(result.details.checksTruncation.totalLines, 120);
});

test("ordinary and exact-budget checks retain diagnostics without a truncation warning", async (t) => {
  const h = await fixture(t, { code: 7, stdout: "ordinary stdout", stderr: "ordinary stderr" });
  assert.equal((await h.run()).details.checksOutput, "ordinary stdout\nordinary stderr");
  for (const output of ["ordinary stdout\nordinary stderr", "x".repeat(LIMIT), Array.from({ length: 80 }, () => "line").join("\n")]) {
    h.setOutcome({ code: 7, stdout: output, stderr: "" });
    const result = await h.run();
    assert.equal(result.details.checksOutput, output);
    assert.equal(result.details.checksTruncation, undefined);
    assert.doesNotMatch(text(result), /Checks output truncated/);
  }
});

test("a fresh check result does not inherit truncation or failure evidence", async (t) => {
  const h = await fixture(t, { code: 7, stdout: "x".repeat(10000), stderr: "" });
  assertBounded(await h.run(), "x");
  h.setOutcome({ code: 0, stdout: "short success", stderr: "" });
  const result = await h.run();
  assert.equal(result.details.checksOutput, "short success");
  assert.equal(result.details.checksTruncation, undefined);
  assert.equal(result.details.passed, true);
  assert.equal((await h.call("log_experiment", keep)).details.experiment?.status, "keep");
});

test("missing checks and failed benchmarks retain their existing verdicts", async (t) => {
  for (const checks of [false, true]) {
    const h = await fixture(t, { code: 7, stdout: "must not execute", stderr: "" }, { checks });
    const result = await h.run(checks ? " fail" : "");
    assert.equal(h.checkCalls, 0);
    assert.equal(result.details.checksOutput, "");
    assert.equal(result.details.checksTruncation, undefined);
    assert.equal(result.details.checksPass, null);
    assert.equal(result.details.passed, !checks);
  }
});

test("real failing check subprocess retains a bounded final diagnostic", async (t) => {
  const h = await fixture(t, undefined, { realChecks: true });
  const result = await h.run();
  assertBounded(result, "REAL_CHECK_FAILURE");
  assert.equal(h.checkCalls, 1);
});

for (const timedOut of [false, true]) {
  for (const character of ["x", "😀"]) {
    test(`check renderer discloses bounded diagnostics (timeout=${timedOut}, character=${character})`, async (t) => {
      const h = await fixture(t, { code: timedOut ? 0 : 7, stdout: character.repeat(10000) + "FINAL", stderr: "", killed: timedOut });
      const result = await h.run();
      for (const expanded of [false, true]) {
        const rendered = h.tools.get("run_experiment").renderResult(result, { expanded, isPartial: false }, {
          fg: (_color, value) => value, bold: (value) => value,
        }).render(240).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
        assert.match(rendered, /Checks output truncated/);
        assert.match(rendered, /FINAL/);
        assert.equal(rendered.isWellFormed(), true, "renderer must not split a surrogate pair");
        assert.doesNotMatch(rendered, /�/);
        assert.ok(Buffer.byteLength(rendered, "utf8") < LIMIT + 600);
      }
    });
  }
}
