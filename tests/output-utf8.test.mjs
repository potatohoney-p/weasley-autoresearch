import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import extension from '../extensions/weasley-autoresearch/index.ts';
async function run(script, update) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'utf8-output-'));
 execFileSync('git',['init','-q'],{cwd});
 execFileSync('git',['-c','user.name=Tests','-c','user.email=tests@example.invalid','commit','--allow-empty','-qm','fixture'],{cwd});
 const tools=new Map();extension({on(){},registerTool(t){tools.set(t.name,t)},registerCommand(){},registerShortcut(){},getActiveTools(){return[]},setActiveTools(){}});
 const ctx={cwd,hasUI:false,sessionManager:{getSessionId:()=> 'utf8',getBranch:()=>[]}};
 try {const r=await tools.get('run_experiment').execute('test',{command:`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,timeout_seconds:5},undefined,update,ctx); const raw=r.details.fullOutputPath?fs.readFileSync(r.details.fullOutputPath):null; if(r.details.fullOutputPath)fs.unlinkSync(r.details.fullOutputPath);return {r,raw};}finally{fs.rmSync(cwd,{recursive:true,force:true});}
}
const script=(a,b,prefix='')=>`process.stdout.write(${JSON.stringify(prefix)});process.stdout.write(Buffer.from(${JSON.stringify(a)}));setTimeout(()=>{process.stderr.write('stderr\\n');setTimeout(()=>process.stdout.write(Buffer.from(${JSON.stringify(b)})),100)},100)`;
test('interleaved pipes do not split Korean UTF-8 text',async()=>{const {r}=await run(script([0xed],[0x95,0x9c,10]));assert.equal(r.details.tailOutput,'stderr\n한\n');});
test('interleaved pipes do not split four-byte emoji',async()=>{const {r}=await run(script([0xf0,0x9f],[0x98,0x80,10]));assert.equal(r.details.tailOutput,'stderr\n😀\n');});
test('raw artifact retains observed bytes while tail preserves decoded text',async()=>{const {r,raw}=await run(script([0xed],[0x95,0x9c,10],'x'.repeat(70000)+'\n'));assert.ok(raw);assert.ok(raw.includes(Buffer.from([0xed,...Buffer.from('stderr\n'),0x95,0x9c,10])));assert.match(r.details.tailOutput,/stderr\n한(?:\n)?$/);});
test('incomplete codepoint at EOF is replaced only within its own pipe',async()=>{const {r}=await run(script([0xed],[]));assert.equal(r.details.tailOutput,'stderr\n�');});
test('ordinary ASCII ordering remains unchanged',async()=>{const {r}=await run(script([...Buffer.from('first\n')],[...Buffer.from('last\n')]));assert.equal(r.details.tailOutput,'first\nstderr\nlast\n');});
test('progress does not expose incomplete codepoints as replacement characters',async()=>{const updates=[];const {r}=await run("process.stdout.write(Buffer.from([0xed]));setTimeout(()=>process.stderr.write('ready\\n'),100);setTimeout(()=>process.stdout.write(Buffer.from([0x95,0x9c,10])),1400)",u=>updates.push(u.content[0].text));assert.ok(updates.length);assert.ok(updates.every(x=>!x.includes('�')));assert.equal(r.details.tailOutput,'ready\n한\n');});
test('stderr decoder is independent of stdout too',async()=>{const {r}=await run("process.stderr.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>{process.stdout.write('out\\n');setTimeout(()=>process.stderr.write(Buffer.from([0x98,0x80,10])),100)},100)");assert.equal(r.details.tailOutput,'out\n😀\n');});
