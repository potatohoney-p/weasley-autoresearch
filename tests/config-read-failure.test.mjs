import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import autoresearchExtension from '../extensions/weasley-autoresearch/index.ts';

const toolNames = ['init_experiment', 'log_experiment', 'run_experiment'];
const log = JSON.stringify({ type: 'config', name: 'Persisted goal', metricName: 'time' }) + '\n';
const symlinks = { skip: process.platform === 'win32' ? 'Symlink privileges differ on Windows' : false };

function fixture(t) {
  const cwd = fs.mkdtempSync(join(tmpdir(), 'autoresearch-config-read-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['-c', 'user.name=Test Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd });
  const commands = new Map(), handlers = new Map(), tools = new Map();
  const entries = [], notices = [], sent = [];
  let active = [];
  autoresearchExtension({
    on: (name, callback) => handlers.set(name, callback),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool), registerShortcut() {},
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    getActiveTools: () => active, setActiveTools: (next) => { active = next; },
    sendUserMessage: (message) => sent.push(message),
  });
  const ctx = { cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => entries },
    ui: { setWidget() {}, notify: (message, level) => notices.push({ message, level }) } };
  const h = { cwd, ctx, tools, handlers, entries, notices, sent, active: () => active,
    start: () => commands.get('autoresearch').handler('optimize safely', ctx),
    event: (name) => handlers.get(name)({}, ctx),
    call: (name, params) => tools.get(name).execute('test', params, undefined, undefined, ctx) };
  t.after(() => h.event('session_shutdown'));
  return h;
}

function assertRefused(h) {
  assert.deepEqual(h.active(), []);
  assert.equal(h.sent.length, 0);
  assert.equal(h.entries.filter((entry) => entry.data.active === true).length, 0);
  assert.match(h.notices.at(-1)?.message ?? '', /config|\.auto/i);
  assert.equal(h.notices.at(-1)?.level, 'error');
}

for (const layout of ['current', 'legacy']) {
  for (const operation of ['manual', 'session_start', 'session_tree']) {
    test(`${operation} refuses a dangling ${layout} configuration link`, symlinks, async (t) => {
      const h = fixture(t);
      const config = layout === 'current' ? join(h.cwd, '.auto', 'config.json') : join(h.cwd, 'autoresearch.config.json');
      if (layout === 'current') fs.mkdirSync(join(h.cwd, '.auto'));
      fs.symlinkSync('missing-configuration-target', config);
      if (operation !== 'manual') fs.writeFileSync(layout === 'current' ? join(h.cwd, '.auto', 'log.jsonl') : join(h.cwd, 'autoresearch.jsonl'), log);
      if (operation === 'manual') await h.start(); else await h.event(operation);
      assertRefused(h);
      assert.equal(fs.readlinkSync(config), 'missing-configuration-target');
    });
  }
}

for (const kind of ['dangling', 'file']) {
  test(`a ${kind} .auto layout cannot select stale legacy configuration`, symlinks, async (t) => {
    const h = fixture(t);
    const auto = join(h.cwd, '.auto');
    if (kind === 'dangling') fs.symlinkSync('missing-layout-target', auto); else fs.writeFileSync(auto, 'preserve me');
    fs.writeFileSync(join(h.cwd, 'autoresearch.config.json'), '{"maxIterations":99}\n');
    fs.writeFileSync(join(h.cwd, 'autoresearch.jsonl'), log);
    await h.event('session_start');
    assertRefused(h);
    assert.equal(fs.readFileSync(join(h.cwd, 'autoresearch.config.json'), 'utf8'), '{"maxIterations":99}\n');
    if (kind === 'file') assert.equal(fs.readFileSync(auto, 'utf8'), 'preserve me');
  });
}

test('current dangling config does not fall back to a valid legacy redirect', symlinks, async (t) => {
  const h = fixture(t);
  fs.mkdirSync(join(h.cwd, '.auto'));
  fs.symlinkSync('missing-config', join(h.cwd, '.auto', 'config.json'));
  fs.writeFileSync(join(h.cwd, 'autoresearch.config.json'), '{"workingDir":"."}\n');
  await h.start();
  assertRefused(h);
});

