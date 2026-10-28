import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import autoresearch from '../../extensions/weasley-autoresearch/index.ts';
const scenario = process.argv[2];
const cwd = await mkdtemp(join(tmpdir(), 'progress-observer-'));
await exec('git',['init','--quiet'],{cwd});
await writeFile(join(cwd,'.gitignore'),'executions\nrelease\nnext-release\n');
await exec('git',['add','.gitignore'],{cwd});
await exec('git',['-c','user.name=Tests','-c','user.email=tests@example.invalid','commit','--allow-empty','--quiet','-m','fixture'],{cwd});
const tools = new Map();
let checks = 0;
autoresearch({ on() {}, registerTool(t) { tools.set(t.name,t); }, registerCommand() {}, registerShortcut() {},
  exec: async (command,args,options) => {
    if(command === 'bash') { checks++; return { code: 1, stdout: '', stderr: 'expected check failure', killed: false }; }
    try { const output=await exec(command,args,{cwd:options?.cwd || cwd}); return {...output,code:0,killed:false}; }
    catch(error) { return {code:typeof error.code==='number'?error.code:1,stdout:error.stdout||'',stderr:error.stderr||'',killed:false}; }
  }
});
const ctx = { cwd, hasUI:false, sessionManager:{ getSessionId:()=>cwd } };
const run = tools.get('run_experiment');
let calls = 0;
const observer = () => {
  calls++;
  if (scenario === 'second' && calls === 1) return;
  if (!['abort','timeout'].includes(scenario)) writeFileSync(join(cwd,'release'),'ok');
  if (scenario === 'healthy') return;
  if (scenario === 'string') throw 'observer failed';
  if (scenario === 'hostile') throw { toString() { throw new Error('must not stringify'); } };
  throw new Error('observer failed');
};
try {
  if (scenario === 'checks') { await mkdir(join(cwd,'.auto')); await writeFile(join(cwd,'.auto','checks.sh'),'exit 1\n'); }
  const controller = new AbortController();
  const abortTimer = scenario === 'abort' ? setTimeout(()=>controller.abort(),1400) : undefined;
  const command = "printf x >> executions; deadline=$((SECONDS + 4)); while [ ! -f release ]; do [ \"$SECONDS\" -lt \"$deadline\" ] || exit 124; sleep 0.05; done; printf 'METRIC score=12.5\\n'; " + (scenario === 'failed' ? 'exit 7' : 'true');
  let result;
  try {
    result = await run.execute('test', {command, timeout_seconds:scenario === 'timeout' ? 1.4 : 5}, controller.signal, observer, ctx);
    assert.notEqual(scenario,'abort');
  } catch (error) {
    if (scenario !== 'abort') throw error;
    assert.match(error.message,/aborted/);
  } finally { if(abortTimer) clearTimeout(abortTimer); }
  assert.equal(await readFile(join(cwd,'executions'),'utf8'),'x','benchmark must execute once');
  assert.equal(calls,scenario === 'second' ? 2 : 1);
  if (result) {
    assert.equal(result.details.progressUpdateFailed,scenario === 'healthy' ? undefined : true);
    assert.equal(result.content[0].text.includes('Progress updates stopped'),scenario !== 'healthy');
    assert.equal(result.details.passed,!['failed','timeout','checks'].includes(scenario));
    if(scenario === 'failed') assert.equal(result.details.exitCode,7);
    if(scenario === 'timeout') assert.equal(result.details.timedOut,true);
    if(scenario === 'checks') { assert.equal(checks,1); assert.equal(result.details.checksPass,false); }
    if(!['timeout'].includes(scenario)) assert.equal(result.details.parsedMetrics.score,12.5);
  }
  let nextCalls=0;
  const next = await run.execute('next',{command:'deadline=$((SECONDS + 4)); while [ ! -f next-release ]; do [ "$SECONDS" -lt "$deadline" ] || exit 124; sleep 0.05; done; echo next',timeout_seconds:5},undefined,()=>{nextCalls++; writeFileSync(join(cwd,'next-release'),'ok');},ctx);
  assert.equal(nextCalls,1,'later runs must get their own working observer');
  assert.equal(next.details.progressUpdateFailed,undefined);
  assert.equal(next.content[0].text.includes('Progress updates stopped'),false);
  // A failure must not leave a live progress interval behind after the run settles.
  assert.equal(calls,scenario === 'second' ? 2 : 1);
  console.log(JSON.stringify({scenario,calls,checks,verified:true}));
} finally { await rm(cwd,{recursive:true,force:true}); }
