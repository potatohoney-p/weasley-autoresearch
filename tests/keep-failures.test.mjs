import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);

async function fixture(t, failure) {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-keep-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "--quiet"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await writeFile(join(cwd, ".gitignore"), ".auto/\n");
  await writeFile(join(cwd, "candidate.txt"), "original\n");
  await exec("git", ["add", "-A"], { cwd });
  await exec("git", ["commit", "--quiet", "-m", "baseline"], { cwd });
  const tools = new Map();
  const commands = new Map();
  const calls = [];
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const notifications = [];
  const widgets = [];
  let aborted = 0;
  let headReads = 0;
  let intercept;
  let messageIntercept;
  let pauseFailure = false;
  let resumeFailure = false;
  let activeTools = [];
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler), registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {},
    appendEntry(customType, data) {
      if (pauseFailure && data.active === false) throw new Error("injected pause record failure");
      if (resumeFailure && data.active === true) throw new Error("injected resume record failure");
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (...args) => {
      messages.push(args);
      return messageIntercept?.(...args);
    },
    getActiveTools: () => activeTools, setActiveTools: (next) => { activeTools = next; },
    async exec(command, args) {
      calls.push([command, ...args]);
      const intercepted = await intercept?.(command, args);
      if (intercepted) return intercepted;
      if (command === "git") {
        if (args[0] === "rev-parse") headReads++;
        if (failure === "pre-head" && args[0] === "rev-parse") return { code: 128, stdout: "", stderr: "injected initial HEAD failure" };
        if (failure === "add" && args[0] === "add") return { code: 1, stdout: "", stderr: "injected add failure" };
        if (failure === "diff" && args[0] === "diff") return { code: 2, stdout: "", stderr: "injected diff error" };
        if (failure === "commit" && args[0] === "commit") return { code: 1, stdout: "", stderr: "injected commit failure" };
        if (failure === "timeout-before" && args[0] === "commit") return { code: 124, killed: true, stdout: "", stderr: "injected timeout" };
        if (failure === "same-head" && args[0] === "commit") return { code: 0, stdout: "injected success without commit", stderr: "" };
        if (["timeout-after", "throw-after"].includes(failure) && args[0] === "commit") {
          await exec(command, args, { cwd });
          if (failure === "throw-after") throw new Error("injected transport failure after commit");
          return { code: 124, killed: true, stdout: "", stderr: "injected timeout after commit" };
        }
        if (failure === "readback" && args[0] === "rev-parse" && headReads === 2) return { code: 128, stdout: "", stderr: "injected readback failure" };
        if (failure === "invalid-readback" && args[0] === "rev-parse" && headReads === 2) return { code: 0, stdout: "not-a-valid-sha", stderr: "" };
      }
      try {
        const result = await exec(command, args, { cwd });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
      }
    },
  });
  const ctx = {
    cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort() { aborted++; if (pauseFailure) throw new Error("injected abort failure"); },
    sessionManager: { getSessionId: () => cwd, getBranch: () => entries },
    ui: { notify: (...args) => notifications.push(args), setWidget: (_name, widget) => widgets.push(widget) },
  };
  await commands.get("autoresearch").handler("keep failure", ctx);
  const call = async (name, params) => {
    const tool = tools.get(name);
    const result = await tool.execute("test", params, undefined, undefined, ctx);
    assert.doesNotThrow(() => tool.renderResult(result, { expanded: false, isPartial: false }, { fg: (_color, value) => value, bold: (value) => value }), `${name} must render its success or rejection safely`);
    return result;
  };
  await call("init_experiment", { name: "candidate", metric_name: "latency" });
  await writeFile(join(cwd, "candidate.txt"), "candidate\n");
  // Real passing evidence for the modified candidate; fault injection remains in the later Git publication path.
  await call("run_experiment", { command: "exit 0" });
  const head = async () => (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  return {
    cwd, call, calls, head, tools, commands, handlers, ctx, entries, messages, notifications, widgets,
    activeTools: () => activeTools, aborted: () => aborted,
    setFailure: (next) => { failure = next; headReads = 0; },
    setIntercept: (next) => { intercept = next; },
    setMessageIntercept: (next) => { messageIntercept = next; },
    failPause: () => { pauseFailure = true; },
    failResume: (value) => { resumeFailure = value; },
  };
}

