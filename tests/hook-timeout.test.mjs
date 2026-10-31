import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runHook, steerMessageFor } from '../extensions/weasley-autoresearch/hooks.ts';

async function ready(path) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); } catch {}
    await delay(10);
  }
  throw new Error(`fixture did not become ready: ${path}`);
}
async function assertTerminated(cwd, name) {
  if (process.platform !== 'linux') return;
  const pid = Number(await readFile(join(cwd, name), 'utf8'));
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (/^Z /.test(stat.slice(stat.lastIndexOf(')') + 2))) return;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`process ${pid} is still running after escalation`);
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('hook did not settle after deadline')), 2000);
  })]); } finally { clearTimeout(timer); }
}
async function fixture(script, check) {
  const cwd = await mkdtemp(join(tmpdir(), 'hook-timeout-'));
  let expire;
  let pending;
  const original = globalThis.setTimeout;
  try {
    await mkdir(join(cwd, '.auto/hooks'), { recursive: true });
    await writeFile(join(cwd, '.auto/hooks/before.sh'), `#!/bin/bash\necho $$ > group.pid\n${script}`, { mode: 0o755 });
    // Capture only the production deadline; trigger after actual fixture readiness.
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 30000) { expire = () => callback(...args); return original(() => {}, 30000); }
      return original(callback, ms, ...args);
    };
    pending = runHook({ event: 'before', cwd, next_run: 1, last_run: null, session: {} });
    globalThis.setTimeout = original;
    await ready(join(cwd, 'ready'));
    assert.equal(typeof expire, 'function');
    expire();
    const result = await bounded(pending);
    assert.equal(result.timedOut, true);
    assert.match(steerMessageFor('before', result), /timed out after 30s/);
    await check?.(result, cwd);
  } finally {
    globalThis.setTimeout = original;
    for (const name of ['group.pid', 'escape.pid']) {
      try {
        const pid = Number(await readFile(join(cwd, name), 'utf8'));
        if (pid > 1) { try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} }
      } catch {}
    }
    if (pending) await bounded(pending).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
test('hook deadline escalates when TERM is ignored', { skip: process.platform === 'win32' }, async () => {
  await fixture(`trap '' TERM\ncat >/dev/null\necho ready > ready\nsleep 20\n`, async (result, cwd) => {
    assert.equal(result.exitCode, null);
    await assertTerminated(cwd, 'group.pid');
  });
});
test('hook deadline still escalates after parent exits zero', { skip: process.platform === 'win32' }, async () => {
  await fixture(`trap 'exit 0' TERM\ncat >/dev/null\nbash -c 'trap "" TERM; echo $BASHPID > desc.pid; echo ready > ready; sleep 20' &\nwait\n`, async (result, cwd) => {
    assert.equal(result.exitCode, 0);
    await assertTerminated(cwd, 'desc.pid');
  });
});
test('hook deadline bounds host wait for escaped descendant pipe handles', { skip: process.platform !== 'linux' }, async () => {
  await fixture(`cat >/dev/null\nsetsid bash -c 'trap "" TERM; echo $$ > escape.pid; echo ready > ready; sleep 20' &\nwait\n`, async (_, cwd) => {
    // It is not claimed to be terminated: the fixture owns cleanup explicitly.
    const pid = Number(await readFile(join(cwd, 'escape.pid'), 'utf8'));
    assert.doesNotThrow(() => process.kill(pid, 0));
  });
});
