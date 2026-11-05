import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Export the real listener without launching a desktop browser in the test host.
childProcess.spawn = () => Object.assign(new EventEmitter(), { unref() {} });
syncBuiltinESMExports();
const { default: extension } = await import('../extensions/weasley-autoresearch/index.ts');

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dashboard-requests-'));
  const log = '{"type":"config","name":"Request handling"}\n';
  await mkdir(join(cwd, '.auto'));
  await writeFile(join(cwd, '.auto/log.jsonl'), log);
  const commands = new Map(), handlers = new Map(), servers = [], notifications = [];
  const realListen = http.Server.prototype.listen;
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    servers.push(this);
    return realListen.apply(this, args);
  });
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command), registerTool() {}, registerShortcut() {}, appendEntry() {}, getActiveTools: () => [], setActiveTools() {} });
  const ctx = { cwd, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => cwd, getBranch: () => [] }, ui: { notify: (message) => notifications.push(message) } };
  t.after(async () => {
    await handlers.get('session_shutdown')({}, ctx);
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(cwd, { recursive: true, force: true });
  });
  await commands.get('autoresearch').handler('export', ctx);
  assert.ok(notifications.some(message => message.startsWith('Dashboard at')), notifications.join('\n'));
  const [server] = servers;
  return { server, port: server.address().port, log };
}

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('Dashboard request did not finish')));
    req.on('error', reject);
    req.end();
  });
}

for (const target of ['http://[', '//[', 'http://example.test:99999/', 'http://%/', 'http://[::1/foo']) {
  test(`malformed dashboard target ${JSON.stringify(target)} is contained`, async t => {
    const f = await fixture(t);
    // Catch the original synchronous throw safely before testing real HTTP. The
    // unfixed listener would otherwise terminate this test worker on a request.
    let status, body;
    const response = { writeHead(code) { status = code; }, end(value) { body = value; } };
    assert.doesNotThrow(() => f.server.listeners('request')[0]({ url: target }, response));
    assert.equal(status, 400);
    assert.equal(body, 'Bad Request');
    const invalid = await request(f.port, target);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body, 'Bad Request');
    assert.equal(invalid.headers['content-type'], 'text/plain; charset=utf-8');
    // A rejected request must not retire the dashboard or the experiment host.
    const healthy = await request(f.port, '/autoresearch.jsonl');
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body, f.log);
    assert.equal((await request(f.port, '/')).status, 200);
    assert.equal(f.server.listening, true);
  });
}

test('valid dashboard routes, query strings and unknown paths keep their behavior', async t => {
  const f = await fixture(t);
  for (const target of ['/autoresearch.jsonl', '/autoresearch.jsonl?after=1', 'http://localhost/autoresearch.jsonl']) {
    const response = await request(f.port, target);
    assert.equal(response.status, 200, target);
    assert.equal(response.body, f.log);
  }
  const page = await request(f.port, '/?view=latest');
  assert.equal(page.status, 200);
  assert.match(page.body, /Request handling/);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  const absent = await request(f.port, '/does-not-exist');
  assert.equal(absent.status, 404);
  assert.equal(absent.body, '');
  const head = await request(f.port, '/autoresearch.jsonl', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('SSE remains available after repeated malformed requests', async t => {
  const f = await fixture(t);
  const response = { writeHead() {}, end() {} };
  assert.doesNotThrow(() => f.server.listeners('request')[0]({ url: 'http://[' }, response));
  for (let i = 0; i < 10; i++) assert.equal((await request(f.port, 'http://[')).status, 400);
  const event = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: f.port, path: '/events?listen=1', agent: false }, res => {
      let frame = '';
      res.setEncoding('utf8');
      res.on('data', data => {
        frame += data;
        if (!frame.includes('\n\n')) return;
        res.destroy();
        resolve({ status: res.statusCode, type: res.headers['content-type'], frame });
      });
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('SSE did not connect')));
    req.on('error', reject);
    t.after(() => req.destroy());
  });
  assert.equal(event.status, 200);
  assert.equal(event.type, 'text/event-stream');
  assert.equal(event.frame, 'retry: 1000\n\n');
});
