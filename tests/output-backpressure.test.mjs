import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
const source=new URL('../extensions/weasley-autoresearch/index.ts',import.meta.url).href;
function probe(mode){
 const cwd=mkdtempSync(path.join(tmpdir(),'output-pressure-'));
 execFileSync('git',['init','--quiet'],{cwd});
 execFileSync('git',['-c','user.name=Tests','-c','user.email=tests@example.invalid','commit','--allow-empty','--quiet','-m','fixture'],{cwd});
 try{return JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
 import fs from 'node:fs'; import {Writable} from 'node:stream'; import {syncBuiltinESMExports} from 'node:module';
 const mode=${JSON.stringify(mode)}; let max=0,bytes=0,a=0,b=0,writes=0,drains=0; const streams=[];
 fs.createWriteStream=()=>{const s=new Writable({highWaterMark:1024,write(c,e,cb){writes++;bytes+=c.length;for(const x of c){if(x===65)a++;if(x===66)b++;}setTimeout(()=>cb(mode==='failure'&&writes===3?new Error('slow sink failure'):undefined),5);}}); const write=s.write.bind(s);s.write=(...args)=>{const result=write(...args);max=Math.max(max,s.writableLength);return result};s.on('drain',()=>drains++);streams.push(s);return s;};syncBuiltinESMExports();
 const {default:extension}=await import(${JSON.stringify(source)});const tools=new Map();extension({on(){},registerTool(t){tools.set(t.name,t)},registerCommand(){},registerShortcut(){},getActiveTools(){return[]},setActiveTools(){}});
 const ctx={cwd:${JSON.stringify(cwd)},hasUI:false,sessionManager:{getSessionId:()=> 'pressure',getBranch:()=>[]}};
 const controller=new AbortController();if(mode==='abort')setTimeout(()=>controller.abort(),80);
 let command=mode==='small'?"printf hello": mode==='timeout'||mode==='abort'?"head -c 4194304 /dev/zero; sleep 1":"head -c 2097152 /dev/zero | tr '\\\\0' A; head -c 2097152 /dev/zero | tr '\\\\0' B >&2";
 if(mode==='concurrent')command="(head -c 2097152 /dev/zero | tr '\\\\0' A) & (head -c 2097152 /dev/zero | tr '\\\\0' B >&2) & wait";
 let result,error;try{result=await tools.get('run_experiment').execute('test',{command,timeout_seconds:mode==='timeout'?0.08:5},controller.signal,undefined,ctx)}catch(e){error=e.message}
 console.log(JSON.stringify({max,bytes,a,b,writes,drains,error,passed:result?.details.passed,timedOut:result?.details.timedOut,tail:mode==='small'?result?.details.tailOutput:undefined,streams:streams.length}));
 `],{encoding:'utf8',timeout:12000}));}finally{rmSync(cwd,{recursive:true,force:true})}
}
test('slow output sink bounds pending bytes and preserves both pipes',()=>{const r=probe('large');assert.equal(r.passed,true);assert.equal(r.a,2097152);assert.equal(r.b,2097152);assert.equal(r.bytes,4194304);assert.ok(r.max<=262144,JSON.stringify(r));assert.ok(r.drains>1);});
test('backpressured timeout settles and stays failed',()=>{const r=probe('timeout');assert.equal(r.passed,false);assert.equal(r.timedOut,true);assert.ok(r.max<=262144,JSON.stringify(r));});
test('backpressured abort settles with cancellation',()=>{const r=probe('abort');assert.equal(r.error,'aborted');assert.ok(r.max<=262144,JSON.stringify(r));});
test('slow sink failure rejects with original storage error',()=>{const r=probe('failure');assert.match(r.error,/slow sink failure/);assert.ok(r.max<=262144,JSON.stringify(r));});
test('small output does not allocate storage',()=>{const r=probe('small');assert.equal(r.passed,true);assert.equal(r.streams,0);assert.equal(r.tail,'hello');});

test('concurrent stdout and stderr share the same bounded sink',()=>{const r=probe('concurrent');assert.equal(r.passed,true);assert.equal(r.a,2097152);assert.equal(r.b,2097152);assert.equal(r.bytes,4194304);assert.ok(r.max<=262144,JSON.stringify(r));});
