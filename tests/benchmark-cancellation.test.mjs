import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { getEventListeners } from 'node:events';
import { promisify } from 'node:util';
const execFile = promisify(childProcess.execFile);
import extension from '../extensions/weasley-autoresearch/index.ts';

function harness(cwd) {
  const tools = new Map();
  let checks = 0;
  extension({ on() {}, registerTool(t) { tools.set(t.name, t); }, registerCommand() {}, registerShortcut() {},
    exec: async (command, args, options) => {
      if (command === 'git') {
        try { return { code: 0, ...await execFile(command, args, options) }; }
        catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
      }
      checks++; return { code: 0, stdout: '', stderr: '' };
    },
  });
  return { run: (params, signal) => tools.get('run_experiment').execute('run', params, signal, undefined,
    { cwd, hasUI: false, sessionManager: { getSessionId: () => cwd } }), checks: () => checks };
}
async function eventuallyFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); } catch {}
    await delay(10);
  }
  throw new Error(`Missing fixture readiness file: ${path}`);
}
async function within(promise, ms = 1800) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancellation did not settle')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(body, fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'weasley-cancel-'));
  let pending;
  const ownedGroups = new Set();
  try {
    await writeFile(join(cwd, 'work.sh'), body);
    await writeFile(join(cwd, '.gitignore'), '*.pid\nready\nstarted\n');
    await execFile('git', ['init', '--quiet'], { cwd });
    await execFile('git', ['add', '.'], { cwd });
    await execFile('git', ['-c', 'user.name=Weasley Tests', '-c', 'user.email=tests@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd });
    const host = harness(cwd);
    await fn({ cwd, checks: host.checks, start: (params, signal) => {
      const original = childProcess.spawn;
      childProcess.spawn = (...args) => {
        const child = original(...args);
        if (args[2]?.detached && child.pid) ownedGroups.add(child.pid);
        return child;
      };
      syncBuiltinESMExports();
      pending = host.run({ command: 'bash work.sh', ...params }, signal).finally(() => {
        childProcess.spawn = original; syncBuiltinESMExports();
      });
      pending.catch(() => {});
      return pending;
    } });
  } finally {
    for (const pid of ownedGroups) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    for (const name of ['escape.pid', 'desc.pid']) {
      try { const pid = Number(await readFile(join(cwd, name), 'utf8')); if (pid > 1) { try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} } } catch {}
    }
    if (pending) await within(pending.catch(() => {}), 2000).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
const stubborn = `echo $$ > group.pid\ntrap '' TERM\necho ready > ready\nsleep 20\n`;

test('timeout settles a benchmark that ignores SIGTERM', async () => {
  await fixture(stubborn, async ({ start }) => {
    const result = await within(start({ timeout_seconds: 0.3 }));
    assert.equal(result.details.timedOut, true);
    assert.equal(result.details.passed, false);
  });
});
test('abort settles a benchmark that ignores SIGTERM', async () => {
  await fixture(stubborn, async ({ cwd, start }) => {
    const controller = new AbortController();
    const pending = start({ timeout_seconds: 0 }, controller.signal);
    await eventuallyFile(join(cwd, 'ready'));
    controller.abort();
    await assert.rejects(within(pending), /^Error: aborted$/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});
test('timeout escalation survives direct child exit while a descendant holds pipes', async () => {
  await fixture(`echo $$ > group.pid\ntrap 'exit 0' TERM\nbash -c 'trap "" TERM; echo $BASHPID > desc.pid; echo ready > ready; sleep 20' &\nwait\n`, async ({ cwd, start }) => {
    const result = await within(start({ timeout_seconds: 0.3 }));
    assert.equal(result.details.timedOut, true);
    assert.equal(result.details.passed, false);
    assert.equal(result.details.exitCode, 0);
  });
});
test('timeout releases owned pipes retained by a detached descendant', { skip: process.platform !== 'linux' }, async () => {
  await fixture(`echo $$ > group.pid\nsetsid bash -c 'trap "" TERM; echo $$ > escape.pid; echo ready > ready; sleep 20' &\nwait\n`, async ({ cwd, start }) => {
    const result = await within(start({ timeout_seconds: 0.3 }));
    assert.equal(result.details.timedOut, true);
    assert.equal(result.details.passed, false);
    // The escaped process is deliberately not claimed to be terminated.
    const pid = Number(await eventuallyFile(join(cwd, 'escape.pid')));
    assert.doesNotThrow(() => process.kill(pid, 0));
  });
});
test('ordinary benchmark exit and metrics are unchanged', async () => {
  await fixture('printf "METRIC latency=7\\n"\n', async ({ start }) => {
    const result = await within(start({ timeout_seconds: 5 }));
    assert.equal(result.details.timedOut, false);
    assert.equal(result.details.passed, true);
    assert.deepEqual(result.details.parsedMetrics, { latency: 7 });
    assert.equal(result.details.exitCode, 0);
  });
});

test('timeout does not run correctness checks or become passing after TERM handler exits zero', async () => {
  await fixture(`echo $$ > group.pid\ntrap 'exit 0' TERM\necho ready > ready\nsleep 20\n`, async ({ cwd, start, checks }) => {
    await writeFile(join(cwd, 'autoresearch.checks.sh'), 'exit 0\n');
    const result = await within(start({ timeout_seconds: 0.3 }));
    assert.equal(result.details.exitCode, 0);
    assert.equal(result.details.timedOut, true);
    assert.equal(result.details.passed, false);
    assert.equal(checks(), 0);
  });
});
test('nonzero exit remains an ordinary failure, not timeout', async () => {
  await fixture('echo failed >&2; exit 7\n', async ({ start }) => {
    const result = await within(start({ timeout_seconds: 5 }));
    assert.equal(result.details.exitCode, 7);
    assert.equal(result.details.timedOut, false);
    assert.equal(result.details.passed, false);
    assert.match(result.details.tailOutput, /failed/);
  });
});
test('pre-aborted calls never spawn a benchmark', async () => {
  await fixture('echo unwanted > started\n', async ({ start }) => {
    const controller = new AbortController();
    controller.abort();
    const original = childProcess.spawn;
    let spawns = 0;
    childProcess.spawn = (...args) => { spawns++; return original(...args); };
    syncBuiltinESMExports();
    try {
      await assert.rejects(within(start({ timeout_seconds: 0 }, controller.signal)), /^Error: aborted$/);
      assert.equal(spawns, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  });
});

test('escalation still terminates same-group descendants after all child pipes close', { skip: process.platform !== 'linux' }, async () => {
  await fixture(`echo $$ > group.pid\ntrap 'exit 0' TERM\nbash -c 'trap "" TERM; echo $BASHPID > desc.pid; echo ready > ready; sleep 20' >/dev/null 2>&1 &\nwait\n`, async ({ cwd, start }) => {
    const result = await within(start({ timeout_seconds: 0.3 }));
    assert.equal(result.details.timedOut, true);
    const pid = Number(await eventuallyFile(join(cwd, 'desc.pid')));
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try {
        // Linux may briefly retain a killed orphan as a zombie until PID 1 reaps it.
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        if (/\) Z /.test(stat)) return;
      } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      await delay(10);
    }
    assert.fail('same-group descendant survived escalation');
  });
});
test('completed cancellation does not poison the next run', async () => {
  await fixture(stubborn, async ({ cwd, start }) => {
    const controller = new AbortController();
    const pending = start({ timeout_seconds: 0 }, controller.signal);
    await eventuallyFile(join(cwd, 'ready'));
    controller.abort();
    await assert.rejects(within(pending), /^Error: aborted$/);
    const fresh = await within(start({ command: 'printf "METRIC latency=3\\n"', timeout_seconds: 1 }));
    assert.equal(fresh.details.passed, true);
    assert.deepEqual(fresh.details.parsedMetrics, { latency: 3 });
  });
});
