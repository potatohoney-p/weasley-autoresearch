import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureCandidateProvenance, resolveBenchmarkPath } from "../extensions/weasley-autoresearch/provenance.ts";

const exec = promisify(execFile);

async function repo(t) {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-provenance-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "--quiet"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await writeFile(join(cwd, "candidate.txt"), "original\n");
  await exec("git", ["add", "candidate.txt"], { cwd });
  await exec("git", ["commit", "--quiet", "-m", "candidate"], { cwd });
  return cwd;
}

test("candidate capture leaves index bytes and modification metadata unchanged", async (t) => {
  const cwd = await repo(t);
  const index = join(cwd, ".git", "index");
  const bytes = await readFile(index);
  const before = await stat(index);
  captureCandidateProvenance(cwd);
  const after = await stat(index);
  assert.deepEqual(await readFile(index), bytes);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
});

test("staging-only contents do not change the eventual git add -A candidate", async (t) => {
  const cwd = await repo(t);
  const original = captureCandidateProvenance(cwd);
  await writeFile(join(cwd, "candidate.txt"), "staged only\n");
  await exec("git", ["add", "candidate.txt"], { cwd });
  await writeFile(join(cwd, "candidate.txt"), "original\n");
  assert.equal(captureCandidateProvenance(cwd), original);
});

test("index executable-mode changes matter when core.filemode is false", async (t) => {
  const cwd = await repo(t);
  await exec("git", ["config", "core.filemode", "false"], { cwd });
  const original = captureCandidateProvenance(cwd);
  await exec("git", ["update-index", "--chmod=+x", "candidate.txt"], { cwd });
  assert.notEqual(captureCandidateProvenance(cwd), original);
});

test("HEAD-only changes invalidate provenance even when candidate bytes are identical", async (t) => {
  const cwd = await repo(t);
  const original = captureCandidateProvenance(cwd);
  await exec("git", ["commit", "--allow-empty", "--quiet", "-m", "new base"], { cwd });
  assert.notEqual(captureCandidateProvenance(cwd), original);
});

test("content changes remain observable with unchanged size and restored mtime", async (t) => {
  const cwd = await repo(t);
  const file = join(cwd, "candidate.txt");
  const before = await stat(file);
  const original = captureCandidateProvenance(cwd);
  await writeFile(file, "modified\n");
  await utimes(file, before.atime, before.mtime);
  assert.notEqual(captureCandidateProvenance(cwd), original);
});

test("Git executable mode follows owner execute permission", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await repo(t);
  await exec("git", ["config", "core.filemode", "true"], { cwd });
  const file = join(cwd, "candidate.txt");
  await chmod(file, 0o644);
  const original = captureCandidateProvenance(cwd);
  await chmod(file, 0o645);
  assert.equal(captureCandidateProvenance(cwd), original);
  await chmod(file, 0o744);
  assert.notEqual(captureCandidateProvenance(cwd), original);
});

test("candidate names with spaces, apostrophes and Unicode are distinct", async (t) => {
  const cwd = await repo(t);
  const name = "researcher's 서울 candidate.txt";
  await writeFile(join(cwd, name), "first\n");
  await exec("git", ["add", name], { cwd });
  const original = captureCandidateProvenance(cwd);
  await writeFile(join(cwd, name), "other\n");
  assert.notEqual(captureCandidateProvenance(cwd), original);
});

test("ordinary autoresearch-prefixed source files remain candidate inputs", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, "autoresearch.solver.py"), "first\n");
  const original = captureCandidateProvenance(cwd);
  await writeFile(join(cwd, "autoresearch.solver.py"), "other\n");
  assert.notEqual(captureCandidateProvenance(cwd), original);
});

test("ignored generated artifacts and ordinary session logs do not invalidate evidence", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, ".gitignore"), "build/\n.auto/\n");
  await mkdir(join(cwd, ".auto"));
  await writeFile(join(cwd, ".auto", "prompt.md"), "goal\n");
  const original = captureCandidateProvenance(cwd);
  await mkdir(join(cwd, "build"));
  await writeFile(join(cwd, "build", "output.txt"), "generated\n");
  await writeFile(join(cwd, ".auto", "log.jsonl"), "{}\n");
  await writeFile(join(cwd, ".auto", "ideas.md"), "next idea\n");
  assert.equal(captureCandidateProvenance(cwd), original);
});

