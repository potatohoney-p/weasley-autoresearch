import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import autoresearch from '../extensions/weasley-autoresearch/index.ts';
import { reconstructJsonlState } from '../extensions/weasley-autoresearch/jsonl.ts';
const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const row = (run, metrics, segment = 0) => ({run, metric: 100-run, metrics, status:'keep', commit:'abcdef0', description:'fixture', timestamp:run, segment});
async function dashboard(records) {
    const cwd = await mkdtemp(join(tmpdir(), 'ar-metric-key-'));
    try {
      execFileSync('git', ['init', '--quiet'], {cwd});
      await mkdir(join(cwd,'.auto'));
      await writeFile(join(cwd,'.auto/log.jsonl'), records.map(x=>JSON.stringify(x)).join('\n')+'\n');
      const handlers = new Map(); let widget;
      autoresearch({on:(n,h)=>handlers.set(n,h),registerTool(){},registerCommand(){},registerShortcut(){},appendEntry(){},getActiveTools:()=>[],setActiveTools(){}});
      const ctx={cwd,hasUI:true,isIdle:()=>true,hasPendingMessages:()=>false,sessionManager:{getSessionId:()=>cwd,getBranch:()=>[]},ui:{setWidget:(_n,w)=>widget=w,notify(){}}};
      await handlers.get('session_start')({},ctx);
      assert.equal(typeof widget,'function');
      const text=widget({terminal:{columns:200}}, {fg:(_c,s)=>s,bold:s=>s}).render(200).join('\n');
      return text;
    } finally {await rm(cwd,{recursive:true,force:true});}
}
for (const name of names) {
  test(`recovery preserves own metric ${name}`, () => {
    const input = row(1, Object.fromEntries([[name, 42], ['ordinary_ms', 7]]));
    const state = reconstructJsonlState(JSON.stringify(input));
    assert.equal(Object.hasOwn(state.results[0].metrics, name), true);
    assert.equal(state.results[0].metrics[name], 42);
    assert.equal(Object.getPrototypeOf(state.results[0].metrics), Object.prototype);
    assert.deepEqual(Object.keys(state.results[0].metrics), [name, 'ordinary_ms']);
    assert.deepEqual(JSON.parse(JSON.stringify(state.results[0].metrics)), input.metrics);
  });
  test(`dashboard handles late own metric ${name}`, async () => {
    const text = await dashboard([
      {type: 'config', name: 'keys', metricName: 'metric'},
      row(1, {}), row(2, Object.fromEntries([[name, 40]])), row(3, Object.fromEntries([[name, 20]])),
    ]);
    assert.match(text, new RegExp(`${name}: 20`));
    assert.match(text, /-50\.0%/);
    assert.doesNotMatch(text, /NaN|\[object Object\]|function Object/);
  });
  test(`dashboard hides absent recent metric ${name}`, async () => {
    const text = await dashboard([
      {type: 'config', name: 'keys', metricName: 'metric'},
      row(1, Object.fromEntries([[name, 40]])),
      ...Array.from({length: 9}, (_, i) => row(i + 2, {})),
    ]);
    const header = text.split('\n').find(line => line.includes('commit') && line.includes('description'));
    assert.ok(header);
    assert.equal(header.includes(name), false);
    assert.doesNotMatch(text, /NaN|\[object Object\]|function Object/);
  });
}
