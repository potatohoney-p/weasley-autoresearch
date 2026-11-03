import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import autoresearchExtension from "../extensions/weasley-autoresearch/index.ts";

const exec = promisify(execFile);
const theme = { fg: (_color, value) => value, bold: (value) => value };
const text = (result) => result.content.map((item) => item.text ?? "").join("\n");

function harness(cwd = ".") {
  const tools = new Map(), commands = new Map(), handlers = new Map(), widgets = [];
  let active = [];
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, appendEntry() {}, sendUserMessage() {},
    getActiveTools: () => active, setActiveTools: (next) => { active = next; },
    async exec(command, args, options) {
      try { return { code: 0, ...await exec(command, args, options) }; }
      catch (error) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
    },
  });
  const ctx = { cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
    ui: { notify() {}, setWidget: (_name, widget) => { if (widget) widgets.push(widget); } } };
  return { tools, commands, handlers, widgets, ctx,
    call: (name, params) => tools.get(name).execute("test", params, undefined, undefined, ctx),
    render: (name, result) => tools.get(name).renderResult(result, { expanded: false, isPartial: false }, theme).render(1000).join("\n") };
}

for (const [value, expected] of [
  [1.999, "2.00"], [999.999, "1,000.00"], [-0.999, "-1.00"], [-999.999, "-1,000.00"],
  [-123, "-123"], [-123456, "-123,456"], [1e21, "1e+21"], [-1e21, "-1e+21"],
  [Number.MAX_VALUE, String(Number.MAX_VALUE)], [0.001, "0.001"], [-0.001, "-0.001"],
  [Number.MIN_VALUE, String(Number.MIN_VALUE)],
  [0, "0"], [-0, "0"], [42, "42"], [12345, "12,345"], [12.25, "12.25"], [-12.25, "-12.25"],
]) {
  test(`run result formats ${value} without losing its sign or rounding carry`, () => {
    const h = harness();
    const rendered = h.render("run_experiment", { content: [], details: {
      durationSeconds: 0, parsedPrimary: value, metricName: "score", metricUnit: "ms", tailOutput: "",
    } });
    assert.ok(rendered.includes(`score: ${expected}ms`), rendered);
  });
}

test("missing primary measurement still omits the metric suffix", () => {
  const h = harness();
  assert.doesNotMatch(h.render("run_experiment", { content: [], details: {
    durationSeconds: 0, parsedPrimary: null, metricName: "score", metricUnit: "", tailOutput: "",
  } }), /score:/);
});

test("real run, log and dashboard use corrected labels without rounding stored measurements", { timeout: 15000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-format-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (args) => exec("git", args, { cwd });
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(cwd, ".gitignore"), ".auto/\n");
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  const h = harness(cwd);
  t.after(() => h.handlers.get("session_shutdown")({}, h.ctx));
  await h.commands.get("autoresearch").handler("test formatting", h.ctx);
  await h.call("init_experiment", { name: "formatting", metric_name: "score", metric_unit: "ms" });
  const measured = await h.call("run_experiment", { command: "printf 'METRIC score=999.999\\nMETRIC tiny=0.001\\nMETRIC signed=-123\\nMETRIC huge=1e21\\n'" });
  assert.equal(measured.details.passed, true, text(measured));
  assert.match(text(measured), /score=1,000\.00ms tiny=0\.001 signed=-123 huge=1e\+21/);
  assert.match(text(measured), /metric: 999\.999/, "machine-ready value stays exact");
  const logged = await h.call("log_experiment", { commit: "0000000", metric: measured.details.parsedPrimary,
    metrics: { tiny: 0.001, signed: -123, huge: 1e21 }, status: "keep", description: "formatted candidate" });
  assert.equal(logged.details.experiment.metric, 999.999);
  assert.match(text(logged), /Baseline score: 1,000\.00ms/);
  assert.match(h.render("log_experiment", logged), /score: 1,000\.00ms/);
  const widget = h.widgets.at(-1)({ terminal: { columns: 180, rows: 40 } }, theme);
  const dashboard = widget.render(180).join("\n");
  assert.match(dashboard, /1,000\.00ms/);
  assert.match(dashboard, /0\.001/);
  assert.doesNotMatch(dashboard, /-,123|1e,\+21/);
  const records = (await readFile(join(cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const record = records.find((entry) => entry.status === "keep");
  assert.equal(record.metric, 999.999);
  assert.deepEqual(record.metrics, { tiny: 0.001, signed: -123, huge: 1e21 });
});
