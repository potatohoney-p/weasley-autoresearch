import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHook, steerMessageFor } from '../extensions/weasley-autoresearch/hooks.ts';

test('failed hooks bound stderr before returning steering context', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hook-output-'));
  try {
    mkdirSync(join(cwd, '.auto/hooks'), { recursive: true });
    writeFileSync(join(cwd, '.auto/hooks/before.sh'), '#!/usr/bin/env bash\nhead -c 20000 /dev/zero | tr "\\0" x >&2\nexit 1\n', { mode: 0o755 });
    const result = await runHook({ event: 'before', cwd, next_run: 1, last_run: null, session: {} });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, 'x'.repeat(8192) + '\n…[truncated: hook stderr exceeded 8KB]');
    assert.ok(Buffer.byteLength(steerMessageFor('before', result)) < 8300);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

import { createHookOutputCollector } from '../extensions/weasley-autoresearch/hooks.ts';
for (const stream of ['stdout', 'stderr']) {
  test(`${stream} preserves UTF-8 split across every byte`, () => {
    const collector = createHookOutputCollector(stream);
    for (const byte of Buffer.from('a한😀é\nz')) collector.append(Buffer.from([byte]));
    assert.equal(collector.text(), 'a한😀é\nz');
  });
  test(`${stream} keeps exact cap without false truncation`, () => {
    const collector = createHookOutputCollector(stream);
    collector.append(Buffer.from('x'.repeat(8188) + '😀'));
    assert.equal(collector.text(), 'x'.repeat(8188) + '😀');
    collector.append(Buffer.from('extra'));
    assert.equal(collector.text(), 'x'.repeat(8188) + '😀' + `\n…[truncated: hook ${stream} exceeded 8KB]`);
  });
  test(`${stream} drops only a cap-split code point and keeps draining`, () => {
    const collector = createHookOutputCollector(stream);
    collector.append(Buffer.from('x'.repeat(8191) + '😀'));
    collector.append(Buffer.alloc(100000, 120));
    assert.equal(collector.text(), 'x'.repeat(8191) + `\n…[truncated: hook ${stream} exceeded 8KB]`);
  });
}

for (const stream of ['stdout', 'stderr']) {
  test(`real hook ${stream} preserves fragmented UTF-8`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hook-utf8-'));
    try {
      mkdirSync(join(cwd, '.auto/hooks'), { recursive: true });
      const redirect = stream === 'stderr' ? ' >&2' : '';
      const script = '#!/usr/bin/env bash\n' + ['\\355', '\\225', '\\234'].map(byte => `printf '${byte}'${redirect}\nsleep 0.05\n`).join('');
      writeFileSync(join(cwd, '.auto/hooks/before.sh'), script, { mode: 0o755 });
      const result = await runHook({ event: 'before', cwd, next_run: 1, last_run: null, session: {} });
      assert.equal(result.exitCode, 0);
      assert.equal(result[stream], '한');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
