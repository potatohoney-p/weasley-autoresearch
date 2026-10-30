import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import test from 'node:test';
import { isLinuxProcessTerminated } from './helpers/linux-process-state.mjs';

for (const state of ['R', 'S', 'D', 'T']) {
  test(`process polling does not accept live state ${state}`, async () => {
    assert.equal(await isLinuxProcessTerminated(123, async (path, encoding) => {
      assert.equal(path, '/proc/123/stat');
      assert.equal(encoding, 'utf8');
      return `123 (fixture) ${state} 1 2 3`;
    }), false);
  });
}
test('process polling accepts a terminated zombie', async () => {
  assert.equal(await isLinuxProcessTerminated(123, async () => '123 (fixture) Z 1 2 3'), true);
});
for (const code of ['ENOENT', 'ESRCH']) {
  test(`process polling accepts ${code} after process exit`, async () => {
    assert.equal(await isLinuxProcessTerminated(123, async () => { throw Object.assign(new Error(code), { code }); }), true);
  });
}
for (const code of ['EACCES', 'EIO', 'EMFILE']) {
  test(`process polling propagates unexpected ${code}`, async () => {
    const failure = Object.assign(new Error(code), { code });
    await assert.rejects(isLinuxProcessTerminated(123, async () => { throw failure; }), error => error === failure);
  });
}
test('an already-open proc stat file can lose its process before reading', { skip: process.platform !== 'linux' }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  const handle = await open(`/proc/${child.pid}/stat`, 'r');
  t.after(() => handle.close());
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await assert.rejects(handle.readFile('utf8'), { code: 'ESRCH' }, 'Linux reports read-time ESRCH rather than open-time ENOENT');
  assert.equal(await isLinuxProcessTerminated(child.pid, () => handle.readFile('utf8')), true);
});
