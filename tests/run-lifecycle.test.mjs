import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);
const keep = { commit: "0000000", metric: 1, status: "keep", description: "candidate" };
const text = (result) => result.content.map((item) => item.text ?? "").join("\n");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, checks = "exit 0\n") {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-run-lifecycle-"));
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
  await writeFile(join(cwd, ".auto", "measure.sh"), [
    'if [ "$1" = fail ]; then exit 7; fi',
    'if [ "$1" = hold ]; then touch .auto/started; while [ ! -f .auto/release ]; do sleep 0.01; done; fi',
    'printf "METRIC latency=1\\n"', "",
  ].join("\n"));
  await writeFile(join(cwd, ".auto", "checks.sh"), checks);
  const tools = new Map(), handlers = new Map(), commands = new Map(), gitCalls = [], entries = [];
  const pendingChecks = [];
  const pendingGit = [];
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
      let result;
      try { result = { code: 0, ...await exec(command, args, options) }; }
      catch (error) { result = { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
      if (command === "bash" && args[0] === join(cwd, ".auto", "checks.sh")) {
        const hold = pendingChecks.shift();
        if (hold) {
          hold.started.resolve();
          await hold.release.promise;
        }
      }
      if (command === "git" && args[0] === "add") {
        const hold = pendingGit.shift();
        if (hold) {
          hold.started.resolve();
          await hold.release.promise;
        }
      }
      return result;
    },
  });
  const ctx = { cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => entries }, ui: { notify() {}, setWidget() {} } };
  const call = (name, params, signal) => tools.get(name).execute("test", params, signal, undefined, ctx);
  const command = (args) => commands.get("autoresearch").handler(args, ctx);
  await command("start lifecycle test");
  await call("init_experiment", { name: "candidate", metric_name: "latency" });
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  const holdCompletion = (queue) => {
    const hold = { started: deferred(), release: deferred() };
    queue.push(hold);
    t.after(() => hold.release.resolve());
    return hold;
  };
  return { cwd, git, gitCalls, call, command, ctx, handlers,
    holdChecks: () => holdCompletion(pendingChecks), holdGit: () => holdCompletion(pendingGit),
    run: (suffix = "", signal) => call("run_experiment", { command: `bash .auto/measure.sh${suffix}` }, signal) };
}

for (const phase of ["pending", "completed"]) {
  test(`an older log completion preserves a newer ${phase} run`, { timeout: 15000 }, async (t) => {
    const h = await fixture(t);
    const first = await h.run();
    const logging = h.holdGit();
    const log = h.call("log_experiment", keep);
    await logging.started.promise;
    const checks = h.holdChecks();
    const latest = h.run().then((result) => ({ result }), (error) => ({ error }));
    await checks.started.promise;
    if (phase === "completed") {
      checks.release.resolve();
      assert.equal((await latest).result?.details.passed, true);
    }
    logging.release.resolve();
    let recorded;
    try { recorded = await log; }
    finally { checks.release.resolve(); }
    const current = await latest;
    assert.equal(current.result?.details.passed, true, current.error?.message);
    assert.equal(recorded.details.wallClockSeconds, first.details.durationSeconds);
    const second = await h.call("log_experiment", keep);
    assert.equal(second.details.experiment?.status, "keep", text(second));
    assert.equal(second.details.state.results.length, 2);
    assert.equal(second.details.wallClockSeconds, current.result.details.durationSeconds);
    await assertKeepBlocked(h);
  });
}

async function assertKeepBlocked(h) {
  const log = join(h.cwd, ".auto", "log.jsonl");
  const readLog = () => readFile(log).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const before = await readLog();
  const head = (await h.git(["rev-parse", "HEAD"])).stdout;
  const index = await readFile(join(h.cwd, ".git", "index"));
  const calls = h.gitCalls.length;
  const result = await h.call("log_experiment", keep);
  assert.equal(result.details.experiment, undefined, "stale evidence must not authorize a keep");
  assert.match(text(result), /Cannot keep/);
  assert.equal(h.gitCalls.length, calls);
  assert.equal((await h.git(["rev-parse", "HEAD"])).stdout, head);
  assert.deepEqual(await readFile(join(h.cwd, ".git", "index")), index);
  assert.deepEqual(await readLog(), before);
}

for (const boundary of ["off", "clear", "init", "session_start", "session_tree", "session_before_switch", "session_shutdown"]) {
  test(`late checks cannot publish evidence after ${boundary}`, { timeout: 15000 }, async (t) => {
    const h = await fixture(t);
    const hold = h.holdChecks();
    const pending = h.run().then((result) => ({ result }), (error) => ({ error }));
    await hold.started.promise;
    try {
      if (boundary === "off" || boundary === "clear") await h.command(boundary);
      else if (boundary === "init") await h.call("init_experiment", { name: "replacement", metric_name: "throughput" });
      else await h.handlers.get(boundary)({}, h.ctx);
    } finally { hold.release.resolve(); }
    const stale = await pending;
    await assertKeepBlocked(h);
    assert.match(stale.error?.message ?? "", /superseded/);
    await h.command("resume lifecycle test");
    if (boundary === "clear" || boundary === "session_shutdown") {
      await h.call("init_experiment", { name: "resumed", metric_name: "latency" });
    }
    assert.equal((await h.run()).details.passed, true);
    assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
  });
}

