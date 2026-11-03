import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import childProcess from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

childProcess.spawn = () => Object.assign(new EventEmitter(), { unref() {} });
syncBuiltinESMExports();
const { default: extension } = await import('../extensions/weasley-autoresearch/index.ts');

class Response extends EventEmitter {
  writes = [];
  accepts = true;
  destroyed = false;
  writableEnded = false;
  ends = 0;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) {
    if (this.throwWrite) throw new Error('injected response write failure');
    this.writes.push(chunk);
    return this.accepts;
  }
  end() { this.ends++; this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  updates() { return this.writes.join('').split('\n\n').filter(frame => frame.startsWith('event: jsonl-updated\n')); }
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dashboard-backpressure-'));
  await mkdir(join(cwd, '.auto'));
  await writeFile(join(cwd, '.auto/log.jsonl'), '{"type":"config","name":"Backpressure"}\n');
  const commands = new Map(), handlers = new Map(), tools = new Map(), servers = [];
  const realListen = http.Server.prototype.listen;
  t.mock.method(http.Server.prototype, 'listen', function (...args) { servers.push(this); return realListen.apply(this, args); });
  extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, value) => commands.set(name, value),
    registerTool: value => tools.set(value.name, value), registerShortcut() {}, appendEntry() {},
    getActiveTools: () => [], setActiveTools() {}, sendUserMessage() {} });
  const ctx = { cwd, hasUI: false, isIdle: () => true, abort() {},
    sessionManager: { getSessionId: () => cwd, getBranch: () => [] }, ui: { notify() {}, setWidget() {} } };
  const command = arg => commands.get('autoresearch').handler(arg, ctx);
  const shutdown = () => handlers.get('session_shutdown')({}, ctx);
  t.after(async () => {
    await shutdown();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(cwd, { recursive: true, force: true });
  });
  await command('export');
  const server = servers[0];
  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  const update = async () => {
    time++;
    const result = await tools.get('init_experiment').execute('test', { name: 'Goal', metric_name: 'latency' }, undefined, undefined, ctx);
    assert.notEqual(result.isError, true);
    return time;
  };
  const connect = (response = new Response()) => {
    servers.at(-1).emit('request', { url: '/events' }, response);
    return response;
  };
  return { server, command, shutdown, update, connect };
}

const lastFrame = (time) => `event: jsonl-updated\ndata: ${time}`;

test('healthy dashboard clients retain complete events and do not replay on drain', async t => {
  const f = await fixture(t), response = f.connect();
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'text/event-stream');
  assert.equal(response.writes[0], 'retry: 1000\n\n');
  const times = [await f.update(), await f.update(), await f.update()];
  assert.deepEqual(response.updates(), times.map(lastFrame));
  const writes = response.writes.length;
  response.emit('drain');
  assert.equal(response.writes.length, writes);
});

test('pressure from the initial retry frame coalesces updates until drain', async t => {
  const f = await fixture(t), response = new Response();
  response.accepts = false;
  f.connect(response);
  let latest;
  for (let i = 0; i < 100; i++) latest = await f.update();
  assert.equal(response.writes.length, 1, 'do not add writes while retry frame is blocked');
  response.accepts = true;
  response.emit('drain');
  assert.deepEqual(response.updates(), [lastFrame(latest)]);
});

test('blocked update keeps only the newest pending notification and sends it on drain', async t => {
  const f = await fixture(t), response = f.connect();
  response.accepts = false;
  const first = await f.update();
  const blockedWrites = response.writes.length;
  let latest;
  for (let i = 0; i < 100; i++) latest = await f.update();
  assert.equal(response.writes.length, blockedWrites, 'a slow client must not grow the write queue');
  response.accepts = true;
  response.emit('drain');
  assert.deepEqual(response.updates(), [lastFrame(first), lastFrame(latest)]);
  const resumed = await f.update();
  assert.deepEqual(response.updates(), [lastFrame(first), lastFrame(latest), lastFrame(resumed)]);
});

test('repeated pressure cycles neither duplicate accepted frames nor lose the last pending update', async t => {
  const f = await fixture(t), response = f.connect();
  response.accepts = false;
  const first = await f.update();
  await f.update();
  const second = await f.update();
  response.emit('drain'); // The flushed frame also reports pressure.
  const blockedWrites = response.writes.length;
  await f.update();
  const third = await f.update();
  assert.equal(response.writes.length, blockedWrites);
  response.accepts = true;
  response.emit('drain');
  response.emit('drain');
  assert.deepEqual(response.updates(), [first, second, third].map(lastFrame));
});

