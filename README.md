# Weasley AutoResearch

![Weasley AutoResearch: experiment, measure, keep the winners](assets/weasley-autoresearch-hero.png)

`weasley-autoresearch` is a guarded autonomous experiment loop for the pi coding agent. It turns
an optimization goal into repeatable benchmark runs, records evidence, keeps improvements, and
reverts regressions while preserving an auditable session log. The published package ID remains
`weasley-autoresearch`.

## Features

- `init_experiment`, `run_experiment`, and `log_experiment` tools for measured iteration.
- Live terminal widget, fullscreen dashboard, confidence scoring, and JSONL session history.
- Correctness backpressure through optional `.auto/checks.sh`.
- Before/after hooks for research context, notifications, and learning journals.
- Automatic continuation across agent turns and context compaction, with bounded safety guards.
- Optional redirected working directories for isolated worktrees.
- Finalization skill that groups experiment commits into independent review branches.
- Clean-worktree activation guard: existing staged, tracked, and untracked user changes stop
  activation before any later `git add -A`, checkout, or clean operation can touch them.
- Strict configuration parsing: malformed or unknown settings fail closed instead of silently
  falling back to a different directory or iteration policy.

## Requirements

- Node.js 22.19 or newer
- pi and a configured model provider
- Git for experiment snapshots and rollback
- Bash for benchmark/check scripts and the finalize workflow

## Installation

```bash
pi install npm:weasley-autoresearch
```

Pi supplies the extension API, AI, and TUI packages at runtime. They are declared as optional
peers so a standalone npm consumer does not install a second copy of the Pi host; local development
keeps synchronized copies in `devDependencies` for tests.

For local development:

```bash
git clone https://github.com/potatohoney-p/weasley-autoresearch.git
cd weasley-autoresearch
npm install
npm test
```

Start a session from a **clean Git worktree**:

```text
/autoresearch optimize unit test runtime while preserving correctness
```

Other commands:

| Command | Purpose |
|---|---|
| `/autoresearch off` | Stop auto-resume and deactivate experiment tools. |
| `/autoresearch clear` | Remove the session log and reset runtime state. |
| `/autoresearch export` | Open the local live dashboard. |
| `Ctrl+Shift+F` | Open the fullscreen terminal dashboard. |

The shortcut can be changed or disabled in the active Pi agent directory at
`<agent-dir>/extensions/weasley-autoresearch.json`. The default agent directory is
`~/.pi/agent`; `PI_CODING_AGENT_DIR` can override it.

```json
{
  "shortcuts": {
    "fullscreenDashboard": "ctrl+shift+y"
  }
}
```

Set the shortcut to `null` to disable it.

## Session files

All current session artifacts live under `.auto/` in the effective working directory:

| File | Purpose |
|---|---|
| `.auto/prompt.md` | Goal, scope, metric, constraints, and accumulated guidance. |
| `.auto/measure.sh` | Repeatable benchmark that emits `METRIC name=number`. |
| `.auto/log.jsonl` | Append-only config and experiment results. |
| `.auto/ideas.md` | Deferred hypotheses and follow-up ideas. |
| `.auto/checks.sh` | Optional correctness checks run after a passing benchmark. |
| `.auto/hooks/` | Optional `before.sh` and `after.sh` hooks. |
| `.auto/config.json` | Optional working-directory and iteration configuration. |

Legacy flat `autoresearch.*` session files are read only for compatibility with in-flight sessions.

## Configuration

`.auto/config.json` accepts exactly these optional fields:

```json
{
  "workingDir": "../isolated-worktree",
  "maxIterations": 50
}
```

| Field | Rules |
|---|---|
| `workingDir` | Non-empty absolute or cwd-relative path to an existing directory. |
| `maxIterations` | Positive integer; the loop stops when the limit is reached. |

Malformed JSON, wrong types, invalid values, and unknown fields disable activation with an error.
They are never treated as an empty/default config.

## Git safety model

