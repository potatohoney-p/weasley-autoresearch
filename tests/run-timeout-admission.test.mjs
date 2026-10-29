import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import autoresearchExtension from '../extensions/weasley-autoresearch/index.ts';
async function workspace() {
 const cwd = await mkdtemp(join(tmpdir(), 'weasley-timeout-'));
 execFileSync('git', ['init', '--quiet'], {cwd});
 execFileSync('git', ['-c', 'user.name=Weasley Tests', '-c', 'user.email=tests@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'initial'], {cwd});
 await writeFile(join(cwd, '.gitignore'), 'marker\n');
 return cwd;
}
function harness(cwd) {
 const tools=new Map();const calls=[];
 autoresearchExtension({on(){},registerTool(t){tools.set(t.name,t)},registerCommand(){},registerShortcut(){},exec:async(...args)=>{calls.push(args);return {code:0,killed:false,stdout:'',stderr:''}}});
 const ctx={cwd,hasUI:false,sessionManager:{getSessionId:()=>cwd,getBranch:()=>[]}};
 return {tool:tools.get('run_experiment'),calls,ctx};
}
for(const field of ['timeout_seconds','checks_timeout_seconds']) {
 for(const [label,value] of [['negative',-1],['overflow',2147483.648],['infinity',Infinity],['nan',NaN],['string','1'],['null',null]]) {
 test(`${field} rejects ${label} before benchmark side effects`,async()=>{
 const cwd=await workspace(); try {
 const {tool,calls,ctx}=harness(cwd);
 const result=await tool.execute('test',{command:'printf ran > marker', [field]:value},undefined,undefined,ctx);
 assert.match(result.content[0].text,new RegExp(`Invalid ${field}`));
 assert.equal(existsSync(join(cwd,'marker')),false);assert.equal(calls.length,0);
 }finally{await rm(cwd,{recursive:true,force:true})}
 });}
}
for(const [label,value,expected] of [['default',undefined,300000],['zero',0,0],['fraction',0.1239,123],['submillisecond',0.0001,1],['maximum',2147483.647,2147483647]]) {
 test(`valid ${label} timeout runs and passes bounded milliseconds to checks`,async()=>{
 const cwd=await workspace();try{
 await writeFile(join(cwd,'autoresearch.checks.sh'),'exit 0\n');
 const {tool,calls,ctx}=harness(cwd);
 const result=await tool.execute('test',{command:'printf ran > marker',timeout_seconds: value !== undefined && value > 0 && value < 1 ? 2 : value,checks_timeout_seconds:value},undefined,undefined,ctx);
 assert.equal(await readFile(join(cwd,'marker'),'utf8'),'ran');assert.equal(result.details.passed,true);
 assert.equal(calls.length,1);assert.equal(calls[0][2].timeout,expected);
 }finally{await rm(cwd,{recursive:true,force:true})}
 });
}
test('run schema advertises bounded timeout numbers',()=>{
 const {tool}=harness('/tmp');for(const field of ['timeout_seconds','checks_timeout_seconds']){
 assert.equal(tool.parameters.properties[field].minimum,0);
 assert.equal(tool.parameters.properties[field].maximum,2147483.647);
 }
});
test('positive fractional benchmark timeout still terminates a slow command', async () => {
 const cwd=await workspace();try {
 const {tool,ctx}=harness(cwd);
 const result=await tool.execute('test',{command:'sleep 2',timeout_seconds:0.05},undefined,undefined,ctx);
 assert.equal(result.details.timedOut,true);
 assert.equal(result.details.passed,false);
 }finally{await rm(cwd,{recursive:true,force:true})}
});