const keep = { commit: "0000000", metric: 1, status: "keep", description: "candidate" };
const text = (result) => result.content.map((item) => item.text ?? "").join("\n");

for (const failure of ["pre-head", "add", "diff", "commit", "readback", "append", "timeout-before", "timeout-after", "throw-after", "same-head", "invalid-readback"]) {
  test(`keep does not report a recorded success after ${failure} failure`, async (t) => {
    const h = await fixture(t, failure);
    const before = await h.head();
    const log = join(h.cwd, ".auto", "log.jsonl");
    if (failure === "append") {
      await rename(log, join(h.cwd, ".auto", "log.saved"));
      await mkdir(log);
    }
    const result = await h.call("log_experiment", keep);
    const recorded = await readFile(log, "utf8").catch(() => "");
    t.diagnostic(JSON.stringify({
      failure, headChanged: (await h.head()) !== before,
      commitInvocations: h.calls.filter((args) => args[0] === "git" && args[1] === "commit").length,
      reportedStatus: result.details?.experiment?.status,
      resultCount: result.details?.state?.results.length,
      loggedKeep: recorded.includes('"status":"keep"'),
    }));
    assert.equal(result.details?.experiment, undefined, "a failed or unverified keep must not be returned as a logged experiment");
    assert.equal(result.isError, true);
    assert.equal(recorded.includes('"status":"keep"'), false);
    assert.equal(recorded.includes('"type":"hook"'), false);
    if (["pre-head", "add", "diff", "commit", "timeout-before", "same-head"].includes(failure)) assert.equal(await h.head(), before);
    if (["readback", "invalid-readback", "append", "timeout-after", "throw-after"].includes(failure)) assert.notEqual(await h.head(), before);
    assert.equal(await readFile(join(h.cwd, "candidate.txt"), "utf8"), "candidate\n", "never roll back user edits");
    if (["pre-head", "add", "diff"].includes(failure)) {
      assert.equal(h.calls.some((args) => args[1] === "commit"), false);
      assert.equal(h.aborted(), 0);
      const state = (await h.call("init_experiment", { name: "after failure", metric_name: "latency" })).details.state;
      assert.equal(state.results.length, 0);
      assert.equal(state.currentSegment, 0, "no failed keep was published into the runtime");
    } else {
      assert.equal(h.aborted(), 1);
      assert.equal(h.activeTools().includes("log_experiment"), false);
      assert.equal(h.entries.at(-1).data.active, false);
      const count = h.calls.length;
      for (const [tool, params] of [
        ["log_experiment", keep], ["log_experiment", { ...keep, status: "discard" }],
        ["init_experiment", { name: "retry", metric_name: "latency" }],
        ["run_experiment", { command: "echo should-not-run" }],
      ]) {
        assert.match(text(await h.call(tool, params)), /reconcile.*explicitly resume/);
      }
      assert.equal(h.calls.length, count, "queued callbacks cannot automatically retry an uncertain keep");
    }
    assert.doesNotThrow(() => h.tools.get("log_experiment").renderResult(result, {}, {}));
  });
}

