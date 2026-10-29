import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
for (const scenario of ['error','string','hostile','second','failed','checks','timeout','abort','healthy']) {
  test(`progress observer: ${scenario}`, {timeout:15000},async()=> {
    const {stdout} = await exec(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./fixtures/progress-observer.mjs',import.meta.url)),scenario],{timeout:12000});
    assert.equal(JSON.parse(stdout.trim()).verified,true);
  });
}
