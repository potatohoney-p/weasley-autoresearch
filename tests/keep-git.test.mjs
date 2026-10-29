import assert from "node:assert/strict";
import test from "node:test";
import { commitKeptCandidate } from "../extensions/weasley-autoresearch/keep.ts";

const head = "a".repeat(40);
const next = "b".repeat(40);
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

function commands(override, changed = true) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    async exec(command, args) {
      calls.push(args[0]);
      if (args[0] === "rev-parse") reads++;
      const result = override?.(args[0], reads);
      if (result) return result;
      if (args[0] === "rev-parse") return ok(reads === 1 || !changed ? head : next);
      return { ...ok(), code: args[0] === "diff" && changed ? 1 : 0 };
    },
  };
}

for (const phase of ["add", "diff"]) {
  for (const fault of ["killed", "throw"]) {
    test(`${phase} ${fault} never reaches commit`, async () => {
      const h = commands((command) => {
        if (command !== phase) return;
        if (fault === "throw") throw new Error("injected process error");
        return { ...ok(), killed: true };
      });
      const result = await commitKeptCandidate(h.exec, "/repo", "candidate");
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, false);
      assert.equal(h.calls.includes("commit"), false);
    });
  }
}

test("commit process exceptions and killed success responses require reconciliation", async () => {
  for (const fault of ["throw", "killed"]) {
    const h = commands((command) => {
      if (command !== "commit") return;
      if (fault === "throw") throw new Error("process connection lost");
      return { ...ok(), killed: true };
    });
    const result = await commitKeptCandidate(h.exec, "/repo", "candidate");
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(h.calls.filter((command) => command === "commit").length, 1);
  }
});

test("invalid or killed initial HEAD cannot authorize staging", async () => {
  for (const result of [ok("abcdef0"), ok(`${head}\n${next}`), { ...ok(head), killed: true }]) {
    const h = commands((command) => command === "rev-parse" ? result : undefined);
    assert.equal((await commitKeptCandidate(h.exec, "/repo", "candidate")).ok, false);
    assert.deepEqual(h.calls, ["rev-parse"]);
  }
});

test("an unchanged tree still requires readable, stable current HEAD", async () => {
  for (const result of [ok(next), { ...ok(), code: 128 }]) {
    const h = commands((command, reads) => command === "rev-parse" && reads === 2 ? result : undefined, false);
    const outcome = await commitKeptCandidate(h.exec, "/repo", "candidate");
    assert.equal(outcome.ok, false);
    assert.equal(h.calls.includes("commit"), false);
  }
});

test("full SHA-256 object IDs are accepted without trusting commit output", async () => {
  const h = commands((command, reads) => command === "rev-parse" ? ok((reads === 1 ? "a" : "b").repeat(64)) : undefined);
  const outcome = await commitKeptCandidate(h.exec, "/repo", "candidate");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.commit, "b".repeat(64));
});
