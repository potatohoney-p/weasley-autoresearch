import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import autoresearchExtension from '../extensions/weasley-autoresearch/index.ts';

const original = { name: 'original', metric_name: 'score', direction: 'higher' };
const replacement = { name: 'replacement', metric_name: 'latency', metric_unit: 'ms', direction: 'lower' };
const text = result => result.content.map(item => item.text ?? '').join('\n');

async function fixture(t) {
  const cwd = fs.mkdtempSync(join(tmpdir(), 'autoresearch-init-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'baseline']);
  const tools = new Map(), commands = new Map(), handlers = new Map(), entries = [];
  let active = [], aborted = 0;
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, appendEntry: (type, data) => entries.push({ type: 'custom', customType: type, data }), sendUserMessage() {},
    getActiveTools: () => active, setActiveTools: next => { active = next; },
    async exec(command, args) { try { return { code: 0, stdout: execFileSync(command, args, { cwd, encoding: 'utf8' }), stderr: '' }; }
      catch (error) { return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; } },
  });
  const ctx = { cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => { aborted++; },
    sessionManager: { getSessionId: () => cwd, getBranch: () => entries }, ui: { notify() {}, setWidget() {} } };
  const call = (name, params) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  await commands.get('autoresearch').handler('initialize test', ctx);
  t.after(() => handlers.get('session_shutdown')({}, ctx));
  return { cwd, call, active: () => active, aborted: () => aborted, resume: () => commands.get('autoresearch').handler('resume reconciled experiment', ctx) };
}

for (const written of ['none', 'partial', 'complete']) {
  test(`failed reinitialization after ${written} append preserves published state and pauses`, async t => {
    const h = await fixture(t);
    await h.call('init_experiment', original);
    await h.call('run_experiment', { command: 'exit 0' });
    const initial = await h.call('log_experiment', { commit: '0000000', metric: 8, metrics: { throughput: 4 }, status: 'keep', description: 'baseline' });
    assert.equal(initial.details.state.results.length, 1);
    const log = join(h.cwd, '.auto', 'log.jsonl');
    const saved = fs.readFileSync(log, 'utf8');
    const append = fs.appendFileSync;
    let attempted = 0;
    fs.appendFileSync = function(file, data, ...args) {
      if (String(file) !== log) return append.call(this, file, data, ...args);
      attempted++;
      if (written !== 'none') append.call(this, file, written === 'partial' ? String(data).slice(0, 15) : data, ...args);
      throw new Error('injected config append failure');
    };
    syncBuiltinESMExports();
    let failed;
    try { failed = await h.call('init_experiment', replacement); }
    finally { fs.appendFileSync = append; syncBuiltinESMExports(); }
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.details.state, initial.details.state);
    assert.equal(attempted, 1);
    assert.equal(h.aborted(), 1);
    assert.equal(h.active().includes('init_experiment'), false);
    const uncertainLog = fs.readFileSync(log, 'utf8');
    for (const [name, params] of [['init_experiment', replacement], ['run_experiment', { command: 'exit 0' }], ['log_experiment', { commit: '0000000', metric: 1, status: 'keep', description: 'must not log' }]]) {
      assert.equal((await h.call(name, params)).isError, true);
    }
    assert.equal(fs.readFileSync(log, 'utf8'), uncertainLog);
    if (written === 'partial') {
      await h.resume();
      assert.equal((await h.call('init_experiment', replacement)).isError, true, 'partial config cannot be resumed automatically');
    }
    // Simulate explicit user reconciliation, then resume through the supported command.
    fs.writeFileSync(log, saved);
    await h.resume();
    const recovered = await h.call('init_experiment', replacement);
    assert.equal(recovered.details.state.name, 'replacement');
    assert.equal(recovered.details.state.currentSegment, 1);
    assert.equal(recovered.details.state.results.length, 1);
    assert.equal(recovered.details.state.bestMetric, null);
    assert.deepEqual(recovered.details.state.secondaryMetrics, []);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 3);
  });
}

test('first initialization with a directory at the log path does not publish a new goal', async t => {
  const h = await fixture(t);
  fs.mkdirSync(join(h.cwd, '.auto'), { recursive: true });
  fs.mkdirSync(join(h.cwd, '.auto', 'log.jsonl'));
  const failed = await h.call('init_experiment', replacement);
  assert.equal(failed.isError, true);
  assert.equal(failed.details.state.name, null);
  assert.equal(failed.details.state.metricName, 'metric');
  assert.equal(h.aborted(), 1);
});

for (const written of ['none', 'complete']) {
  test(`first initialization pauses after ${written} initial write followed by failure`, async t => {
    const h = await fixture(t);
    const log = join(h.cwd, '.auto', 'log.jsonl');
    assert.equal(fs.existsSync(log), false, 'exercise writeFileSync, not appendFileSync');
    const write = fs.writeFileSync;
    let attempted = 0;
    fs.writeFileSync = function(file, data, ...args) {
      if (String(file) !== log) return write.call(this, file, data, ...args);
      attempted++;
      if (written === 'complete') write.call(this, file, data, ...args);
      throw new Error('injected initial write failure');
    };
    syncBuiltinESMExports();
    let failed;
    try { failed = await h.call('init_experiment', replacement); }
    finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(attempted, 1);
    assert.equal(failed.isError, true);
    assert.equal(failed.details.state.name, null);
    assert.equal(failed.details.state.metricName, 'metric');
    assert.equal(failed.details.state.currentSegment, 0);
    assert.equal(h.aborted(), 1);
    assert.equal(h.active().includes('init_experiment'), false);
    assert.equal(fs.existsSync(log), written === 'complete');
    const afterFailure = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null;
    assert.equal((await h.call('init_experiment', replacement)).isError, true);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null, afterFailure);
    if (written === 'complete') {
      // Retain the complete header after inspection; resume must recover its goal.
      await h.resume();
      await h.call('run_experiment', { command: 'exit 0' });
      const recorded = await h.call('log_experiment', { commit: '0000000', metric: 5, status: 'keep', description: 'recovered initial goal' });
      assert.equal(recorded.details.state.name, replacement.name);
      assert.equal(recorded.details.state.metricName, replacement.metric_name);
      assert.equal(recorded.details.state.currentSegment, 0);
      assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
    }
  });
}
