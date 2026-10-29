import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import autoresearchExtension from '../extensions/weasley-autoresearch/index.ts';
import { autoresearchSummaryPathsFor, buildAutoresearchCompactionSummary } from '../extensions/weasley-autoresearch/compaction.ts';

const log = JSON.stringify({ type: 'config', name: 'Preserved goal', metricName: 'time', bestDirection: 'lower' }) + '\n' + JSON.stringify({ run: 1, commit: 'abc1234', metric: 42, status: 'keep', description: 'baseline', timestamp: 1, metrics: {} }) + '\n';
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-compaction-read-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.auto'));
  fs.writeFileSync(path.join(cwd, '.auto', 'log.jsonl'), log);
  fs.writeFileSync(path.join(cwd, '.auto', 'prompt.md'), 'Preserve these rules.');
  fs.writeFileSync(path.join(cwd, '.auto', 'ideas.md'), 'Preserve this idea.');
  return cwd;
}
function breakSource(cwd, name) {
  const file = path.join(cwd, '.auto', name);
  const previous = fs.readFileSync(file);
  fs.unlinkSync(file); fs.mkdirSync(file);
  return () => { fs.rmdirSync(file); fs.writeFileSync(file, previous); };
}
const event = { preparation: { firstKeptEntryId: 'keep-entry', tokensBefore: 12345 } };
async function harness(cwd, active = true) {
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['-c', 'user.name=Test Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd });
  const handlers = new Map(); const notices = []; const sent = [];
  let activeTools = [];
  autoresearchExtension({
    on: (name, callback) => handlers.set(name, callback),
    registerTool() {}, registerCommand() {}, registerShortcut() {}, appendEntry() {},
    getActiveTools: () => activeTools,
    setActiveTools: value => { activeTools = value; },
    sendUserMessage: value => sent.push(value),
  });
  const ctx = {
    cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => cwd, getBranch: () => active ? [] : [{ type: 'custom', customType: 'weasley-autoresearch.activation', data: { version: 1, workDir: cwd, active: false } }] },
    ui: { setWidget() {}, notify: (message, level) => notices.push({ message, level }) },
  };
  await handlers.get('session_start')({}, ctx);
  return { ctx, notices, sent, handlers, compact: () => handlers.get('session_before_compact')(event, ctx) };
}

for (const name of ['log.jsonl', 'prompt.md', 'ideas.md']) {
  test(`summary refuses unreadable ${name} instead of silently omitting persisted state`, t => {
    const cwd = fixture(t); breakSource(cwd, name);
    assert.throws(() => buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd)), /compaction.*source|source.*compaction/i);
    assert.equal(fs.statSync(path.join(cwd, '.auto', name)).isDirectory(), true);
  });
  test(`registered compaction cancels unreadable ${name} and retries after external repair`, async t => {
    const cwd = fixture(t); const h = await harness(cwd); const repair = breakSource(cwd, name);
    const failed = await h.compact();
    assert.deepEqual(failed, { cancel: true });
    assert.match(h.notices.at(-1).message, /compaction.*cancel/i);
    assert.equal(h.notices.at(-1).level, 'error');
    assert.deepEqual(h.sent, []);
    repair(); const result = await h.compact();
    assert.equal(result.cancel, undefined);
    assert.equal(result.compaction.firstKeptEntryId, 'keep-entry');
    assert.equal(result.compaction.tokensBefore, 12345);
    assert.match(result.compaction.summary, /Goal: Preserved goal/);
    assert.match(result.compaction.summary, /Runs so far: 1/);
    assert.match(result.compaction.summary, /Preserve these rules/);
    assert.match(result.compaction.summary, /Preserve this idea/);
    assert.equal(fs.readFileSync(path.join(cwd, '.auto', 'log.jsonl'), 'utf8'), log);
  });
}
test('absent optional files still produce a summary and inactive sessions do not override compaction', async t => {
  const cwd = fixture(t); const h = await harness(cwd, false);
  breakSource(cwd, 'log.jsonl');
  assert.equal(await h.compact(), undefined);
  fs.rmdirSync(path.join(cwd, '.auto', 'log.jsonl'));
  fs.unlinkSync(path.join(cwd, '.auto', 'prompt.md')); fs.unlinkSync(path.join(cwd, '.auto', 'ideas.md'));
  const summary = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd));
  assert.match(summary, /Runs so far: 0/);
});
test('notification failure cannot turn a canceled compaction into an unhandled extension error', async t => {
  const cwd = fixture(t); const h = await harness(cwd); breakSource(cwd, 'log.jsonl');
  h.ctx.hasUI = false;
  h.ctx.ui.notify = () => { throw new Error('notification unavailable'); };
  assert.deepEqual(await h.compact(), { cancel: true });
});