function patchFs(t, name, replacement) {
  const original = fs[name];
  fs[name] = replacement(original);
  syncBuiltinESMExports();
  const restore = () => { fs[name] = original; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

for (const code of ['EACCES', 'EIO']) {
  test(`configuration presence ${code} is not treated as absence`, async (t) => {
    const h = fixture(t);
    fs.mkdirSync(join(h.cwd, '.auto'));
    const config = join(h.cwd, '.auto', 'config.json');
    fs.writeFileSync(config, '{"maxIterations":3}\n');
    patchFs(t, 'existsSync', original => (file, ...args) => file === config ? false : original(file, ...args));
    patchFs(t, 'lstatSync', original => (file, ...args) => {
      if (file === config) throw Object.assign(new Error(`injected ${code}`), { code });
      return original(file, ...args);
    });
    await h.start();
    assertRefused(h);
    assert.match(h.notices.at(-1).message, new RegExp(code));
    assert.equal(fs.readFileSync(config, 'utf8'), '{"maxIterations":3}\n');
  });
}

test('configuration removed after presence selection fails instead of selecting defaults', async (t) => {
  const h = fixture(t);
  fs.mkdirSync(join(h.cwd, '.auto'));
  const config = join(h.cwd, '.auto', 'config.json');
  fs.writeFileSync(config, '{"maxIterations":3}\n');
  let removed = false;
  for (const name of ['existsSync', 'lstatSync']) patchFs(t, name, original => (file, ...args) => {
    const value = original(file, ...args);
    if (file === config && !removed) { removed = true; fs.unlinkSync(config); }
    return value;
  });
  await h.start();
  assert.equal(removed, true);
  assertRefused(h);
});

for (const layout of ['missing', 'empty-current', 'current', 'legacy', 'linked-current']) {
  test(`valid ${layout} optional configuration keeps activation compatible`, symlinks, async (t) => {
    const h = fixture(t);
    if (layout === 'empty-current' || layout === 'current') fs.mkdirSync(join(h.cwd, '.auto'));
    if (layout === 'linked-current') {
      const target = fs.mkdtempSync(join(tmpdir(), 'autoresearch-linked-config-'));
      t.after(() => fs.rmSync(target, { recursive: true, force: true }));
      fs.symlinkSync(target, join(h.cwd, '.auto'));
      execFileSync('git', ['add', '.auto'], { cwd: h.cwd });
      execFileSync('git', ['-c', 'user.name=Test Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture layout'], { cwd: h.cwd });
    }
    if (['current', 'legacy', 'linked-current'].includes(layout)) {
      fs.writeFileSync(layout === 'legacy' ? join(h.cwd, 'autoresearch.config.json') : join(h.cwd, '.auto', 'config.json'), '{"maxIterations":3}\n');
    }
    await h.start();
    assert.deepEqual([...h.active()].sort(), [...toolNames].sort());
    const result = await h.call('init_experiment', { name: 'new goal', metric_name: 'time' });
    assert.equal(result.details.state.maxExperiments, ['current', 'legacy', 'linked-current'].includes(layout) ? 3 : null);
  });
}

test('repairing a dangling config permits an explicit activation without rewriting the link', symlinks, async (t) => {
  const h = fixture(t);
  fs.mkdirSync(join(h.cwd, '.auto'));
  const config = join(h.cwd, '.auto', 'config.json');
  fs.symlinkSync('repaired.json', config);
  await h.start();
  assertRefused(h);
  fs.writeFileSync(join(h.cwd, '.auto', 'repaired.json'), '{"maxIterations":2}\n');
  await h.start();
  assert.deepEqual([...h.active()].sort(), [...toolNames].sort());
  assert.equal(fs.readlinkSync(config), 'repaired.json');
  const result = await h.call('init_experiment', { name: 'new goal', metric_name: 'time' });
  assert.equal(result.details.state.maxExperiments, 2);
});

for (const name of ['init_experiment', 'run_experiment', 'log_experiment']) {
  test(`active ${name} refuses a newly dangling config before side effects`, symlinks, async (t) => {
    const h = fixture(t);
    await h.start();
    await h.call('init_experiment', { name: 'original goal', metric_name: 'time' });
    const logPath = join(h.cwd, '.auto', 'log.jsonl');
    const originalLog = fs.readFileSync(logPath, 'utf8');
    fs.symlinkSync('missing-policy', join(h.cwd, '.auto', 'config.json'));
    const params = name === 'init_experiment' ? { name: 'replacement goal', metric_name: 'score' }
      : name === 'run_experiment' ? { command: 'printf started > .auto/launched' }
      : { status: 'discard', metric: 4, description: 'must not be recorded' };
    const result = await h.call(name, params);
    assert.match(result.content.map(part => part.text ?? '').join('\n'), /invalid .*config\.json/i);
    assert.equal(fs.readFileSync(logPath, 'utf8'), originalLog);
    assert.equal(fs.existsSync(join(h.cwd, '.auto', 'launched')), false);
    assert.equal(h.sent.length, 1);
  });
}

test('a configuration read failure leaves its contents unchanged and refuses activation', async (t) => {
  const h = fixture(t);
  fs.mkdirSync(join(h.cwd, '.auto'));
  const config = join(h.cwd, '.auto', 'config.json');
  fs.writeFileSync(config, '{"maxIterations":3}\n');
  const restore = patchFs(t, 'readFileSync', original => (file, ...args) => {
    if (file === config) throw Object.assign(new Error('injected read EIO'), { code: 'EIO' });
    return original(file, ...args);
  });
  await h.start();
  assertRefused(h);
  restore();
  assert.equal(fs.readFileSync(config, 'utf8'), '{"maxIterations":3}\n');
});

test('current layout without config ignores a stale legacy redirect', async (t) => {
  const h = fixture(t);
  fs.mkdirSync(join(h.cwd, '.auto'));
  fs.writeFileSync(join(h.cwd, '.auto', 'prompt.md'), 'current goal');
  fs.writeFileSync(join(h.cwd, 'autoresearch.config.json'), '{"workingDir":"missing-legacy-worktree"}\n');
  await h.start();
  assert.deepEqual([...h.active()].sort(), [...toolNames].sort());
  assert.equal(h.entries.at(-1).data.workDir, fs.realpathSync(h.cwd));
});
