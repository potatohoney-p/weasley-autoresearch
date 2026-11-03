import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appendJsonlRecord} from '../extensions/weasley-autoresearch/jsonl.ts';
import {appendHookLogEntryIfConfigured} from '../extensions/weasley-autoresearch/hooks.ts';
function fixture(t) {const root=mkdtempSync(join(tmpdir(),'jsonl-boundary-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return join(root,'log.jsonl');}
for(const [label,before,separator] of [
 ['empty','', ''],['newline','{"before":1}\n',''],['unterminated','{"before":1}','\n'],
 ['crlf','{"before":1}\r\n',''],['trailing CR','{"before":1}\r','\n'],
 ['whitespace','{"before":1}\n  \t','\n'],['multibyte','{"before":"가나다"}','\n'],
 ['large record','{"before":"'+'a'.repeat(140000)+'"}','\n'],
 ['large prefix small tail','{"prefix":"'+'b'.repeat(140000)+'"}\n{"before":1}','\n'],
]) test(`JSONL append preserves ${label}`,t=>{
 const file=fixture(t);writeFileSync(file,before);
 appendJsonlRecord(file,'{"next":2}');
 assert.equal(readFileSync(file,'utf8'),before+separator+'{"next":2}\n');
});
test('missing file is created',t=>{const file=fixture(t);appendJsonlRecord(file,'{"next":2}');assert.equal(readFileSync(file,'utf8'),'{"next":2}\n');});
for(const tail of ['{"partial":','null','[]','123','true','"string"']) test(`rejects invalid final record ${tail}`,t=>{
 const file=fixture(t);const before='{"type":"config"}\n'+tail;writeFileSync(file,before);
 assert.throws(()=>appendJsonlRecord(file,'{"next":2}'),/reconcile/);
 assert.equal(readFileSync(file,'utf8'),before);
});
const hook={fired:true,stdout:'',stderr:'',exitCode:0,timedOut:false,durationMs:1};
test('configured hook inserts boundary after complete config',t=>{
 const file=fixture(t);const before='{"type":"config","name":"fixture"}';writeFileSync(file,before);
 assert.equal(appendHookLogEntryIfConfigured(file,'after',hook),true);
 const records=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(records.length,2);assert.equal(records[1].type,'hook');
});
test('hook refuses incomplete final record without modifying history',t=>{
 const file=fixture(t);const before='{"type":"config"}\n{"partial":';writeFileSync(file,before);
 assert.equal(appendHookLogEntryIfConfigured(file,'after',hook),false);assert.equal(readFileSync(file,'utf8'),before);
});
test('unconfigured hook does not create a log',t=>{const file=fixture(t);assert.equal(appendHookLogEntryIfConfigured(file,'after',hook),false);assert.equal(existsSync(file),false);});
