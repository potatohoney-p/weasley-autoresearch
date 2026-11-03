import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import autoresearchExtension from '../extensions/weasley-autoresearch/index.ts';

const persisted = JSON.stringify({ type: 'config', name: 'persisted goal', metricName: 'score', bestDirection: 'higher' }) + '\n'
  + JSON.stringify({ run: 1, metric: 10, status: 'keep', commit: '1234567', metrics: {}, description: 'persisted baseline', timestamp: 1 }) + '\n';
const staleState = {
  results: [{ metric: 99, status: 'keep', commit: '7654321', metrics: {}, description: 'stale result', timestamp: 1, segment: 0, confidence: null }],
  name: 'stale goal', metricName: 'old_score', metricUnit: '', bestDirection: 'lower', currentSegment: 0,
  secondaryMetrics: [], maxExperiments: null, bestMetric: 99, confidence: null,
};

function fixture(t, legacy = false) {
  const cwd = fs.mkdtempSync(join(tmpdir(), 'autoresearch-recovery-read-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd });
  fs.writeFileSync(join(cwd, '.gitignore'), '.auto/\nautoresearch.*\n');
  execFileSync('git', ['add', '.gitignore'], { cwd });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd });
  const log = legacy ? join(cwd, 'autoresearch.jsonl') : join(cwd, '.auto', 'log.jsonl');
  fs.mkdirSync(join(cwd, '.auto'));
  fs.writeFileSync(log, persisted);
  const handlers = new Map(), tools = new Map(), commands = new Map(), notices = [], widgets = [], sent = [];
  const branch = [{ type: 'message', message: { role: 'toolResult', toolName: 'log_experiment', details: { state: staleState } } }];
  let active = ['bash', 'read', 'run_experiment', 'init_experiment', 'log_experiment'];
  let failHost = false;
  let execCalls = 0;
  autoresearchExtension({
    on: (name, callback) => handlers.set(name, callback),
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command), registerShortcut() {},
    getActiveTools: () => active,
    setActiveTools: next => { if (failHost) throw new Error('host tools unavailable'); active = next; },
    appendEntry(customType, data) { if (failHost) throw new Error('host persistence unavailable'); branch.push({ type: 'custom', customType, data }); },
    sendUserMessage: message => sent.push(message),
    async exec(command, args, options) { execCalls++; return { code: 0, stdout: execFileSync(command, args, { ...options, encoding: 'utf8' }), stderr: '' }; },
  });
  const ctx = {
    cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    abort() { if (failHost) throw new Error('host abort unavailable'); },
    sessionManager: { getSessionId: () => cwd, getBranch: () => branch },
    ui: {
      notify(message, level) { if (failHost) throw new Error('host notification unavailable'); notices.push({ message, level }); },
      setWidget(name, widget) { if (failHost) throw new Error('host widget unavailable'); widgets.push(widget); },
    },
  };
  t.after(() => { failHost = false; return handlers.get('session_shutdown')({}, ctx); });
  const call = (name, params) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  return { cwd, log, ctx, branch, notices, widgets, sent, call, active: () => active, execCalls: () => execCalls,
    failHost: value => { failHost = value; }, lifecycle: event => handlers.get(event)({}, ctx),
    command: arg => commands.get('autoresearch').handler(arg, ctx) };
}

async function assertGuarded(h) {
  const before = h.execCalls();
  for (const [name, params] of [
    ['run_experiment', { command: 'touch SHOULD_NOT_RUN' }],
    ['init_experiment', { name: 'overwrite', metric_name: 'x', direction: 'lower' }],
    ['log_experiment', { metric: 99, status: 'discard', description: 'overwrite', commit: '7654321' }],
  ]) {
    const result = await h.call(name, params);
    assert.equal(result.isError, true, `${name} must be blocked`);
    assert.match(result.content[0].text, /reconcile|recover|repair/i);
  }
  assert.equal(h.execCalls(), before);
  assert.equal(fs.existsSync(join(h.cwd, 'SHOULD_NOT_RUN')), false);
}

for (const legacy of [false, true]) {
  for (const event of ['session_start', 'session_tree']) {
    test(`${event} pauses unreadable ${legacy ? 'legacy' : 'current'} logs instead of activating stale history`, async t => {
      const h = fixture(t, legacy);
      // Queue a continuation before recovery; it must be canceled by failure.
      await h.lifecycle('session_start');
      await h.lifecycle('session_compact');
      fs.unlinkSync(h.log); fs.mkdirSync(h.log);
      await h.lifecycle(event);
      assert.deepEqual(h.active(), ['bash', 'read']);
      assert.equal(h.widgets.at(-1), undefined);
      assert.match(h.notices.at(-1).message, /persisted.*log|session.*log/i);
      assert.equal(h.notices.at(-1).level, 'error');
      await assertGuarded(h);
      await h.command('resume before repair');
      assert.equal(h.sent.length, 0);
      assert.equal(fs.statSync(h.log).isDirectory(), true);
      fs.rmdirSync(h.log); fs.writeFileSync(h.log, persisted);
      await h.lifecycle(event);
      await assertGuarded(h);
      await h.command('resume after repair');
      assert.ok(h.active().includes('run_experiment'));
      const restored = await h.call('init_experiment', { name: 'next segment', metric_name: 'score', direction: 'higher' });
      assert.notEqual(restored.isError, true);
      assert.equal(restored.details.state.results.length, 1);
      assert.equal(restored.details.state.results[0].metric, 10);
      assert.equal(restored.details.state.currentSegment, 1);
      await new Promise(resolve => setTimeout(resolve, 850));
      assert.equal(h.sent.length, 1, 'only explicit resume should send a kickoff');
    });
  }
}

