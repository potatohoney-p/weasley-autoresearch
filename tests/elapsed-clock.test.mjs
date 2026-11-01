import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import autoresearch from '../extensions/weasley-autoresearch/index.ts';
import { runHook } from '../extensions/weasley-autoresearch/hooks.ts';

async function fixture(t, execChecks) {
  const cwd = fs.mkdtempSync(join(tmpdir(), 'elapsed-clock-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd });
  fs.writeFileSync(join(cwd, '.gitignore'), 'release\n');
  execFileSync('git', ['add', '.gitignore'], { cwd });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd });
  const tools = new Map();
  autoresearch({ on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {},
    exec: execChecks ?? (async () => ({ code: 0, stdout: '', stderr: '' })) });
  const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => cwd } };
  return { cwd, run: (command, onUpdate) => tools.get('run_experiment').execute('test', { command, timeout_seconds: 5 }, undefined, onUpdate, ctx) };
}

for (const shift of [-60_000, 60_000]) {
  test(`benchmark elapsed time ignores a ${shift}ms wall-clock step`, async t => {
    const h = await fixture(t);
    const original = Date.now;
    let offset = 0;
    Date.now = () => original() + offset;
    let callbacks = 0;
    try {
      const result = await h.run('while [ ! -f release ]; do sleep 0.01; done; echo done', () => {
        callbacks++;
        offset = shift;
        fs.writeFileSync(join(h.cwd, 'release'), 'ok');
      });
      assert.equal(callbacks, 1);
      assert.equal(result.details.passed, true);
      assert.ok(result.details.durationSeconds >= 0.9 && result.details.durationSeconds < 5, `duration=${result.details.durationSeconds}`);
    } finally { Date.now = original; }
  });
  for (const rejects of [false, true]) {
    test(`checks elapsed time ignores ${shift}ms wall-clock step (${rejects ? 'reject' : 'success'})`, async t => {
      const original = Date.now;
      let offset = 0;
      const h = await fixture(t, async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        offset = shift;
        if (rejects) throw new Error('expected check failure');
        return { code: 0, stdout: '', stderr: '' };
      });
      fs.mkdirSync(join(h.cwd, '.auto'));
      fs.writeFileSync(join(h.cwd, '.auto', 'checks.sh'), 'exit 0\n');
      Date.now = () => original() + offset;
      try {
        const result = await h.run('echo done');
        assert.equal(result.details.checksPass, !rejects);
        assert.ok(result.details.checksDuration >= 0.01 && result.details.checksDuration < 5, `duration=${result.details.checksDuration}`);
      } finally { Date.now = original; }
    });
  }
  test(`hook elapsed time ignores a ${shift}ms wall-clock step`, async t => {
    const h = await fixture(t);
    fs.mkdirSync(join(h.cwd, '.auto', 'hooks'), { recursive: true });
    fs.writeFileSync(join(h.cwd, '.auto', 'hooks', 'before.sh'), 'cat >/dev/null\necho ok\n', { mode: 0o755 });
    const original = Date.now;
    let calls = 0;
    Date.now = () => original() + (calls++ ? shift : 0);
    try {
      const result = await runHook({ event: 'before', cwd: h.cwd, next_run: 1, last_run: null, session: {} });
      assert.equal(result.exitCode, 0);
      assert.ok(result.durationMs >= 0 && result.durationMs < 5_000, `duration=${result.durationMs}`);
    } finally { Date.now = original; }
  });
}
