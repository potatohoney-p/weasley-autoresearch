import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import autoresearch from '../extensions/weasley-autoresearch/index.ts';
import { reconstructJsonlState } from '../extensions/weasley-autoresearch/jsonl.ts';

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

for (const [direction, values, best] of [
  ['lower', [2, 1, 0], 0], ['lower', [-1, -2, -3], -3],
  ['higher', [-3, -2, -1], -1], ['higher', [-2, -1, 0], 0],
]) {
 test(`dashboard includes signed kept metrics: ${direction} ${values}`, async () => {
  const output = await dashboard([
   {type:'config', metricName:'score', bestDirection:direction},
   ...values.map((metric,i)=>({...row(i+1,{}),metric})),
  ]);
  assert.match(output, new RegExp(`Progress:.*score: ${best}(?:\\s|$).*#3`));
  assert.match(output, /conf: 2\.0×/);
 });
}
test('crash placeholder is excluded from signed metric confidence', async () => {
 const output=await dashboard([
  {type:'config',metricName:'score'},
  {...row(1,{}),metric:-1}, {...row(2,{}),metric:-2}, {...row(3,{}),metric:-3},
  {...row(4,{}),metric:0,status:'crash'},
 ]);
 assert.match(output,/conf: 2\.0×/);
 assert.match(output,/Progress:.*score: -3.*#3/);
});
for (const [baseline, metric, direction] of [[2,0,'lower'],[-2,-1,'higher'],[0,-1,'lower']]) {
 test(`tool result shows signed measured value ${baseline} to ${metric}`,()=>{
  const tools=new Map();
  autoresearch({on(){},registerTool:tool=>tools.set(tool.name,tool),registerCommand(){},registerShortcut(){}});
  const experiment={...row(2,{}),metric};
  const state={results:[{...row(1,{}),metric:baseline},experiment],bestMetric:baseline,
   currentSegment:0,bestDirection:direction,metricName:'score',metricUnit:'',secondaryMetrics:[]};
  const output=tools.get('log_experiment').renderResult({details:{experiment,state},content:[]},{},
   {fg:(_c,s)=>s,bold:s=>s}).render(200).join('\n');
  assert.match(output,new RegExp(`score: ${metric}\\)`));
  assert.match(output,new RegExp(`best: ${metric}(?:\\s|$)`));
 });
}
for (const values of [[0,-1,-2],[-2,-1,0],[3,2,1]]) {
 test(`percent formatting preserves finite direction for ${values}`,async()=>{
  const output=await dashboard([{type:'config',metricName:'score',bestDirection:values[0]<values[2]?'higher':'lower'},
   ...values.map((metric,i)=>({...row(i+1,{}),metric}))]);
  const progress=output.split('\n').find(line=>line.includes('Progress:'));
  assert.ok(progress);
  assert.doesNotMatch(progress,/NaN|Infinity/);
  if(values[0]===0) assert.doesNotMatch(progress,/%/);
  else if(values[0]<0) assert.match(progress,/\+100\.0%/);
  else assert.match(progress,/-66\.7%/);
 });
}
