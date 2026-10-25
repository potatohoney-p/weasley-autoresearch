import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { steerMessageFor } from '../extensions/weasley-autoresearch/hooks.ts';

const exec = promisify(execFile);
const moduleUrl = new URL('../extensions/weasley-autoresearch/hooks.ts', import.meta.url).href;

async function invoke(script, stage = 'before', options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'hook-input-'));
  try {
    await mkdir(join(cwd, '.auto/hooks'), { recursive: true });
    await writeFile(join(cwd, '.auto/hooks', `${stage}.sh`), script, { mode: 0o755 });
    const code = `
      import {readFileSync,writeFileSync} from "node:fs";
      import {runHook, steerMessageFor, hookLogEntry, appendHookLogEntryIfConfigured} from ${JSON.stringify(moduleUrl)};
      const result = await runHook({event:${JSON.stringify(stage)},cwd:${JSON.stringify(cwd)},
        next_run:1,last_run:null,session:{goal:'x'.repeat(8*1024*1024)}});
      const logPath = ${JSON.stringify(join(cwd, "log.jsonl"))};
      writeFileSync(logPath, JSON.stringify({type:"config"})+"\\n");
      appendHookLogEntryIfConfigured(logPath, ${JSON.stringify(stage)}, result);
      const persisted = JSON.parse(readFileSync(logPath,"utf8").trim().split("\\n").at(-1));
      console.log(JSON.stringify({result,persisted,message:steerMessageFor(${JSON.stringify(stage)},result),
        log:hookLogEntry(${JSON.stringify(stage)},result)}));
    `;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code], {
      timeout: 10000, maxBuffer: 1024 * 1024, ...options
    });
    return JSON.parse(stdout);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

for (const stage of ['before', 'after']) {
  test(`${stage} hook early exit cannot crash its host on a large payload`, async () => {
    const { result, message, log, persisted } = await invoke('#!/bin/bash\nexit 0\n', stage);
    assert.equal(result.fired, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdinError, /EPIPE|ECONNRESET/);
    assert.match(message, /input delivery failed/);
    assert.equal(log.stdin_error, result.stdinError);
    assert.equal(log.exit_code, 0);
    assert.equal(persisted.stdin_error, result.stdinError);
  });
}

test('closed stdin retains actual nonzero exit and diagnostic output', async () => {
  const { result, message } = await invoke('#!/bin/bash\nexec 0<&-\nprintf "out"\nprintf "err" >&2\nsleep 0.05\nexit 7\n');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.match(message, /input delivery failed/);
  assert.match(message, /out/);
  assert.match(message, /err/);
});

test('fully consumed large payload retains successful hook behavior', async () => {
  const { result, message, log } = await invoke('#!/bin/bash\ncat >/dev/null\nprintf "accepted"\n');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdinError, undefined);
  assert.equal(message, 'accepted');
  assert.equal(Object.hasOwn(log, 'stdin_error'), false);
});

test('spawn failure remains a handled result even with queued stdin', async () => {
  const { result, message } = await invoke('#!/bin/bash\nexit 0\n', 'before', {
    env: { ...process.env, PATH: '/nonexistent-hook-test-path' }
  });
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /ENOENT/);
  assert.match(message, /ENOENT/);
});


test('timeout steering preserves a simultaneous input-delivery failure', () => {
  const result = { fired: true, stdout: '', stderr: '', exitCode: null, timedOut: true, durationMs: 30000 };
  assert.equal(steerMessageFor('before', result), '[before hook timed out after 30s]');
  const message = steerMessageFor('before', { ...result, stdinError: 'write EPIPE' });
  assert.match(message, /timed out after 30s/);
  assert.match(message, /input delivery failed: write EPIPE/);
});