test("ignored selected controls and legacy peers retain content and absence markers", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, ".gitignore"), ".auto/\nautoresearch.*\n");
  await mkdir(join(cwd, ".auto"));
  await writeFile(join(cwd, ".auto", "measure.sh"), "exit 0\n");
  await writeFile(join(cwd, "autoresearch.sh"), "exit 0\n");
  const original = captureCandidateProvenance(cwd);
  await writeFile(join(cwd, "autoresearch.sh"), "exit 1\n");
  assert.notEqual(captureCandidateProvenance(cwd), original);
  await writeFile(join(cwd, "autoresearch.sh"), "exit 0\n");
  await rm(join(cwd, ".auto", "measure.sh"));
  assert.notEqual(captureCandidateProvenance(cwd), original);
});

test("gitlinks and unresolved index stages fail closed", async (t) => {
  const cwd = await repo(t);
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await exec("git", ["update-index", "--add", "--cacheinfo", "160000", head, "submodule"], { cwd });
  assert.throws(() => captureCandidateProvenance(cwd), /Submodule provenance is unsupported/);
  await exec("git", ["update-index", "--force-remove", "submodule"], { cwd });
  const blob = (await exec("git", ["rev-parse", "HEAD:candidate.txt"], { cwd })).stdout.trim();
  const result = spawnSync("git", ["update-index", "--index-info"], {
    cwd, input: `0 ${"0".repeat(40)}\tcandidate.txt\n100644 ${blob} 1\tcandidate.txt\n`,
  });
  assert.equal(result.status, 0);
  assert.throws(() => captureCandidateProvenance(cwd), /Unmerged/);
});

test("ancestor-directory symlinks cannot redirect tracked candidate reads", async (t) => {
  const cwd = await repo(t);
  await mkdir(join(cwd, "source"));
  await writeFile(join(cwd, "source", "child.txt"), "original\n");
  await exec("git", ["add", "source/child.txt"], { cwd });
  await rename(join(cwd, "source"), join(cwd, "target"));
  try {
    await symlink(join(cwd, "target"), join(cwd, "source"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("directory symlink permission unavailable");
    throw error;
  }
  assert.throws(() => captureCandidateProvenance(cwd), /Unsupported candidate ancestor type/);
});

test("recognized benchmark paths must resolve to readable existing files", async (t) => {
  const cwd = await repo(t);
  assert.throws(() => captureCandidateProvenance(cwd, join(cwd, "missing.sh")), /benchmark path cannot be read/);
  assert.equal(resolveBenchmarkPath(cwd, ".auto/measure.sh"), join(cwd, ".auto", "measure.sh"));
  if (process.platform === "win32") {
    assert.throws(() => resolveBenchmarkPath(cwd, "/tmp/measure.sh"), /cwd-relative/);
    assert.equal(resolveBenchmarkPath(cwd, "/c/research/.auto/measure.sh"), "c:\\research\\.auto\\measure.sh");
  }
});

test("control directory link switches change provenance even with identical script bytes", async (t) => {
  const cwd = await repo(t);
  for (const name of ["controls-a", "controls-b"]) {
    await mkdir(join(cwd, name));
    await writeFile(join(cwd, name, "measure.sh"), "exit 0\n");
  }
  const link = join(cwd, ".auto");
  const type = process.platform === "win32" ? "junction" : "dir";
  try {
    await symlink(join(cwd, "controls-a"), link, type);
  } catch (error) {
    if (error.code === "EPERM") return t.skip("directory symlink permission unavailable");
    throw error;
  }
  const original = captureCandidateProvenance(cwd);
  await rm(link);
  await symlink(join(cwd, "controls-b"), link, type);
  assert.notEqual(captureCandidateProvenance(cwd), original);
});
