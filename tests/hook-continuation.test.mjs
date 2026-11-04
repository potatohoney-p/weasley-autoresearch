import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import autoresearchExtension from '../extensions/weasley-autoresearch/index.ts';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'autoresearch-hook-continuation-'));
  const git = args => exec('git', args, { cwd });
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(cwd, '.gitignore'), '.auto/\n');
  await git(['add', '.gitignore']);
  await git(['commit', '--quiet', '-m', 'fixture']);
  await mkdir(join(cwd, '.auto/hooks'), { recursive: true });
  await writeFile(join(cwd, '.auto/prompt.md'), 'Optimize the fixture.\n');
  const tools = new Map(), commands = new Map(), handlers = new Map(), entries = [], messages = [];
  let active = [], session = cwd, aborted = 0, pendingExec;
  autoresearchExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {},
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (message, options) => messages.push({ message, options }),
    getActiveTools: () => active, setActiveTools: next => { active = next; },
    async exec(command, args, options) {
      let result;
      try { result = { code: 0, ...await exec(command, args, options) }; }
      catch (error) { result = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
      if (pendingExec?.matches(command, args)) {
        const hold = pendingExec;
        pendingExec = undefined;
        hold.started();
        await hold.released;
      }
      return result;
    },
  });
  const ctx = { cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort: () => { aborted++; }, sessionManager: { getSessionId: () => session, getBranch: () => entries },
    ui: { notify() {}, setWidget() {} } };
  const call = (name, params) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  const command = args => commands.get('autoresearch').handler(args, ctx);
  const event = name => handlers.get(name)({}, ctx);
  const records = async () => JSON.parse('[' + (await readFile(join(cwd, '.auto/log.jsonl'), 'utf8')).trim().split('\n').join(',') + ']');
  const install = async (stage, token = stage, hold = true) => {
    await writeFile(join(cwd, '.auto/hooks', `${stage}.sh`), [
      '#!/bin/bash', 'cat >/dev/null', `touch .auto/${token}.ready`,
      ...(hold ? [`while [ ! -f .auto/${token}.release ]; do sleep 0.01; done`] : []),
      `printf '${token} steering\\n'`, '',
    ].join('\n'), { mode: 0o755 });
    return {
      async ready() {
        const until = performance.now() + 5000;
        while (performance.now() < until) {
          if (await access(join(cwd, '.auto', `${token}.ready`)).then(() => true, () => false)) return;
          await pause(10);
        }
        throw new Error(`${token} hook did not become ready`);
      },
      release: () => writeFile(join(cwd, '.auto', `${token}.release`), ''),
    };
  };
  // Each test releases and awaits its own hook before cleanup, even on failure.
  t.after(async () => { await event('session_shutdown'); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, call, command, event, install, messages, records, ctx,
    active: () => active, aborted: () => aborted, switchIdentity: () => { session += '-new'; },
    holdExec(matches) {
      let started, release;
      const ready = new Promise(resolve => { started = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      pendingExec = { matches, started, released };
      return { ready, release };
    } };
}

for (const boundary of ['off', 'clear', 'session_start', 'session_tree', 'session_before_switch', 'session_shutdown', 'identity']) {
  test(`activation cannot send a delayed kickoff after ${boundary}`, { timeout: 15000 }, async t => {
    const h = await fixture(t);
    const hook = await h.install('before');
    const activation = h.command('old goal');
    try {
      await hook.ready();
      if (boundary === 'off' || boundary === 'clear') await h.command(boundary);
      else if (boundary === 'identity') h.switchIdentity();
      else await h.event(boundary);
    } finally { await hook.release(); await activation; }
    assert.deepEqual(h.messages, [], 'superseded activation must not enqueue a kickoff or steering');
  });
}

test('a new activation keeps its kickoff when an old hook completes later', { timeout: 15000 }, async t => {
  const h = await fixture(t);
  const old = await h.install('before', 'old');
  const activation = h.command('old goal');
  try {
    await old.ready();
    await h.command('off');
    await h.install('before', 'new', false);
    await h.command('new goal');
  } finally { await old.release(); await activation; }
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].message, /new steering.*new goal/s);
  assert.doesNotMatch(h.messages[0].message, /old steering|old goal/);
});

test('stale initialization hook cannot steer or append into a replacement log', { timeout: 15000 }, async t => {
  const h = await fixture(t);
  const hook = await h.install('before');
  const initialization = h.call('init_experiment', { name: 'old', metric_name: 'score' });
  try {
    await hook.ready();
    await h.command('clear');
    await rm(join(h.cwd, '.auto/hooks/before.sh'));
    await h.call('init_experiment', { name: 'new', metric_name: 'score' });
  } finally { await hook.release(); await initialization; }
  assert.deepEqual(h.messages, []);
  const records = await h.records();
  assert.equal(records.length, 1, 'old hook completion must not contaminate the replacement log');
  assert.equal(records[0].name, 'new');
});