Before both manual and persisted-session activation, the extension runs a read-only Git status
check. `.auto/` and legacy session artifacts are excluded; every other change is treated as user
work. If any such change exists, activation is refused and no files, index entries, or stashes are
modified.

During an active clean session:

- `keep` stages and commits the experiment result.
- `keep` requires the latest `run_experiment` in the same working directory to have
  completed successfully, including configured correctness checks. A result can authorize
  only one log entry. After restarting, interrupting a run, or changing the experiment
  configuration, run the benchmark again before keeping a candidate.
- `discard`, `crash`, and `checks_failed` revert experiment changes while retaining session files.
- the finalize skill stashes and restores a dirty tree defensively before it creates review
  branches, and rolls created branches back on creation failure.

Use an isolated Git worktree for unattended or high-risk optimization targets.

### Benchmark invocation

When the selected `.auto/measure.sh` (or legacy `autoresearch.sh`) exists,
`run_experiment` requires one complete literal benchmark invocation. It does not
accept a matching command prefix followed by shell syntax that can mask failure.
For example, `bash -n .auto/measure.sh`, `bash .auto/measure.sh || true`, and
`bash .auto/measure.sh | cat` are rejected before any benchmark or checks run.
Every attempted run clears earlier evidence, including a rejected invocation;
run a fresh valid benchmark before keeping.

Pending benchmark/check completions also lose permission to publish when a newer
run is attempted, a result is consumed, or the session is reinitialized, stopped,
cleared, reconstructed, switched, or shut down. Superseded calls reject instead of
restoring old benchmark, checks, or timing evidence. An abort while checks are
settling likewise cannot certify success. A fresh completed run can still be kept.
This ownership is local to each runtime: superseding does not itself stop older
shell processes, serialize concurrent commands, or roll back their side effects.
Existing abort and timeout handling still governs process termination.

Supported forms retain literal script arguments and quoted/escaped paths:

