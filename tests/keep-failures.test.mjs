import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
    sendUserMessage: (...args) => messages.push(args),
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
  const head = async () => (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  return {
    cwd, call, calls, head, tools, commands, handlers, ctx, entries, messages, notifications, widgets,
    activeTools: () => activeTools, aborted: () => aborted,
    setFailure: (next) => { failure = next; headReads = 0; },
    setIntercept: (next) => { intercept = next; },
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
  const second = await h.call("log_experiment", { ...keep, description: "second candidate" });
  assert.equal(second.details.experiment.commit, after.slice(0, 7));
  assert.equal(second.details.state.results.length, 2);
  assert.match(text(second), /nothing to commit; using current HEAD/);
  assert.equal(h.calls.filter((args) => args[1] === "commit").length, 1);
  assert.match(existingWidget.render(120).join("\n"), /second candidate/, "existing dashboard retains the same published state object");
  const entries = (await readFile(join(h.cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.filter((entry) => entry.status === "keep").map((entry) => entry.run), [1, 2]);
});

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
  h.messages.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.handlers.get("agent_end")({}, h.ctx);
  h.setFailure("timeout-before");
  await writeFile(join(h.cwd, "candidate.txt"), "second candidate\n");
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
  assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 2, "busy lock is released");
});