for (const boundary of ['off', 'session_before_switch', 'session_tree', 'session_shutdown']) {
  test(`recorded result survives ${boundary} without stale after/before hook continuation`, { timeout: 15000 }, async t => {
    const h = await fixture(t);
    await h.command('fixture');
    await h.call('init_experiment', { name: 'fixture', metric_name: 'score' });
    await h.call('run_experiment', { command: 'printf "METRIC score=1\\n"' });
    const after = await h.install('after');
    await h.install('before', 'next', false);
    h.messages.length = 0;
    const logging = h.call('log_experiment', { commit: '0000000', metric: 1, status: 'keep', description: 'baseline' });
    let result;
    try {
      await after.ready();
      if (boundary === 'off') await h.command('off');
      else await h.event(boundary);
    } finally { await after.release(); result = await logging; }
    assert.equal(result.details.experiment.status, 'keep');
    assert.equal((await h.records()).filter(record => record.status === 'keep').length, 1);
    assert.deepEqual(h.messages, [], 'late hook must not steer a stopped or different session');
    assert.equal(await access(join(h.cwd, '.auto/next.ready')).then(() => true, () => false), false,
      'a stale after hook must not launch the next before hook');
  });
}

test('current activation and log hooks keep their steering and diagnostic records', { timeout: 15000 }, async t => {
  const h = await fixture(t);
  await h.install('before', 'before', false);
  await h.command('current goal');
  assert.match(h.messages[0].message, /before steering.*current goal/s);
  await h.call('init_experiment', { name: 'fixture', metric_name: 'score' });
  await h.install('after', 'after', false);
  await h.call('run_experiment', { command: 'printf "METRIC score=1\\n"' });
  h.messages.length = 0;
  const result = await h.call('log_experiment', { commit: '0000000', metric: 1, status: 'keep', description: 'baseline' });
  assert.equal(result.details.experiment.status, 'keep');
  assert.deepEqual(h.messages.map(x => x.message), ['after steering', 'before steering']);
  assert.deepEqual((await h.records()).filter(x => x.type === 'hook').map(x => x.stage), ['after', 'before']);
});

for (const boundary of ['off', 'session_before_switch', 'identity']) {
  test(`session change during Git publication cannot adopt a new hook generation (${boundary})`, { timeout: 15000 }, async t => {
    const h = await fixture(t);
    await h.command('fixture');
    await h.call('init_experiment', { name: 'fixture', metric_name: 'score' });
    await h.call('run_experiment', { command: 'exit 0' });
    await h.install('after', 'after', false);
    await h.install('before', 'next', false);
    h.messages.length = 0;
    const git = h.holdExec((command, args) => command === 'git' && args[0] === 'add');
    const logging = h.call('log_experiment', { commit: '0000000', metric: 1, status: 'keep', description: 'baseline' });
    let result;
    try {
      await git.ready;
      if (boundary === 'off') await h.command('off');
      else if (boundary === 'identity') {
        h.switchIdentity();
        await h.command('replacement goal');
        h.messages.length = 0;
        await rm(join(h.cwd, '.auto/next.ready'));
      } else await h.event(boundary);
    } finally { git.release(); result = await logging; }
    assert.equal(result.details.experiment.status, 'keep');
    assert.deepEqual(h.messages, []);
    for (const token of ['after', 'next']) {
      assert.equal(await access(join(h.cwd, '.auto', `${token}.ready`)).then(() => true, () => false), false);
    }
    assert.equal((await h.records()).filter(record => record.status === 'keep').length, 1);
  });
}

test('OFF during the next before hook preserves earlier after steering but suppresses late steering', { timeout: 15000 }, async t => {
  const h = await fixture(t);
  await h.command('fixture');
  await h.call('init_experiment', { name: 'fixture', metric_name: 'score' });
  await h.call('run_experiment', { command: 'exit 0' });
  await h.install('after', 'after', false);
  const before = await h.install('before', 'next');
  h.messages.length = 0;
  const logging = h.call('log_experiment', { commit: '0000000', metric: 1, status: 'keep', description: 'baseline' });
  try { await before.ready(); await h.command('off'); }
  finally { await before.release(); await logging; }
  assert.deepEqual(h.messages.map(x => x.message), ['after steering']);
  assert.deepEqual((await h.records()).filter(x => x.type === 'hook').map(x => x.stage), ['after']);
});