test("changed and unchanged keeps use verified HEAD and publish one result each", async (t) => {
  const h = await fixture(t);
  h.ctx.hasUI = true;
  const before = await h.head();
  const first = await h.call("log_experiment", keep);
  const after = await h.head();
  assert.notEqual(after, before);
  assert.equal(first.details.experiment.commit, after.slice(0, 7));
  assert.equal(first.details.state.results.length, 1);
  assert.match(text(first), /Git: committed/);
  const existingWidget = h.widgets.at(-1)({ terminal: { columns: 120, rows: 40 } }, { fg: (_color, value) => value, bold: (value) => value });
  await h.call("run_experiment", { command: "exit 0" });
  const second = await h.call("log_experiment", { ...keep, description: "second candidate" });
  assert.equal(second.details.experiment.commit, after.slice(0, 7));
  assert.equal(second.details.state.results.length, 2);
  assert.match(text(second), /nothing to commit; using current HEAD/);
  assert.equal(h.calls.filter((args) => args[1] === "commit").length, 1);
  assert.match(existingWidget.render(120).join("\n"), /second candidate/, "existing dashboard retains the same published state object");
  const entries = (await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.filter((entry) => entry.status === "keep").map((entry) => entry.run), [1, 2]);
});

for (const failure of [
  { stage: "after", kind: "invocation" },
  { stage: "after", kind: "synchronous steering" },
  { stage: "after", kind: "asynchronous steering" },
  { stage: "before", kind: "synchronous steering" },
  { stage: "before", kind: "asynchronous steering" },
]) {
  test(`unchanged keep remains recorded after ${failure.stage} hook ${failure.kind} fails`, async (t) => {
    const h = await fixture(t);
    // The shared fixture starts with a modified candidate. Restore it before
    // benchmarking so this specifically exercises the no-new-commit path.
    await writeFile(join(h.cwd, "candidate.txt"), "original\n");
    const before = await h.head();
    assert.equal((await exec("git", ["status", "--porcelain"], { cwd: h.cwd })).stdout, "");
    await writeFile(join(h.cwd, ".auto/checks.sh"), "printf 'checks passed\\n'\n");
    const benchmark = { command: "sleep 0.02; printf 'METRIC latency=1\\n'" };
    const run = await h.call("run_experiment", benchmark);
    assert.equal(run.details.exitCode, 0);
    assert.equal(run.details.passed, true);
    assert.equal(run.details.checksPass, true);
    assert.ok(run.details.durationSeconds > 0, "use a real, timed passing benchmark");

    await mkdir(join(h.cwd, ".auto/hooks"), { recursive: true });
    const hookPath = join(h.cwd, `.auto/hooks/${failure.stage}.sh`);
    const steering = `${failure.stage} hook steering`;
    await writeFile(hookPath, `printf '${steering}\\n'\n`, { mode: 0o755 });
    let injectedFailures = 0;
    const message = `injected ${failure.stage} hook ${failure.kind} failure`;
    if (failure.kind === "invocation") {
      const originalSpawn = childProcess.spawn;
      t.mock.method(childProcess, "spawn", (command, args, options) => {
        if (command === "bash" && args?.length === 1 && args[0] === hookPath && options?.cwd === h.cwd) {
          injectedFailures++;
          throw new Error(message);
        }
        return originalSpawn(command, args, options);
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    } else {
      h.setMessageIntercept((value, options) => {
        if (value !== steering || options?.deliverAs !== "steer") return;
        injectedFailures++;
        if (failure.kind === "asynchronous steering") return Promise.reject(new Error(message));
        throw new Error(message);
      });
    }

    const result = await h.call("log_experiment", keep);
    assert.equal(injectedFailures, 1, "the intended post-publication failure must actually execute");
    assert.notEqual(result.isError, true, "a follow-up failure cannot undo a recorded keep");
    assert.equal(result.details.experiment.status, "keep");
    assert.equal(result.details.experiment.commit, before.slice(0, 7));
    assert.equal(result.details.state.results.length, 1);
    assert.equal(result.details.wallClockSeconds, run.details.durationSeconds);
    assert.match(text(result), /nothing to commit; using current HEAD/);
    const warningLabel = `${failure.stage === "after" ? "After" : "Before"} hook${failure.kind === "invocation" ? "" : " steering"} failed:`;
    assert.ok(text(result).includes(`⚠️ ${warningLabel} ${message}`), "report the specific failed follow-up as a warning");
    assert.equal(await h.head(), before);
    assert.equal(h.calls.some((args) => args[0] === "git" && args[1] === "commit"), false);
    assert.equal(h.aborted(), 0, "a published keep does not require manual reconciliation");
    assert.equal(h.activeTools().includes("log_experiment"), true);

    const loggedKeeps = async () => (await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse).filter((entry) => entry.status === "keep");
    const recorded = await loggedKeeps();
    assert.equal(recorded.length, 1, "exactly one keep is durable before any subsequent log call");
    assert.equal(recorded[0].commit, before.slice(0, 7));
    assert.equal(recorded[0].run, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result.details.state.results)), recorded.map(({ run: _run, ...entry }) => entry));

    h.setMessageIntercept(undefined);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    h.messages.length = 0;
    // Integrated evidence policy consumes the run even when a post-log hook fails.
    const repeated = await h.call("log_experiment", { ...keep, description: "explicit second keep" });
    assert.match(text(repeated), /run_experiment must complete successfully/);
    assert.equal(repeated.details.experiment, undefined);
    assert.equal((await loggedKeeps()).length, 1, "rejected duplicate keep leaves durable outcome unchanged");
    assert.equal(await h.head(), before);

    await writeFile(join(h.cwd, "candidate.txt"), "next candidate\n");
    const nextRun = await h.call("run_experiment", benchmark);
    assert.equal(nextRun.details.passed, true);
    assert.equal(nextRun.details.checksPass, true);
    const next = await h.call("log_experiment", { ...keep, metric: 1, description: "fresh benchmark keep" });
    assert.notEqual(next.isError, true);
    assert.equal(next.details.state.results.length, 2);
    assert.equal(next.details.wallClockSeconds, nextRun.details.durationSeconds);
    assert.notEqual(await h.head(), before);
    assert.equal(next.details.experiment.commit, (await h.head()).slice(0, 7));
    assert.equal(h.calls.filter((args) => args[0] === "git" && args[1] === "commit").length, 1);
    assert.doesNotMatch(text(next), /hook(?: steering)? failed:/);
    assert.deepEqual((await loggedKeeps()).map((entry) => entry.run), [1, 2]);
    assert.ok(h.messages.some(([value, options]) => value === steering && options?.deliverAs === "steer"),
      "the real hook and steering still work after removing the fault");
  });
}

