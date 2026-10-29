import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const launches = [];
childProcess.spawn = (...args) => { launches.push(args); return Object.assign(new EventEmitter(), { unref() {} }); };
syncBuiltinESMExports();
const { default: extension } = await import('../extensions/weasley-autoresearch/index.ts');

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dashboard-lifecycle-'));
  await mkdir(join(cwd, '.auto'));
  await writeFile(join(cwd, '.auto/log.jsonl'), '{"type":"config","name":"Lifecycle"}\n');
  const commands = new Map(), handlers = new Map(), notifications = [], servers = [];
  const realListen = http.Server.prototype.listen;
  t.mock.method(http.Server.prototype, 'listen', function (...args) { servers.push(this); return realListen.apply(this, args); });
  extension({ on: (n, fn) => handlers.set(n, fn), registerCommand: (n, c) => commands.set(n, c), registerTool() {}, registerShortcut() {}, appendEntry() {}, getActiveTools: () => [], setActiveTools() {} });
  const ctx = { cwd, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => cwd, getBranch: () => [] }, ui: { notify: (message, level) => notifications.push({ message, level }) } };
  t.after(async () => {
    await handlers.get('session_shutdown')({}, ctx);
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(cwd, { recursive: true, force: true });
  });
  const command = args => commands.get('autoresearch').handler(args, ctx);
  return { cwd, command, servers, notifications, shutdown: () => handlers.get('session_shutdown')({}, ctx) };
}

for (const stop of ['off', 'clear', 'shutdown']) {
  test(`pending export cannot survive ${stop}`, async t => {
    const f = await fixture(t), before = launches.length;
    const exporting = f.command('export');
    await (stop === 'shutdown' ? f.shutdown() : f.command(stop));
    await exporting;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.servers.filter(s => s.listening).length, 0);
    assert.equal(launches.length, before, 'cancelled export must not launch browser');
    assert.equal(f.notifications.some(n => n.message.startsWith('Dashboard at')), false);
  });
}

test('simultaneous exports reuse one server and off closes it', async t => {
  const f = await fixture(t);
  await Promise.all([f.command('export'), f.command('export')]);
  assert.equal(f.servers.length, 1);
  const url = f.notifications.find(n => n.message.startsWith('Dashboard at')).message.match(/http:\/\/[^ ]+/)[0];
  assert.equal((await fetch(`${url}/autoresearch.jsonl`)).status, 200);
  await f.command('off');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.servers.filter(s => s.listening).length, 0);
});

test('export after off starts a fresh usable server', async t => {
  const f = await fixture(t);
  await f.command('export');
  await f.command('off');
  await f.command('export');
  assert.equal(f.servers.length, 2);
  assert.equal(f.servers.filter(s => s.listening).length, 1);
  const urls = f.notifications.filter(n => n.message.startsWith('Dashboard at')).map(n => n.message.match(/http:\/\/[^ ]+/)[0]);
  assert.match(await (await fetch(urls.at(-1))).text(), /Lifecycle/);
});


test('failed bind is reported and a later export recovers', async t => {
  const f = await fixture(t);
  const listen = http.Server.prototype.listen;
  let failOnce = true;
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    if (failOnce) {
      failOnce = false;
      queueMicrotask(() => this.emit('error', new Error('injected bind failure')));
      return this;
    }
    return listen.apply(this, args);
  });
  await f.command('export');
  assert.ok(f.notifications.some(n => n.level === 'error' && /injected bind failure/.test(n.message)));
  await f.command('export');
  assert.equal(f.servers.filter(s => s.listening).length, 1);
  assert.ok(f.notifications.some(n => n.message.startsWith('Dashboard at')));
});

test('a new work directory supersedes a pending export', async t => {
  const f = await fixture(t), before = launches.length;
  const other = join(f.cwd, 'other');
  await mkdir(join(other, '.auto'), { recursive: true });
  await writeFile(join(other, '.auto/log.jsonl'), '{"type":"config","name":"Replacement"}\n');
  const old = f.command('export');
  // Synchronous config write deliberately changes the destination before listen completes.
  writeFileSync(join(f.cwd, '.auto/config.json'), JSON.stringify({ workingDir: other }));
  await Promise.all([old, f.command('export')]);
  assert.equal(f.servers.filter(s => s.listening).length, 1);
  assert.equal(launches.length - before, 1);
  const url = f.notifications.findLast(n => n.message.startsWith('Dashboard at')).message.match(/http:\/\/[^ ]+/)[0];
  assert.match(await (await fetch(`${url}/autoresearch.jsonl`)).text(), /Replacement/);
});

test('synchronous listen failure allows retry', async t => {
  const f = await fixture(t);
  const listen = http.Server.prototype.listen;
  let failOnce = true;
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    if (failOnce) { failOnce = false; throw new Error('injected synchronous listen failure'); }
    return listen.apply(this, args);
  });
  await f.command('export');
  assert.ok(f.notifications.some(n => /injected synchronous listen failure/.test(n.message)));
  await f.command('export');
  assert.equal(f.servers.filter(s => s.listening).length, 1);
});


test('an active server error retires its URL and permits a fresh export', async t => {
  const f = await fixture(t);
  await f.command('export');
  f.servers[0].emit('error', new Error('injected active-server failure'));
  await f.command('export');
  assert.equal(f.servers.length, 2);
  assert.equal(f.servers.filter(s => s.listening).length, 1);
  const url = f.notifications.findLast(n => n.message.startsWith('Dashboard at')).message.match(/http:\/\/[^ ]+/)[0];
  assert.match(await (await fetch(url)).text(), /Lifecycle/);
});

test('a late error from a retired server does not close its replacement', async t => {
  const f = await fixture(t);
  await f.command('export');
  await f.command('off');
  await f.command('export');
  f.servers[0].emit('error', new Error('injected stale-server failure'));
  await f.command('export');
  assert.equal(f.servers.length, 2);
  assert.equal(f.servers[1].listening, true);
});
