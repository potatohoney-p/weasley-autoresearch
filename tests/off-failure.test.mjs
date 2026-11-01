import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension from '../extensions/weasley-autoresearch/index.ts';

for (const failure of ['appendEntry', 'getActiveTools', 'setActiveTools', 'setWidget', 'abort', 'multiple']) {
  test(`emergency off completes independent stop actions after ${failure} failure`, async t => {
    const cwd = fs.mkdtempSync(join(tmpdir(), 'auto-off-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet'], { cwd });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'initial'], { cwd });
    const tools = new Map(), commands = new Map(), handlers = new Map(), attempted = [], notices = [];
    let inject = false, active = ['read'];
    const check = name => { attempted.push(name); if (inject && (failure === name || failure === 'multiple')) throw Error(`injected ${name}`); };
    extension({
      on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool),
      registerCommand: (name, command) => commands.set(name, command), registerShortcut() {},
      appendEntry() { check('appendEntry'); }, getActiveTools() { check('getActiveTools'); return active; },
      setActiveTools(next) { check('setActiveTools'); active = next; }, sendUserMessage() {},
    });
    const ctx = { cwd, hasUI: true, isIdle: () => false, hasPendingMessages: () => false,
      abort() { check('abort'); }, sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
      ui: { notify: (message, level) => notices.push({ message, level }), setWidget() { check('setWidget'); } } };
    await commands.get('autoresearch').handler('test goal', ctx);
    assert.ok(active.includes('run_experiment'));
    attempted.length = 0; inject = true;
    await assert.doesNotReject(() => commands.get('autoresearch').handler('off', ctx));
    assert.ok(attempted.includes('abort'), 'host failure must not skip abort');
    assert.ok(attempted.includes('appendEntry'), 'attempt durable OFF even if disabling tools fails');
    assert.ok(attempted.includes('getActiveTools'), 'attempt disabling tools even if persistence fails');
    assert.ok(attempted.includes('setWidget'), 'attempt clearing UI independently');
    assert.ok(notices.some(n => n.level === 'warning' && n.message.includes('injected')), 'surface partial stop failure');
    // Even stale tool registrations must fail closed on the internal mode flag.
    const result = await tools.get('run_experiment').execute('test', { command: 'exit 0' }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not active|OFF|not activated/i);
    if (failure === 'getActiveTools' || failure === 'setActiveTools') {
      await assert.rejects(() => commands.get('autoresearch').handler('resume test', ctx));
      const stopped = await tools.get('run_experiment').execute('test2', { command: 'exit 0' }, undefined, undefined, ctx);
      assert.equal(stopped.isError, true, 'failed resume must preserve stop guard');
      assert.match(stopped.content[0].text, /mode OFF/);
    }
    inject = false;
    await commands.get('autoresearch').handler('off', ctx);
    assert.deepEqual(active, ['read']);
    await commands.get('autoresearch').handler('resume test', ctx);
    assert.ok(active.includes('run_experiment'));
    assert.equal((await tools.get('init_experiment').execute('init', { name: 'new', metric_name: 'score' }, undefined, undefined, ctx)).isError, undefined);
    handlers.get('session_shutdown')({}, ctx);
  });
}