test("failed keeps do not count toward automatic continuation or fire success hooks", async (t) => {
  const h = await fixture(t, "diff");
  await mkdir(join(h.cwd, ".auto/hooks"), { recursive: true });
  await writeFile(join(h.cwd, ".auto/hooks/after.sh"), "echo fired >> .auto/hook-fired\n", { mode: 0o755 });
  h.messages.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.call("log_experiment", keep);
  await h.handlers.get("agent_end")({}, h.ctx);
  t.mock.timers.tick(1000);
  assert.equal(h.messages.length, 0, "a rejected keep must not count as a completed experiment");
  assert.equal(fs.existsSync(join(h.cwd, ".auto/hook-fired")), false);
  t.mock.timers.reset();
  h.setFailure(undefined);
  await h.call("log_experiment", keep);
  assert.equal(await readFile(join(h.cwd, ".auto/hook-fired"), "utf8"), "fired\n", "the fixture's success hook actually executes");
});

test("repairing a known pre-commit failure allows retry without consuming a result", async (t) => {
  const h = await fixture(t, "diff");
  await h.call("log_experiment", { ...keep, metrics: { extra_ms: 3 } });
  assert.equal((await exec("git", ["show", ":candidate.txt"], { cwd: h.cwd })).stdout, "candidate\n", "staging is preserved after diff failure");
  h.setFailure(undefined);
  const result = await h.call("log_experiment", keep);
  assert.equal(result.details.state.results.length, 1);
  assert.deepEqual(result.details.state.secondaryMetrics, [], "rejected metrics are not published");
});