test("aborting while checks settle cannot publish a successful run", { timeout: 15000 }, async (t) => {
  const h = await fixture(t);
  const hold = h.holdChecks();
  const controller = new AbortController();
  const pending = h.run("", controller.signal).then((result) => ({ result }), (error) => ({ error }));
  await hold.started.promise;
  controller.abort();
  hold.release.resolve();
  const aborted = await pending;
  await assertKeepBlocked(h);
  assert.match(aborted.error?.message ?? "", /aborted/);
  assert.equal((await h.run()).details.passed, true);
  assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
});

test("an older completion cannot authorize a keep while the latest checks are pending", { timeout: 15000 }, async (t) => {
  const h = await fixture(t);
  const first = h.holdChecks();
  const older = h.run().then((result) => ({ result }), (error) => ({ error }));
  await first.started.promise;
  const second = h.holdChecks();
  const latest = h.run();
  await second.started.promise;
  try {
    first.release.resolve();
    const stale = await older;
    await assertKeepBlocked(h);
    assert.match(stale.error?.message ?? "", /superseded/);
  } finally { second.release.resolve(); }
  const current = await latest;
  assert.equal(current.details.passed, true);
  const logged = await h.call("log_experiment", keep);
  assert.equal(logged.details.state.results.length, 1);
  assert.equal(logged.details.wallClockSeconds, current.details.durationSeconds);
});

test("late failing checks cannot erase a newer completed success", { timeout: 15000 }, async (t) => {
  const h = await fixture(t, 'if [ -f .auto/check-seen ]; then exit 0; fi\ntouch .auto/check-seen\nexit 7\n');
  const hold = h.holdChecks();
  const older = h.run().then((result) => ({ result }), (error) => ({ error }));
  await hold.started.promise;
  let current;
  try { current = await h.run(); }
  finally { hold.release.resolve(); }
  assert.equal(current.details.passed, true);
  assert.match((await older).error?.message ?? "", /superseded/);
  const logged = await h.call("log_experiment", keep);
  assert.equal(logged.details.experiment.status, "keep");
  assert.equal(logged.details.wallClockSeconds, current.details.durationSeconds);
  await assertKeepBlocked(h);
});

test("a consumed newer success cannot be resurrected by late passing checks", { timeout: 15000 }, async (t) => {
  const h = await fixture(t);
  const hold = h.holdChecks();
  const older = h.run().then((result) => ({ result }), (error) => ({ error }));
  await hold.started.promise;
  try {
    assert.equal((await h.run()).details.passed, true);
    assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
  } finally { hold.release.resolve(); }
  await older;
  await assertKeepBlocked(h);
});

test("aborting a superseded call cannot revoke the latest passing evidence", { timeout: 15000 }, async (t) => {
  const h = await fixture(t);
  const hold = h.holdChecks();
  const controller = new AbortController();
  const older = h.run("", controller.signal).then((result) => ({ result }), (error) => ({ error }));
  await hold.started.promise;
  let current;
  try {
    current = await h.run();
    controller.abort();
  } finally { hold.release.resolve(); }
  assert.match((await older).error?.message ?? "", /superseded/);
  assert.equal(current.details.passed, true);
  const logged = await h.call("log_experiment", keep);
  assert.equal(logged.details.experiment?.status, "keep", text(logged));
  assert.equal(logged.details.wallClockSeconds, current.details.durationSeconds);
});

test("superseded benchmarks cannot start correctness checks after finishing", { timeout: 15000 }, async (t) => {
  const h = await fixture(t, "touch .auto/checks-ran\n");
  const pending = h.run(" hold").then((result) => ({ result }), (error) => ({ error }));
  const deadline = Date.now() + 5000;
  try {
    while (true) {
      try { await readFile(join(h.cwd, ".auto", "started")); break; }
      catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rejected = await h.call("run_experiment", { command: "bash -n .auto/measure.sh" });
    assert.equal(rejected.details.passed, false);
  } finally { await writeFile(join(h.cwd, ".auto", "release"), ""); }
  const stale = await pending;
  await assertKeepBlocked(h);
  assert.match(stale.error?.message ?? "", /superseded/);
  await assert.rejects(readFile(join(h.cwd, ".auto", "checks-ran")), { code: "ENOENT" });
});

for (const newer of ["failed", "rejected"]) {
  test(`late passing checks cannot supersede a newer ${newer} run attempt`, { timeout: 10000 }, async (t) => {
    const h = await fixture(t);
    const hold = h.holdChecks();
    const older = h.run().then((result) => ({ result }), (error) => ({ error }));
    await hold.started.promise;
    try {
      const next = newer === "failed" ? await h.run(" fail")
        : await h.call("run_experiment", { command: "bash -n .auto/measure.sh" });
      assert.equal(next.details.passed, false);
    } finally { hold.release.resolve(); }
    const stale = await older;
    await assertKeepBlocked(h);
    assert.notEqual(stale.result?.details.passed, true, "superseded calls cannot report passing evidence");
    assert.equal((await h.run()).details.passed, true);
    assert.equal((await h.call("log_experiment", keep)).details.state.results.length, 1);
  });
}