test('one blocked browser does not delay a healthy browser', async t => {
  const f = await fixture(t), slow = f.connect(), fast = f.connect();
  slow.accepts = false;
  const first = await f.update();
  const second = await f.update();
  const third = await f.update();
  assert.deepEqual(fast.updates(), [first, second, third].map(lastFrame));
  assert.deepEqual(slow.updates(), [lastFrame(first)]);
  slow.accepts = true;
  slow.emit('drain');
  assert.deepEqual(slow.updates(), [first, third].map(lastFrame));
});

for (const boundary of ['close', 'off', 'clear', 'shutdown']) {
  test(`pending update is retired on ${boundary} and cannot be sent by a late drain`, async t => {
    const f = await fixture(t), response = f.connect();
    response.accepts = false;
    await f.update();
    await f.update();
    if (boundary === 'close') response.destroy();
    else if (boundary === 'shutdown') await f.shutdown();
    else await f.command(boundary);
    const writes = response.writes.length;
    response.accepts = true;
    response.emit('drain');
    assert.equal(response.writes.length, writes);
    assert.equal(response.listenerCount('drain'), 0);
    if (boundary !== 'close') assert.equal(response.ends, 1);
  });
}

test('a synchronous failed write retires only that client and leaves initialization successful', async t => {
  const f = await fixture(t), failed = f.connect(), healthy = f.connect();
  failed.throwWrite = true;
  const current = await f.update();
  assert.deepEqual(healthy.updates(), [lastFrame(current)]);
  assert.equal(failed.destroyed, true);
  assert.equal(failed.listenerCount('drain'), 0);
});

test('an asynchronous response error retires pending delivery without escaping the host', async t => {
  const f = await fixture(t), failed = f.connect();
  failed.accepts = false;
  await f.update();
  await f.update();
  assert.doesNotThrow(() => failed.emit('error', new Error('injected response error')));
  const writes = failed.writes.length;
  failed.accepts = true;
  failed.emit('drain');
  await f.update();
  assert.equal(failed.writes.length, writes);
  assert.equal(failed.destroyed, true);
});

test('real loopback SSE clients still receive retry and current log invalidation', async t => {
  const f = await fixture(t);
  const request = http.get({ host: '127.0.0.1', port: f.server.address().port, path: '/events' });
  t.after(() => request.destroy());
  const response = await new Promise((resolve, reject) => { request.once('response', resolve); request.once('error', reject); });
  t.after(() => response.destroy());
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    response.on('data', chunk => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString().includes('event: jsonl-updated\n')) resolve();
    });
    response.on('error', reject);
  });
  const time = await f.update();
  await complete;
  assert.equal(Buffer.concat(chunks).toString(), `retry: 1000\n\n${lastFrame(time)}\n\n`);
  request.destroy();
  response.destroy();
});


test('real Writable pressure keeps queued bytes bounded across 1000 persisted updates', async t => {
  const f = await fixture(t);
  const writes = [], completions = [];
  const response = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    writes.push(chunk.toString());
    completions.push(done);
  } });
  response.writeHead = () => {};
  f.connect(response);
  let latest;
  for (let i = 0; i < 1000; i++) latest = await f.update();
  assert.equal(response.writableNeedDrain, true);
  assert.equal(response.writableLength, Buffer.byteLength('retry: 1000\n\n'));
  assert.equal(writes.length, 1);
  completions.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['retry: 1000\n\n', `${lastFrame(latest)}\n\n`]);
  assert.equal(response.writableLength, Buffer.byteLength(writes[1]));
  completions.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.writableLength, 0);
  assert.equal(writes.length, 2);
  response.destroy();
});

for (const operation of ['headers', 'retry']) {
  test(`failure during initial ${operation} retires the response without escaping the HTTP handler`, async t => {
    const f = await fixture(t), response = new Response();
    if (operation === 'headers') response.writeHead = () => { throw new Error('injected headers failure'); };
    else response.throwWrite = true;
    assert.doesNotThrow(() => f.connect(response));
    assert.equal(response.destroyed, true);
    assert.equal(response.listenerCount('drain'), 0);
    await f.update();
  });
}

test('re-export starts a fresh stream without reviving retired notifications', async t => {
  const f = await fixture(t), old = f.connect();
  old.accepts = false;
  await f.update();
  await f.update();
  await f.command('off');
  await f.command('export');
  const fresh = f.connect();
  const current = await f.update();
  assert.deepEqual(fresh.updates(), [lastFrame(current)]);
  const writes = old.writes.length;
  old.accepts = true;
  old.emit('drain');
  assert.equal(old.writes.length, writes);
  assert.equal(old.ends, 1);
});