test("an append that writes then throws remains uncertain and blocks duplicate retry", async (t) => {
  const h = await fixture(t);
  const original = fs.appendFileSync;
  t.mock.method(fs, "appendFileSync", (path, data, ...args) => {
    original(path, data, ...args);
    if (String(data).includes('"status":"keep"')) throw new Error("injected error after append");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await h.call("log_experiment", keep);
  assert.equal(result.details.experiment, undefined);
  assert.equal(result.details.keepOutcome.phase, "append");
  assert.equal(result.details.keepOutcome.commit, await h.head());
  assert.match(text(result), /partial or complete/);
  const logged = await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8");
  assert.equal(logged.split('"status":"keep"').length - 1, 1);
  await h.call("log_experiment", keep);
  assert.equal(await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8"), logged);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  // Manual reconciliation retains the complete record whose commit was verified.
  await h.commands.get("autoresearch").handler("resume reconciled log", h.ctx);
  await writeFile(join(h.cwd, "candidate.txt"), "next candidate\n");
  await h.call("run_experiment", { command: "exit 0" });
  const next = await h.call("log_experiment", { ...keep, metric: 2 });
  assert.equal(next.details.state.results.length, 2);
  assert.equal(next.details.state.bestMetric, 1);
  const runs = (await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.status);
  assert.deepEqual(runs.map((entry) => entry.run), [1, 2]);
});

test("unreadable, malformed or unterminated reconciled logs cannot release uncertainty", async (t) => {
  const h = await fixture(t, "readback");
  await h.call("log_experiment", keep);
  h.setFailure(undefined);
  const log = join(h.cwd, ".auto/log.jsonl");
  const valid = await readFile(log, "utf8");
  for (const invalid of ['{"run":1', '{"run":1}\nnot-json\n', valid.trimEnd()]) {
    await writeFile(log, invalid);
    await h.commands.get("autoresearch").handler("resume", h.ctx);
    assert.deepEqual(h.activeTools(), []);
    assert.match(text(await h.call("log_experiment", keep)), /uncertain/);
    assert.match(h.notifications.at(-1)[0], /reconciled.*log/i);
  }
  await rm(log);
  await h.commands.get("autoresearch").handler("resume", h.ctx);
  assert.deepEqual(h.activeTools(), []);
  assert.match(text(await h.call("log_experiment", keep)), /uncertain/);
  await writeFile(log, valid);
  await h.commands.get("autoresearch").handler("resume", h.ctx);
  await h.call("run_experiment", { command: "exit 0" });
  assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
});

test("pause record and abort failures do not restore tools or claim success", async (t) => {
  const h = await fixture(t, "timeout-after");
  h.failPause();
  const result = await h.call("log_experiment", keep);
  assert.equal(result.details.experiment, undefined);
  assert.match(text(result), /Could not persist session pause/);
  assert.match(text(result), /Could not abort current loop/);
  assert.deepEqual(h.activeTools(), []);
  assert.match(text(await h.call("log_experiment", keep)), /uncertain/);
});

test("an uncertain keep cancels a previously scheduled auto-resume", async (t) => {
  const h = await fixture(t);
  await h.call("log_experiment", keep);
  await writeFile(join(h.cwd, "candidate.txt"), "second candidate\n");
  await h.call("run_experiment", { command: "exit 0" });
  h.messages.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.handlers.get("agent_end")({}, h.ctx);
  h.setFailure("timeout-before");
  await h.call("log_experiment", keep);
  t.mock.timers.tick(1000);
  assert.equal(h.messages.length, 0);
  t.mock.timers.reset();
});

test("failed clear preserves uncertainty; successful explicit clear releases it", async (t) => {
  const h = await fixture(t);
  const log = join(h.cwd, ".auto/log.jsonl");
  await rename(log, join(h.cwd, ".auto/log.saved"));
  await mkdir(log);
  await h.call("log_experiment", keep);
  await h.commands.get("autoresearch").handler("clear", h.ctx);
  assert.match(h.notifications.at(-1)[0], /Failed to delete/);
  assert.match(text(await h.call("log_experiment", keep)), /uncertain/);
  await rm(log, { recursive: true });
  await h.commands.get("autoresearch").handler("clear", h.ctx);
  assert.equal((await h.call("init_experiment", { name: "new session", metric_name: "latency" })).details.state.results.length, 0);
});

test("explicit resume after manual reconciliation releases the uncertainty latch", async (t) => {
  const h = await fixture(t, "readback");
  await h.call("log_experiment", keep);
  h.setFailure(undefined); // Real commit exists and the worktree is clean.
  await h.commands.get("autoresearch").handler("resume reconciled candidate", h.ctx);
  assert.equal(h.activeTools().includes("log_experiment"), true);
  await h.call("run_experiment", { command: "exit 0" });
  const result = await h.call("log_experiment", keep);
  assert.equal(result.details.state.results.length, 1);
  assert.equal(result.details.experiment.commit, (await h.head()).slice(0, 7));
});

test("failed activation during explicit reconciliation keeps tools and retries blocked", async (t) => {
  const h = await fixture(t, "readback");
  await h.call("log_experiment", keep);
  h.setFailure(undefined);
  h.failResume(true);
  await h.commands.get("autoresearch").handler("resume", h.ctx);
  assert.deepEqual(h.activeTools(), []);
  assert.match(text(await h.call("log_experiment", keep)), /uncertain/);
  assert.match(h.notifications.at(-1)[0], /Could not resume/);
  h.failResume(false);
  await h.commands.get("autoresearch").handler("resume", h.ctx);
  await h.call("run_experiment", { command: "exit 0" });
  assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
});

test("pending log rejects other statuses, init, run, clear and restart while off remains available", async (t) => {
  const h = await fixture(t);
  let release;
  let entered;
  const pending = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  h.setIntercept(async (command, args) => {
    if (command === "git" && args[0] === "add") { entered(); await gate; }
  });
  const first = h.call("log_experiment", keep);
  await pending;
  try {
    for (const status of ["keep", "discard", "crash", "checks_failed"]) {
      assert.match(text(await h.call("log_experiment", { ...keep, status })), /in progress/);
    }
    assert.match(text(await h.call("init_experiment", { name: "bad", metric_name: "bad" })), /in progress/);
    assert.match(text(await h.call("run_experiment", { command: "echo bad" })), /in progress/);
    const log = await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8");
    await h.commands.get("autoresearch").handler("clear", h.ctx);
    assert.equal(await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8"), log);
    await h.commands.get("autoresearch").handler("off", h.ctx);
    assert.deepEqual(h.activeTools(), []);
    await h.commands.get("autoresearch").handler("restart", h.ctx);
    assert.deepEqual(h.activeTools(), []);
    assert.match(h.notifications.at(-1)[0], /in progress/);
  } finally {
    release();
  }
  assert.equal((await first).details.state.results.length, 1);
  await h.call("run_experiment", { command: "exit 0" });
  assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 2, "busy lock is released");
});

for (const status of ["discard", "crash", "checks_failed"]) {
  test(`${status} pauses after real checkout failure without cleaning or claiming rollback`, async (t) => {
    const h = await fixture(t);
    await writeFile(join(h.cwd, "untracked.txt"), "must survive failed checkout\n");
    await writeFile(join(h.cwd, ".git", "index.lock"), "test lock\n");
    const result = await h.call("log_experiment", { ...keep, status });
    assert.equal(result.isError, true);
    assert.doesNotMatch(text(result), /Git: reverted changes/);
    assert.equal(await readFile(join(h.cwd, "candidate.txt"), "utf8"), "candidate\n");
    assert.equal(await readFile(join(h.cwd, "untracked.txt"), "utf8"), "must survive failed checkout\n");
    assert.equal(h.aborted(), 1);
    const logBefore = await readFile(join(h.cwd, ".auto", "log.jsonl"), "utf8");
    assert.equal(logBefore.split('\n').filter(line => line && JSON.parse(line).status === status).length, 1);
    assert.equal((await h.call("log_experiment", { ...keep, status })).isError, true);
    assert.equal(await readFile(join(h.cwd, ".auto", "log.jsonl"), "utf8"), logBefore);
  });
}

for (const failure of ["exit", "killed", "throw"]) {
  test(`rollback ${failure} stops continuation while retaining the recorded outcome`, async (t) => {
    const h = await fixture(t);
    h.setIntercept((command, args) => {
      if (command !== "bash" || !args[1]?.includes("git checkout")) return;
      if (failure === "throw") throw new Error("rollback transport failure");
      return { code: failure === "exit" ? 1 : 0, killed: failure === "killed", stdout: "", stderr: "rollback failed" };
    });
    const result = await h.call("log_experiment", { ...keep, status: "discard" });
    assert.equal(result.isError, true);
    assert.doesNotMatch(text(result), /Git: reverted changes/);
    assert.equal(result.details.experiment.status, "discard");
    assert.equal(result.details.state.results.length, 1);
    assert.equal(result.details.rollbackOutcome.ok, false);
    const rendered = h.tools.get("log_experiment").renderResult(result, { expanded: false, isPartial: false }, { fg: (_color, value) => value, bold: (value) => value }).render(120).join("\n");
    assert.match(rendered, /Git rollback did not complete/);
    assert.match(rendered, /Do not repeat\s+log_experiment/);
    assert.equal(h.aborted(), 1);
    const callsBefore = h.calls.length;
    assert.equal((await h.call("run_experiment", { command: "echo no" })).isError, true);
    assert.equal((await h.call("init_experiment", { name: "no", metric_name: "latency" })).isError, true);
    assert.equal(h.calls.length, callsBefore);
  });
}

test("successful rollback preserves session files and does not pause", async (t) => {
  const h = await fixture(t);
  await writeFile(join(h.cwd, "untracked.txt"), "experiment\n");
  await writeFile(join(h.cwd, ".auto", "ideas.md"), "retained\n");
  const result = await h.call("log_experiment", { ...keep, status: "discard" });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /Git: reverted changes/);
  assert.equal(await readFile(join(h.cwd, "candidate.txt"), "utf8"), "original\n");
  assert.equal(fs.existsSync(join(h.cwd, "untracked.txt")), false);
  assert.equal(await readFile(join(h.cwd, ".auto", "ideas.md"), "utf8"), "retained\n");
  assert.equal(h.aborted(), 0);
});

test("partial rollback pauses despite pause callback failures and never calls after hooks", async (t) => {
  const h = await fixture(t);
  await mkdir(join(h.cwd, ".auto", "hooks"));
  await writeFile(join(h.cwd, ".auto", "hooks", "after.sh"), "#!/bin/sh\necho hook-ran > hook-marker\n", { mode: 0o755 });
  h.setIntercept(async (command, args) => {
    if (command !== "bash" || !args[1]?.includes("git checkout")) return;
    await exec("git", ["checkout", "--", "candidate.txt"], { cwd: h.cwd });
    return { code: 1, stdout: "", stderr: "injected clean failure after checkout" };
  });
  h.failPause();
  const result = await h.call("log_experiment", { ...keep, status: "discard" });
  assert.equal(result.isError, true);
  assert.match(text(result), /Could not persist session pause/);
  assert.match(text(result), /Could not abort current loop/);
  assert.equal(await readFile(join(h.cwd, "candidate.txt"), "utf8"), "original\n");
  assert.equal(fs.existsSync(join(h.cwd, "hook-marker")), false);
  assert.equal((await h.call("log_experiment", keep)).isError, true);
});