test('dangling source links are not mistaken for absent optional files', { skip: process.platform === 'win32' ? 'symlink privileges differ on Windows' : false }, t => {
  const cwd = fixture(t); const file = path.join(cwd, '.auto', 'log.jsonl');
  fs.unlinkSync(file); fs.symlinkSync('missing-log-target', file);
  assert.throws(() => buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd)), /compaction source/);
  assert.equal(fs.readlinkSync(file), 'missing-log-target');
});
test('non-directory source ancestors fail explicitly rather than becoming empty history', t => {
  const cwd = fixture(t); const parent = path.join(cwd, 'not-a-directory'); fs.writeFileSync(parent, 'untouched');
  const paths = autoresearchSummaryPathsFor(cwd); paths.jsonlPath = path.join(parent, 'log.jsonl');
  assert.throws(() => buildAutoresearchCompactionSummary(paths), /compaction source/);
  assert.equal(fs.readFileSync(parent, 'utf8'), 'untouched');
});
test('cancellation clears pending compaction continuation instead of rescheduling it on agent_end', async t => {
  const cwd = fixture(t); const h = await harness(cwd);
  t.after(() => h.handlers.get('session_shutdown')({}, h.ctx));
  await h.handlers.get('session_compact')({}, h.ctx);
  breakSource(cwd, 'log.jsonl');
  assert.deepEqual(await h.compact(), { cancel: true });
  await h.handlers.get('agent_end')({}, h.ctx);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.deepEqual(h.sent, []);
});

for (const legacy of ['autoresearch.jsonl', 'autoresearch.md', 'autoresearch.ideas.md']) {
  test(`dangling legacy ${legacy} cannot disappear during compaction path selection`, { skip: process.platform === 'win32' ? 'symlink privileges differ on Windows' : false }, t => {
    const cwd = fixture(t); fs.rmSync(path.join(cwd, '.auto'), { recursive: true });
    fs.symlinkSync('missing-target', path.join(cwd, legacy));
    assert.throws(() => buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd)), /compaction source/);
    assert.equal(fs.readlinkSync(path.join(cwd, legacy)), 'missing-target');
  });
}
test('sole dangling current source prevents fallback to readable stale legacy rules', { skip: process.platform === 'win32' ? 'symlink privileges differ on Windows' : false }, t => {
  const cwd = fixture(t); fs.rmSync(path.join(cwd, '.auto'), { recursive: true }); fs.mkdirSync(path.join(cwd, '.auto'));
  fs.symlinkSync('missing-current-rules', path.join(cwd, '.auto', 'prompt.md'));
  fs.writeFileSync(path.join(cwd, 'autoresearch.md'), 'stale legacy rules');
  const paths = autoresearchSummaryPathsFor(cwd);
  assert.equal(paths.mdPath, path.join(cwd, '.auto', 'prompt.md'));
  assert.throws(() => buildAutoresearchCompactionSummary(paths), /compaction source/);
  assert.equal(fs.readFileSync(path.join(cwd, 'autoresearch.md'), 'utf8'), 'stale legacy rules');
});

test('dangling current layout directory cannot fall back to legacy rules', { skip: process.platform === 'win32' ? 'symlink privileges differ on Windows' : false }, t => {
  const cwd = fixture(t); fs.rmSync(path.join(cwd, '.auto'), { recursive: true });
  fs.symlinkSync('missing-current-directory', path.join(cwd, '.auto'));
  fs.writeFileSync(path.join(cwd, 'autoresearch.md'), 'stale legacy rules');
  assert.throws(() => autoresearchSummaryPathsFor(cwd), /compaction source/);
  assert.equal(fs.readlinkSync(path.join(cwd, '.auto')), 'missing-current-directory');
});

for (const invalidLine of ['{"run":2,', 'secret invalid payload', 'null', '[]', '42', '"a string"']) {
  test(`compaction refuses malformed or non-object log record: ${invalidLine}`, async t => {
    const cwd = fixture(t); const h = await harness(cwd);
    const file = path.join(cwd, '.auto', 'log.jsonl');
    const damaged = log + '\n \t\r\n' + invalidLine + '\n';
    fs.writeFileSync(file, damaged);
    assert.throws(() => buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd)), error => {
      assert.match(error.message, /log.*line 5/i);
      assert.ok(!error.message.includes(invalidLine), 'diagnostic must not leak log payload');
      return true;
    });
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.match(h.notices.at(-1).message, /line 5/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
    fs.writeFileSync(file, log);
    assert.match((await h.compact()).compaction.summary, /Runs so far: 1/);
  });
}

test('compaction accepts blank lines, CRLF and complete final object without newline', t => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, '.auto', 'log.jsonl'), '\r\n \t\r\n' + log.trimEnd().replaceAll('\n', '\r\n'));
  assert.match(buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd)), /Runs so far: 1/);
});

test('compaction retains forward-compatible unknown object records without full schema validation', t => {
  const cwd = fixture(t);
  fs.appendFileSync(path.join(cwd, '.auto', 'log.jsonl'), '{"type":"future_metadata","value":1}\n');
  assert.match(buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd)), /Runs so far: 1/);
});

test('malformed legacy log also blocks compaction without rewriting it', t => {
  const cwd = fixture(t); fs.rmSync(path.join(cwd, '.auto'), { recursive: true });
  const file = path.join(cwd, 'autoresearch.jsonl'); fs.writeFileSync(file, log + '{broken');
  assert.throws(() => buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd)), /line 3/);
  assert.equal(fs.readFileSync(file, 'utf8'), log + '{broken');
});

test('malformed logs cancel pending continuation and inactive compaction stays untouched', async t => {
  const cwd = fixture(t); const h = await harness(cwd);
  t.after(() => h.handlers.get('session_shutdown')({}, h.ctx));
  await h.handlers.get('session_compact')({}, h.ctx);
  fs.appendFileSync(path.join(cwd, '.auto', 'log.jsonl'), '{broken');
  assert.deepEqual(await h.compact(), { cancel: true });
  await h.handlers.get('agent_end')({}, h.ctx);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.deepEqual(h.sent, []);
  const inactive = await harness(cwd, false);
  assert.equal(await inactive.compact(), undefined);
});
