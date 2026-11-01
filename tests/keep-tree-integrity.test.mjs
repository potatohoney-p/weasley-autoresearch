import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { commitKeptCandidate } from '../extensions/weasley-autoresearch/keep.ts';
const exec = promisify(execFile);
async function fixture(t) {
 const cwd = await mkdtemp(join(tmpdir(), 'keep-tree-'));
 t.after(() => rm(cwd,{recursive:true,force:true}));
 const git = async (...args) => (await exec('git',args,{cwd})).stdout.trim();
 await git('init','--quiet'); await git('config','user.name','Test'); await git('config','user.email','test@example.invalid');
 await writeFile(join(cwd,'candidate.txt'),'baseline\n'); await git('add','.'); await git('commit','--quiet','-m','baseline');
 const before = await git('rev-parse','HEAD');
 await writeFile(join(cwd,'candidate.txt'),'measured\n');
 const calls=[];
 const run = async (command,args) => { calls.push(args); try { return {code:0,...await exec(command,args,{cwd})}; } catch(e) { return {code:e.code,stdout:e.stdout??'',stderr:e.stderr??''}; } };
 return {cwd,git,before,calls,run};
}
test('pre-commit staged rewrites cannot be published as the measured keep', async t => {
 const h=await fixture(t);
 const hook=join(h.cwd,'.git/hooks/pre-commit');
 await writeFile(hook,'#!/bin/sh\nprintf "unmeasured\\n" > candidate.txt\ngit add candidate.txt\n'); await chmod(hook,0o755);
 const result=await commitKeptCandidate(h.run,h.cwd,'candidate');
 assert.equal(result.ok,false); assert.equal(result.uncertain,true);
 assert.match(result.message,/tree.*changed|tree.*match/i);
 assert.notEqual(await h.git('rev-parse','HEAD'),h.before,'created commit is preserved for reconciliation');
 assert.equal(await readFile(join(h.cwd,'candidate.txt'),'utf8'),'unmeasured\n');
 assert.equal(h.calls.filter(a=>a[0]==='commit').length,1);
 assert.equal(h.calls.some(a=>['reset','revert','checkout'].includes(a[0])),false);
});
test('ordinary commit still verifies the staged tree and parent', async t => {
 const h=await fixture(t); const result=await commitKeptCandidate(h.run,h.cwd,'candidate');
 assert.equal(result.ok,true); assert.equal(result.createdCommit,true);
 assert.equal(await h.git('rev-parse',`${result.commit}^`),h.before);
 assert.equal(await h.git('show',`${result.commit}:candidate.txt`),'measured');
});
test('post-commit HEAD replacement with the same tree requires reconciliation', async t => {
 const h=await fixture(t);
 const hook=join(h.cwd,'.git/hooks/post-commit');
 await writeFile(hook, '#!/bin/sh\noriginal=$(git rev-parse HEAD)\ntree=$(git rev-parse HEAD^{tree})\nreplacement=$(printf "hook replacement\\n" | git commit-tree "$tree" -p "$original")\ngit update-ref HEAD "$replacement" "$original"\n');
 await chmod(hook,0o755);
 const result=await commitKeptCandidate(h.run,h.cwd,'candidate');
 assert.equal(result.ok,false); assert.equal(result.uncertain,true);
 assert.match(result.message,/parent/);
 assert.equal(await h.git('rev-parse','HEAD~2'),h.before,'both commits remain intact');
 assert.equal(h.calls.filter(a=>a[0]==='commit').length,1);
});
