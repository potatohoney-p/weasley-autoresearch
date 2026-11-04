import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const finalize = fileURLToPath(new URL("../skills/autoresearch-finalize/finalize.sh", import.meta.url));

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "finalize-trees-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = async (...args) => (await exec("git", args, { cwd })).stdout.trim();
  const put = async (name, content) => {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
  };
  const commit = async () => { await git("add", "-A"); await git("commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Weasley Tests");
  await git("config", "user.email", "tests@example.invalid");
  await put("stable.txt", "unchanged\n");
  for (const [name, content] of Object.entries(files)) await put(name, content);
  const base = await commit();
  await git("checkout", "--quiet", "-b", "autoresearch/source");
  async function run(commits) {
    await writeFile(join(root, "groups.json"), JSON.stringify({ base, trunk: "main", final_tree: await git("rev-parse", "HEAD"), goal: "trees",
      groups: commits.map((sha, i) => ({ title: `Group ${i + 1}`, body: "Metric: verified fixture", last_commit: sha, slug: `group-${i + 1}` })) }));
    try { return { code: 0, ...await exec("bash", [finalize, join(root, "groups.json")], { cwd, timeout: 15000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  const branch = (i = 1) => `autoresearch/trees/${String(i).padStart(2, "0")}-group-${i}`;
  async function assertRestored(commits) {
    const result = await run(commits);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /All checks passed/);
    assert.equal(await git("branch", "--show-current"), "autoresearch/source");
    assert.equal(await git("status", "--porcelain"), "");
    assert.equal(await git("rev-parse", "main"), base);
    return result;
  }
  return { cwd, git, put, commit, base, branch, run, assertRestored };
}

test("finalization restores deletions without importing another group's changes", async (t) => {
  const h = await fixture(t, { "obsolete.txt": "remove me\n", "other.txt": "old\n" });
  await rm(join(h.cwd, "obsolete.txt"));
  const first = await h.commit();
  await h.put("other.txt", "new\n");
  const second = await h.commit();
  await h.assertRestored([first, second]);
  assert.equal(await h.git("rev-parse", `${h.branch()}^{tree}`), await h.git("rev-parse", `${first}^{tree}`));
  assert.equal(await h.git("show", `${h.branch(2)}:obsolete.txt`), "remove me");
  assert.equal(await h.git("show", `${h.branch(2)}:other.txt`), "new");
  for (const i of [1, 2]) assert.equal(await h.git("rev-parse", `${h.branch(i)}^`), h.base);
});

for (const scenario of ["rename", "file to directory", "directory to file", "literal paths", "newline paths"]) {
  test(`finalization preserves the exact tree for ${scenario}`, async (t) => {
    const initial = scenario === "directory to file" ? { "item/child": "old\n" }
      : scenario === "literal paths" ? { "item[1]": "old\n", "item1": "decoy\n", "--old": "old\n" }
      : scenario === "newline paths" ? { "item\nold": "old\n" }
      : { "item": "old\n" };
    const h = await fixture(t, initial);
    if (scenario === "rename") await rename(join(h.cwd, "item"), join(h.cwd, "new name"));
    else if (scenario === "file to directory") { await rm(join(h.cwd, "item")); await h.put("item/child", "new\n"); }
    else if (scenario === "directory to file") { await rm(join(h.cwd, "item"), { recursive: true }); await h.put("item", "new\n"); }
    else if (scenario === "literal paths") { await h.put("item[1]", "new\n"); await rm(join(h.cwd, "--old")); }
    else { await rename(join(h.cwd, "item\nold"), join(h.cwd, "item\nnew")); await h.put("added\nfile", "new\n"); }
    const expected = await h.commit();
    await h.assertRestored([expected]);
    assert.equal(await h.git("rev-parse", `${h.branch()}^{tree}`), await h.git("rev-parse", `${expected}^{tree}`));
  });
}

test("finalization restores a deleted symlink without deleting its target", { skip: process.platform === "win32" }, async (t) => {
  const h = await fixture(t, {});
  await symlink("stable.txt", join(h.cwd, "link"));
  await h.commit();
  // The link belongs to the base for this independent fixture.
  await h.git("branch", "-f", "main", "HEAD");
  const base = await h.git("rev-parse", "HEAD");
  await rm(join(h.cwd, "link"));
  const expected = await h.commit();
  // Use the link-containing commit as the base so the group is a real deletion.
  const groups = join(h.cwd, "..", "symlink-groups.json");
  await writeFile(groups, JSON.stringify({ base, trunk: "main", final_tree: expected, goal: "links", groups: [{ title: "Delete link", body: "Metric: 1", last_commit: expected, slug: "delete" }] }));
  const result = await exec("bash", [finalize, groups], { cwd: h.cwd });
  assert.match(result.stdout, /All checks passed/);
  assert.equal(await h.git("rev-parse", "autoresearch/links/01-delete^{tree}"), await h.git("rev-parse", `${expected}^{tree}`));
  assert.equal(await readFile(join(h.cwd, "stable.txt"), "utf8"), "unchanged\n");
});

test("a rename's removed path participates in cross-group overlap checks", async (t) => {
  const h = await fixture(t, { "item": "old\n" });
  await h.put("item", "changed\n");
  const first = await h.commit();
  await rename(join(h.cwd, "item"), join(h.cwd, "new name"));
  const second = await h.commit();
  const before = await h.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const result = await h.run([first, second]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /appears in multiple groups/);
  assert.equal(await h.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"), before);
  assert.equal(await h.git("branch", "--show-current"), "autoresearch/source");
});

test("file-to-directory restoration does not copy excluded session descendants", async (t) => {
  const h = await fixture(t, { item: "old\n" });
  await rm(join(h.cwd, "item"));
  await h.put("item/kept.txt", "new\n");
  await h.put("item/.auto/secret", "session-only\n");
  const expected = await h.commit();
  await h.assertRestored([expected]);
  assert.equal(await h.git("ls-tree", "-r", "--name-only", h.branch()), "item/kept.txt\nstable.txt");
  assert.equal(await h.git("show", `${h.branch()}:item/kept.txt`), "new");
  assert.equal(await readFile(join(h.cwd, "item/.auto/secret"), "utf8"), "session-only\n");
});

test("ancestor paths across groups are rejected before branch creation", async (t) => {
  const h = await fixture(t, { item: "old\n" });
  await rm(join(h.cwd, "item"));
  await h.put("item/a", "first\n");
  const first = await h.commit();
  await h.put("item/b", "second\n");
  const second = await h.commit();
  const before = await h.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const result = await h.run([first, second]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /appears in multiple groups/);
  assert.equal(await h.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"), before);
  assert.equal(await h.git("branch", "--show-current"), "autoresearch/source");
  assert.equal(await h.git("status", "--porcelain"), "");
});
