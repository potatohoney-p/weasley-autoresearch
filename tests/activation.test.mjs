import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import autoresearchExtension, {
  shouldAutoActivateAutoresearch,
} from "../extensions/weasley-autoresearch/index.ts";

const ACTIVATION_ENTRY = "weasley-autoresearch.activation";
const AUTORESEARCH_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];
const execFileAsync = promisify(execFile);

async function initGit(cwd) {
  await execFileAsync("git", ["init", "--quiet"], { cwd });
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Weasley Tests"], { cwd });
  await execFileAsync("git", ["commit", "--allow-empty", "--quiet", "-m", "initial"], { cwd });
}

function createHarness({ cwd, branch = [], initialActiveTools = [] }) {
  const commands = new Map();
  const handlers = new Map();
  const widgets = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [...initialActiveTools];
  let aborted = false;

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(nextTools) {
      activeTools = [...nextTools];
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
  });

  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {
      aborted = true;
    },
    sessionManager: {
      getSessionId: () => `test:${cwd}`,
      getBranch: () => branch,
    },
    ui: {
      setWidget(name, widget) {
        widgets.push({ name, widget });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return {
    appendedEntries,
    commands,
    handlers,
    ctx,
    notifications,
    sentMessages,
    widgets,
    activeTools: () => activeTools,
    aborted: () => aborted,
  };
}

function activationEntry(workDir, active = true) {
  return {
    type: "custom",
    customType: ACTIVATION_ENTRY,
    data: {
      version: 1,
      workDir,
      active,
    },
  };
}

function staleLogExperimentEntry() {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "log_experiment",
      details: {
        state: {
          results: [
            {
              commit: "abcdef0",
              metric: 12,
              metrics: {},
              status: "crash",
              description: "stale run from deleted log",
              timestamp: Date.now(),
              segment: 0,
              confidence: null,
            },
          ],
          bestMetric: 12,
          bestDirection: "lower",
          metricName: "quote_field_usec",
          metricUnit: "µs",
          secondaryMetrics: [],
          name: "PickPeriod backend quote field optimization",
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
        },
      },
    },
  };
}

async function writeRedirectedSession(cwd, workDir, config = {}) {
  await initGit(workDir);
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "config.json"),
    JSON.stringify({ workingDir: workDir, ...config }) + "\n",
  );
  await mkdir(join(workDir, ".auto"), { recursive: true });
  await writeFile(
    join(workDir, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Redirected research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "crash",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

async function writeSameCwdLog(cwd) {
  await initGit(cwd);
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Same-cwd research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "crash",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

test("same-cwd persisted logs still auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true),
    true,
  );
});

test("missing persisted logs never auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", false),
    false,
  );
});

test("redirected workingDir logs require a pi-session activation", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

test("a recorded manual off keeps same-cwd sessions inactive despite a persisted log", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true, false),
    false,
  );
});

test("a recorded activation reactivates a redirected off decision on later start", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, false),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

test("session startup does not show a redirected workingDir dashboard without a session activation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "weasley-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup activates redirected workingDir dashboards when this pi session activated it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "weasley-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(workDir)],
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(typeof harness.widgets.at(-1)?.widget, "function");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup keeps redirected workingDir inactive when deactivation is latest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "weasley-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(workDir), activationEntry(workDir, false)],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("starting autoresearch binds redirected workingDir activation to the pi session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "weasley-autoresearch-workdir-"));

  try {
    await initGit(workDir);
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ workingDir: workDir }) + "\n",
    );

    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("optimize runtime", harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, true);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(workDir));
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup keeps same-cwd sessions inactive when a manual off is recorded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(cwd, false)],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch off records a manual off decision for same-cwd sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, initialActiveTools: AUTORESEARCH_TOOLS });
    await harness.commands.get("autoresearch").handler("off", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, false);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch clear turns off, deletes the log, and records a manual off decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, initialActiveTools: AUTORESEARCH_TOOLS });
    await harness.commands.get("autoresearch").handler("clear", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(existsSync(join(cwd, ".auto", "log.jsonl")), false);
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, false);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("deleted logs do not leave a stale autoresearch widget from session history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-cwd-"));

  try {
    const harness = createHarness({
      cwd,
      branch: [staleLogExperimentEntry()],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("manual activation refuses a dirty user worktree without changing it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-dirty-"));
  try {
    await initGit(cwd);
    await writeFile(join(cwd, "user-change.txt"), "keep me\n");

    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("optimize runtime", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.appendedEntries.length, 0);
    assert.equal(harness.sentMessages.length, 0);
    assert.match(harness.notifications.at(-1).message, /clean git worktree/i);
    assert.equal(existsSync(join(cwd, "user-change.txt")), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session files do not make an otherwise clean worktree look dirty", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-session-files-"));
  try {
    await initGit(cwd);
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto", "prompt.md"), "# experiment\n");

    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("optimize runtime", harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("malformed config fails closed instead of activating with defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "weasley-autoresearch-bad-config-"));
  try {
    await initGit(cwd);
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto", "config.json"), "{ not json\n");

    const harness = createHarness({ cwd, initialActiveTools: AUTORESEARCH_TOOLS });
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.deepEqual(harness.activeTools(), []);
    assert.match(harness.notifications.at(-1).message, /invalid .*config\.json/i);

    await harness.commands.get("autoresearch").handler("optimize runtime", harness.ctx);
    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.appendedEntries.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