- `bash .auto/measure.sh`, `sh .auto/measure.sh`, or `./.auto/measure.sh`.
- `source .auto/measure.sh` directly (or under Bash's `time` keyword).
- Current, legacy, nested, and absolute recognized benchmark paths. Direct or
  sourced legacy paths need `./autoresearch.sh`, not a bare PATH lookup.
- Optional shell flags composed only of `e`, `u`, `x`, and `v`, plus optional `--`.
- Literal leading environment assignments, or `env [--] NAME=value ...`.
- Basic `time [-p]`, `nice [-n INTEGER] [--]`, and `nohup [--]` wrappers, when
  available. `env`, `nice`, and `nohup` cannot directly invoke the `source` builtin.

Other wrapper/interpreter options, chaining, pipelines, backgrounding, redirection,
comments, unquoted newlines, substitutions, variable/glob/brace/tilde expansion, and malformed quoting
are unsupported. Explicit assignments to `BASH_ENV`, `ENV`, `SHELLOPTS`, or
`BASHOPTS` are also rejected because startup settings can skip script execution.
Put complex setup inside the benchmark script and make it propagate failures.
Quoted literal arguments may contain shell-looking characters without evaluating them.

If no selected benchmark file exists, custom shell commands remain available with
their existing exit-status semantics. This validation is not a security sandbox or
proof of what a benchmark script does. Ambient environment, PATH/interpreter
resolution, the script's own argument handling (including a script-defined `--help`)
and exit-status discipline remain the caller's responsibility.

### Candidate provenance

Before benchmarking, AutoResearch records a read-only SHA-256 digest of `HEAD` and
the repository-wide candidate: tracked and nonignored untracked file paths,
contents, removals, file types, and Git-relevant executable modes. It compares the
digest after correctness checks and again before a `keep` can change results or
stage files. An observed change or capture failure disqualifies that run even if
files are later restored; run a new benchmark before keeping. Fingerprinting time
is excluded from benchmark and checks durations.

The reserved `.auto/` and `autoresearch.hooks/` namespaces and known legacy session
files are excluded from the candidate. Mutable logs, prompts and ideas therefore
remain usable. Both current and legacy measure/checks files are explicitly
fingerprinted even when ignored, with selected/resolved paths and absence markers. A
benchmark path recognized by the existing command guard is also fingerprinted,
including alternate legacy or nested paths. Ordinary source files such as
`autoresearch.solver.py` are included. Missing or unreadable recognized benchmark
paths fail before execution; on Windows, use a relative path instead of a Git Bash
absolute path such as `/tmp/...` that native Node cannot resolve.

Current/legacy layouts and custom commands retain their tool arguments. Staging
different contents without changing the eventual working-tree contents is allowed,
because `git add -A` replaces those staged contents. An index executable-mode change
still matters when `core.filemode=false`. Nonignored generated outputs change the
candidate: generate them before benchmarking, or ignore disposable build artifacts
and rerun. `assume-unchanged` and `skip-worktree` index flags fail closed because
they can prevent `git add -A` from staging tested bytes; intentionally clear those
flags before benchmarking. Capture does not alter index flags or refresh the index.
Submodules, unresolved index conflicts, unsupported file kinds, and
symlink/non-directory ancestors of tracked candidate paths fail closed with an
actionable error. Those cases are an explicit restriction, not universal backward
compatibility.

These are observational snapshots, not an atomic transaction or immutable execution
environment. They cannot establish what an external process read, detect every
transient edit that was restored between captures, or prevent edits racing the last
comparison and commit. Ignored dependencies/data, arbitrary custom-command inputs,
shell `PATH` resolution, environment variables and external services are outside the
contract. These are working-tree byte snapshots, not a precomputed commit tree;
Git content conversions and clean-filter execution are not fingerprinted. Candidate
symlinks record their link text; their external targets are not
implicitly included. Explicit benchmark/check control symlinks also include their
resolved target file. This does not recursively fingerprint transitive dependencies.

The consecutive-failure guard stops auto-resume after more than 20 rejected results
(`discard`, `crash`, or `checks_failed`) in the current segment. A kept result or a new
segment resets the streak. Persisted JSONL recovery skips malformed outcomes, unknown
statuses, invalid run numbers, and non-finite primary metrics; it never assumes an
incomplete outcome was kept. Valid later lines remain recoverable.

## Checks and hooks

Create executable `.auto/checks.sh` to validate correctness after each successful benchmark:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm test
npm run lint
```

Optional `.auto/hooks/before.sh` and `.auto/hooks/after.sh` receive a JSON payload on stdin. Their
stdout is delivered to the agent as bounded steering context. Non-zero exits and timeouts are
reported and logged rather than hidden. Examples live in
[`skills/autoresearch-hooks/examples/`](skills/autoresearch-hooks/examples).

## Testing

```bash
npm run test:unit
npm run test:finalize
npm test
```

`npm test` includes both Node tests and the finalize integration suite. The finalize suite requires
Bash, Git, and standard Unix command-line tools. On Windows, run it from Git Bash or WSL; Linux CI
runners can execute it directly.

## Security

- Benchmarks and hooks execute local commands with the current user's permissions.
- AutoResearch can create commits and branches; use a dedicated branch/worktree and review output.
- Existing user changes block activation, but changes made after activation are assumed to belong
  to the experiment session.
- Do not place secrets in prompts, JSONL logs, hook output, or benchmark output.
- Apply least-privilege API keys and set provider-side spend limits for unattended loops.

Report vulnerabilities through the private security channel on the
[`potatohoney-p/weasley-autoresearch`](https://github.com/potatohoney-p/weasley-autoresearch)
repository rather than a public issue.

## Contributing

Keep safety behavior fail-closed, add regression coverage for Git/config changes, and run
`npm test` before opening a pull request. General issues and pull requests are tracked at
[`potatohoney-p/weasley-autoresearch`](https://github.com/potatohoney-p/weasley-autoresearch).

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