for (const code of ['EACCES', 'EIO']) {
  test(`${code} at read time leaves bytes intact and blocks recovery`, async t => {
    const h = fixture(t);
    const original = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (file === h.log) throw Object.assign(new Error('private payload must not appear'), { code });
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    try { await h.lifecycle('session_start'); }
    finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    assert.deepEqual(h.active(), ['bash', 'read']);
    assert.equal(fs.readFileSync(h.log, 'utf8'), persisted);
    assert.doesNotMatch(h.notices.at(-1).message, /private payload/);
    await assertGuarded(h);
  });
}

for (const legacy of [false, true]) {
  test(`dangling ${legacy ? 'legacy' : 'current'} log links cannot select stale fallback`, { skip: process.platform === 'win32' }, async t => {
    const h = fixture(t, legacy);
    fs.unlinkSync(h.log); fs.symlinkSync('missing-target', h.log);
    if (!legacy) fs.writeFileSync(join(h.cwd, 'autoresearch.jsonl'), persisted.replaceAll('10', '99'));
    await h.lifecycle('session_start');
    assert.deepEqual(h.active(), ['bash', 'read']);
    await assertGuarded(h);
    await h.command('resume before repair');
    assert.equal(h.sent.length, 0);
    assert.equal(fs.readlinkSync(h.log), 'missing-target');
  });
}

test('failed host pause callbacks cannot restore activation or bypass tool guards', async t => {
  const h = fixture(t);
  await h.lifecycle('session_start');
  fs.unlinkSync(h.log); fs.mkdirSync(h.log);
  h.failHost(true);
  await h.lifecycle('session_tree');
  await assertGuarded(h);
  fs.rmdirSync(h.log); fs.writeFileSync(h.log, persisted);
  h.failHost(false);
  await h.lifecycle('session_tree');
  assert.deepEqual(h.active(), ['bash', 'read']);
  await assertGuarded(h);
  await h.command('resume after repair');
  assert.equal(h.sent.length, 1);
});

test('genuinely missing log still uses legacy history only after explicit activation', async t => {
  const h = fixture(t);
  fs.unlinkSync(h.log);
  await h.lifecycle('session_start');
  assert.deepEqual(h.active(), ['bash', 'read']);
  await h.command('resume legacy fallback');
  const initialized = await h.call('init_experiment', { name: 'new segment', metric_name: 'score', direction: 'higher' });
  assert.equal(initialized.details.state.results[0].metric, 99);
  assert.equal(initialized.details.state.currentSegment, 1);
});

for (const kind of ['dangling-link', 'not-directory']) {
  test(`invalid current layout ${kind} cannot revive a stale legacy log`, { skip: kind === 'dangling-link' && process.platform === 'win32' }, async t => {
    const h = fixture(t);
    fs.rmSync(join(h.cwd, '.auto'), { recursive: true });
    if (kind === 'dangling-link') fs.symlinkSync('missing-layout', join(h.cwd, '.auto'));
    else fs.writeFileSync(join(h.cwd, '.auto'), 'not a directory');
    fs.writeFileSync(join(h.cwd, 'autoresearch.jsonl'), persisted);
    await h.lifecycle('session_start');
    assert.deepEqual(h.active(), ['bash', 'read']);
    await assertGuarded(h);
    assert.equal(fs.readFileSync(join(h.cwd, 'autoresearch.jsonl'), 'utf8'), persisted);
    await h.command('resume before layout repair');
    assert.equal(h.sent.length, 0);
  });
}

test('read-time disappearance is uncertain, not proof the log never existed', async t => {
  const h = fixture(t);
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === h.log) throw Object.assign(new Error('disappeared after presence check'), { code: 'ENOENT' });
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try { await h.lifecycle('session_start'); }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(h.active(), ['bash', 'read']);
  await assertGuarded(h);
  assert.equal(fs.readFileSync(h.log, 'utf8'), persisted);
});

for (const legacy of [false, true]) {
  test(`observed ${legacy ? 'legacy' : 'current'} log disappearance during path selection cannot enable stale tools`, async t => {
    const h = fixture(t, legacy);
    const original = fs.lstatSync;
    let observed = false;
    fs.lstatSync = (file, ...args) => {
      const result = original(file, ...args);
      if (file === h.log && !observed) {
        observed = true;
        fs.unlinkSync(h.log); // External removal immediately after successful presence observation.
      }
      return result;
    };
    syncBuiltinESMExports();
    try { await h.lifecycle('session_start'); }
    finally { fs.lstatSync = original; syncBuiltinESMExports(); }
    assert.equal(observed, true);
    assert.deepEqual(h.active(), ['bash', 'read']);
    await assertGuarded(h);
    assert.equal(fs.existsSync(h.log), false, 'recovery must not recreate a disappeared source');
    await h.command('resume without a reconciled log');
    assert.equal(h.sent.length, 0);
    fs.writeFileSync(h.log, persisted);
    await h.command('resume after restoring the source');
    assert.equal(h.sent.length, 1);
  });
}
