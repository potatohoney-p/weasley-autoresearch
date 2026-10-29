import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const source = new URL('../extensions/weasley-autoresearch/index.ts', import.meta.url).href;
function probe(mode) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'output-persistence-'));
  execFileSync('git',['init','--quiet'],{cwd});
  execFileSync('git',['-c','user.name=Weasley Tests','-c','user.email=tests@example.invalid','commit','--allow-empty','--quiet','-m','fixture'],{cwd});
  try {
    return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import fs from 'node:fs';
      import { Writable } from 'node:stream';
      import { syncBuiltinESMExports } from 'node:module';
      const mode = ${JSON.stringify(mode)};
      let finalStarted, finalFinished;
      const realCreateWriteStream = fs.createWriteStream;
      if (mode === 'directory') fs.createWriteStream = () => realCreateWriteStream(${JSON.stringify(cwd)});
      if (mode === 'throw') fs.createWriteStream = () => { throw new Error('synthetic constructor failure') };
      if (mode === 'close') fs.createWriteStream = () => new Writable({write(c,e,cb){this.destroy();cb()}});
      if (mode === 'open') fs.createWriteStream = () => new Writable({write(c,e,cb){cb(new Error('synthetic open failure'))}});
      if (mode === 'finish') fs.createWriteStream = () => new Writable({write(c,e,cb){cb()},final(cb){setTimeout(()=>cb(new Error('synthetic final failure')),30)}});
      if (mode === 'slow' || mode === 'timing') fs.createWriteStream = (p) => { const chunks=[]; return new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb()},final(cb){finalStarted=Date.now();setTimeout(()=>{fs.writeFileSync(p, Buffer.concat(chunks));finalFinished=Date.now();cb()}, mode === 'timing' ? 500 : 60)}}) };
      syncBuiltinESMExports();
      const {default: extension} = await import(${JSON.stringify(source)});
      const tools = new Map();
      extension({on(){},registerTool(t){tools.set(t.name,t)},registerCommand(){},registerShortcut(){},getActiveTools(){return []},setActiveTools(){}});
      const ctx={cwd:${JSON.stringify(cwd)},hasUI:false,sessionManager:{getSessionId:()=> 'probe',getBranch:()=>[]}};
      try {
        const started=Date.now();
        const r=await tools.get('run_experiment').execute('test',{command: "printf '%070000d' 0",timeout_seconds:2},undefined,undefined,ctx);
        const p=r.details.fullOutputPath;
        const bytes=p && fs.existsSync(p)?fs.statSync(p).size:0;
        if(p && fs.existsSync(p)) fs.unlinkSync(p);
        console.log(JSON.stringify(mode === 'timing' ? {ok:true,bytes,duration:r.details.durationSeconds,elapsed:(Date.now()-started)/1000,flush:(finalFinished-finalStarted)/1000} : {ok:true,bytes}));
      }catch(e){ console.log(JSON.stringify({ok:false,message:e.message})); }
    `], {encoding:'utf8',timeout:8000}));
  } finally { rmSync(cwd,{recursive:true,force:true}); }
}
for (const mode of ['open','finish']) test(`output ${mode} errors are returned without host crash`,()=> {
  const r=probe(mode); assert.equal(r.ok,false); assert.match(r.message,/synthetic .* failure/);
});
test('full output is finished before its path is returned',()=>assert.deepEqual(probe('slow'),{ok:true,bytes:70000}));
test('real output file contains all bytes on return',()=>assert.deepEqual(probe('real'),{ok:true,bytes:70000}));

test('actual directory open failure returns EISDIR without crashing',()=> {
  const r=probe('directory'); assert.equal(r.ok,false); assert.match(r.message,/EISDIR/);
});
test('synchronous output construction failure is contained',()=> {
  const r=probe('throw'); assert.equal(r.ok,false); assert.match(r.message,/constructor failure/);
});
test('premature stream closure rejects instead of hanging',()=> {
  const r=probe('close'); assert.equal(r.ok,false); assert.match(r.message,/closed before finishing/);
});

test('artifact finalization latency is excluded from benchmark duration',()=> {
  const r=probe('timing');
  assert.equal(r.ok,true); assert.equal(r.bytes,70000);
  assert.ok(r.flush>=0.45,JSON.stringify(r));
  assert.ok(r.elapsed-r.duration>=0.45,JSON.stringify(r));
});
