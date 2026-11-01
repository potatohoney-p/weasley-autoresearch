/** A verified Git outcome, not an atomic transaction with the experiment log. */
export type KeepGitOutcome =
  | { ok: true; commit: string; createdCommit: boolean }
  | { ok: false; phase: string; uncertain: boolean; message: string; beforeHead?: string };

type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/**
 * Preserve the index/worktree as Git leaves them on failure. In particular, a
 * failed or timed-out commit is never automatically retried or rolled back.
 */
export async function commitKeptCandidate(exec: Exec, cwd: string, message: string): Promise<KeepGitOutcome> {
  let phase = "read-before-head";
  let uncertain = false;
  let beforeHead: string | undefined;
  const failure = (reason: string): KeepGitOutcome => ({
    ok: false, phase, uncertain, message: reason, beforeHead,
  });
  const readHead = async (): Promise<string> => {
    const result = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd, timeout: 5000 });
    const sha = result.stdout.trim();
    if (result.killed || result.code !== 0 || !objectId.test(sha)) {
      throw new Error(`Could not verify HEAD (exit ${result.code}${result.killed ? ", killed" : ""}).`);
    }
    return sha;
  };
  try {
    beforeHead = await readHead();
    const options = { cwd, timeout: 10000 };
    phase = "add";
    const add = await exec("git", ["add", "-A"], options);
    if (add.killed || add.code !== 0) {
      return failure(`git add failed (exit ${add.code}${add.killed ? ", killed" : ""}): ${(add.stdout + add.stderr).trim().slice(0, 200)}`);
    }
    phase = "diff";
    const diff = await exec("git", ["diff", "--cached", "--quiet"], options);
    if (diff.killed || (diff.code !== 0 && diff.code !== 1)) {
      return failure(`git diff failed (exit ${diff.code}${diff.killed ? ", killed" : ""}): ${(diff.stdout + diff.stderr).trim().slice(0, 200)}`);
    }
    if (diff.code === 0) {
      phase = "read-unchanged-head";
      const commit = await readHead();
      if (commit !== beforeHead) {
        uncertain = true;
        return failure("HEAD changed while verifying an unchanged tree.");
      }
      return { ok: true, commit, createdCommit: false };
    }
    phase = "read-staged-tree";
    const staged = await exec("git", ["write-tree"], options);
    const expectedTree = staged.stdout.trim();
    if (staged.killed || staged.code !== 0 || !objectId.test(expectedTree)) {
      return failure("Could not verify the staged candidate tree before committing.");
    }
    phase = "commit";
    uncertain = true; // A process failure can happen after Git creates a commit.
    const committed = await exec("git", ["commit", "-m", message], options);
    if (committed.killed || committed.code !== 0) {
      return failure(`git commit did not confirm success (exit ${committed.code}${committed.killed ? ", killed" : ""}): ${(committed.stdout + committed.stderr).trim().slice(0, 200)}`);
    }
    phase = "read-after-head";
    const commit = await readHead();
    if (commit === beforeHead) return failure("git commit reported success but HEAD did not advance.");
    phase = "verify-committed-tree";
    // Hooks or concurrent Git operations may change what a successful commit
    // records. Keep the commit intact, but never publish unverified evidence.
    const metadata = await exec("git", ["show", "-s", "--no-show-signature", "--no-notes", "--format=%T%n%P", commit], options);
    const fields = metadata.stdout.trim().split("\n");
    if (metadata.killed || metadata.code !== 0 || fields.length !== 2 ||
        fields[0] !== expectedTree || fields[1] !== beforeHead) {
      return failure("Committed tree or parent does not match the staged candidate and original HEAD; reconcile the preserved commit before continuing.");
    }
    return { ok: true, commit, createdCommit: true };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
