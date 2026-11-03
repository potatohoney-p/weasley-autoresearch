import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);
// Above V8's argument limit: history must not become a function's argument list.
const LARGE_HISTORY = 200_000;

async function fixture(t, { direction = "lower", count = LARGE_HISTORY, hooks = true, kept = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-large-history-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (args) => exec("git", args, { cwd });
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(cwd, ".gitignore"), ".auto/\n");
  await git(["add", ".gitignore"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  await mkdir(join(cwd, ".auto/hooks"), { recursive: true });
  if (hooks) for (const stage of ["before", "after"]) {
    await writeFile(join(cwd, `.auto/hooks/${stage}.sh`), `#!/bin/bash\ncat > .auto/${stage}.json\n`, { mode: 0o755 });
  }
  const best = direction === "lower" ? -7 : 200;
  const records = [
    { type: "config", name: "old segment", bestDirection: direction },
    { run: 1, metric: direction === "lower" ? -1000 : 1000, status: "keep" },
    { type: "config", name: "current segment", metricName: "score", bestDirection: direction },
    ...Array.from({ length: count }, (_, i) => ({
      run: i + 2, metric: i === count - 1 ? best : 100, status: kept ? "keep" : "discard",
    })),
  ];
  const log = join(cwd, ".auto/log.jsonl");
  await writeFile(log, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const tools = new Map(), commands = new Map(), handlers = new Map(), messages = [];
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, appendEntry() {},
    sendUserMessage: (message) => messages.push(message),
    getActiveTools: () => [], setActiveTools() {},
    async exec(command, args, options) {
      try { return { code: 0, ...await exec(command, args, options) }; }
      catch (error) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
    },
  });
  const ctx = {
    cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
    ui: { notify() {}, setWidget() {} },
  };
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  await handlers.get("session_start")({}, ctx);
  return {
    log, messages, best: kept && count ? best : null, count: count + 1,
    activate: async () => {
      await commands.get("autoresearch").handler("off", ctx);
      return commands.get("autoresearch").handler("resume history", ctx);
    },
    record: () => tools.get("log_experiment").execute("test", {
      commit: "0000000", metric: direction === "lower" ? -5000 : 5000,
      status: "discard", description: "new rejected candidate",
    }, undefined, undefined, ctx),
    payload: async (stage) => JSON.parse(await readFile(join(cwd, `.auto/${stage}.json`), "utf8")),
  };
}

for (const direction of ["lower", "higher"]) {
  test(`activation accepts a ${LARGE_HISTORY}-run ${direction} history and delivers its best kept metric`, async (t) => {
    const h = await fixture(t, { direction });
    const before = await readFile(h.log, "utf8");
    await h.activate();
    const payload = await h.payload("before");
    assert.equal(payload.session.best_metric, h.best);
    assert.equal(payload.session.baseline_metric, 100);
    assert.equal(payload.session.run_count, h.count);
    assert.equal(payload.next_run, h.count + 1);
    assert.equal(payload.session.goal, "current segment");
    assert.equal(h.messages.length, 1);
    assert.ok((await readFile(h.log, "utf8")).startsWith(before), "existing evidence stays intact");
  });

  test(`logging returns the persisted result with a ${LARGE_HISTORY}-run ${direction} history`, async (t) => {
    const h = await fixture(t, { direction });
    const result = await h.record();
    assert.notEqual(result.isError, true);
    assert.equal(result.details.state.results.length, h.count + 1);
    assert.equal(result.details.experiment.description, "new rejected candidate");
    for (const stage of ["after", "before"]) {
      const payload = await h.payload(stage);
      assert.equal(payload.session.best_metric, h.best, "discard and old segment do not change the best");
      assert.equal(payload.session.run_count, h.count + 1);
    }
    const runs = (await readFile(h.log, "utf8")).trim().split("\n").map(JSON.parse).filter((record) => record.run);
    assert.equal(runs.length, h.count + 1);
    assert.equal(runs.at(-1).description, "new rejected candidate");
    assert.equal(runs.filter((record) => record.description === "new rejected candidate").length, 1);
  });
}

test("large histories remain usable even when no hooks are configured", async (t) => {
  const h = await fixture(t, { hooks: false });
  await h.activate();
  const result = await h.record();
  assert.notEqual(result.isError, true);
  assert.equal(result.details.state.results.length, h.count + 1);
  assert.equal(h.messages.length, 1);
});

for (const count of [0, 3]) {
  test(`current segment with ${count} non-kept results reports no best`, async (t) => {
    const h = await fixture(t, { count, kept: false });
    await h.activate();
    assert.equal((await h.payload("before")).session.best_metric, null);
  });
}
