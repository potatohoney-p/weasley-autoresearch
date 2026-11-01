import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import autoresearchExtension from '../extensions/weasley-autoresearch/index.ts';

const original = { name: 'original', metric_name: 'score', direction: 'higher' };
const replacement = { name: 'replacement', metric_name: 'latency', metric_unit: 'ms', direction: 'lower' };
const text = result => result.content.map(item => item.text ?? '').join('\n');

async function fixture(t) {
  let fault = null;
  const fail = (name, effect) => {
    if (fault?.name === name && !fault.after) throw new Error(`injected ${name} failure`);
    effect();
    if (fault?.name === name && fault.after) throw new Error(`injected ${name} failure`);
  };
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
    registerShortcut() {}, appendEntry: (type, data) => fail('appendEntry', () => entries.push({ type: 'custom', customType: type, data })), sendUserMessage() {},
    getActiveTools: () => active, setActiveTools: next => fail('setActiveTools', () => { active = next; }),
    async exec(command, args) { try { return { code: 0, stdout: execFileSync(command, args, { cwd, encoding: 'utf8' }), stderr: '' }; }
      catch (error) { return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; } },
  });
  const ctx = { cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => { aborted++; },
    sessionManager: { getSessionId: () => cwd, getBranch: () => entries }, ui: { notify() {}, setWidget() {} } };
  const call = (name, params) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  await commands.get('autoresearch').handler('initialize test', ctx);
  t.after(() => handlers.get('session_shutdown')({}, ctx));
  return { cwd, call, setFault: value => { fault = value; }, active: () => active, aborted: () => aborted, resume: () => commands.get('autoresearch').handler('resume reconciled experiment', ctx) };
}


for (const reinit of [false, true]) {
  for (const name of ['appendEntry', 'setActiveTools']) {
    for (const after of [false, true]) {
      test(`${reinit ? 'reinitialization' : 'initialization'} pauses after ${name} failure ${after ? 'after' : 'before'} side effect`, async t => {
        const h = await fixture(t);
        if (reinit) {
          await h.call('init_experiment', original);
          await h.call('run_experiment', { command: 'exit 0' });
          await h.call('log_experiment', { commit: '0000000', metric: 8, status: 'keep', description: 'baseline' });
        }
        const log = join(h.cwd, '.auto', 'log.jsonl');
        const previousHeaders = reinit ? 1 : 0;
        h.setFault({ name, after });
        let failed;
        try { failed = await h.call('init_experiment', replacement); }
        finally { h.setFault(null); }
        assert.equal(failed.isError, true);
        assert.equal(failed.details.state.name, replacement.name);
        assert.equal(failed.details.state.metricName, replacement.metric_name);
        assert.equal(failed.details.state.currentSegment, reinit ? 1 : 0);
        assert.equal(failed.details.state.bestMetric, null);
        assert.deepEqual(failed.details.initializationOutcome, { persisted: true, activationConfirmed: false, paused: true });
        assert.match(text(failed), /Do not repeat init_experiment/);
        assert.equal(h.aborted(), 1);
        const saved = fs.readFileSync(log, 'utf8');
        assert.equal(saved.trim().split('\n').map(JSON.parse).filter(row => row.type === 'config').length, previousHeaders + 1);
        for (const [tool, params] of [['init_experiment', replacement], ['run_experiment', { command: 'exit 0' }], ['log_experiment', { commit: '0000000', metric: 1, status: 'keep', description: 'blocked' }]]) {
          assert.equal((await h.call(tool, params)).isError, true);
        }
        assert.equal(fs.readFileSync(log, 'utf8'), saved);
        await h.resume();
        assert.equal(fs.readFileSync(log, 'utf8'), saved, 'resume must not repeat initialization');
        await h.call('run_experiment', { command: 'exit 0' });
        const recorded = await h.call('log_experiment', { commit: '0000000', metric: 3, status: 'keep', description: 'recovered target' });
        assert.equal(recorded.details.state.name, replacement.name);
        assert.equal(recorded.details.state.metricName, replacement.metric_name);
        assert.equal(recorded.details.state.currentSegment, reinit ? 1 : 0);
        assert.equal(recorded.details.state.bestMetric, 3);
      });
    }
  }
}
