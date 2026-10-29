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
- Automatic continuation across agent turns and context compaction, with bounded safety guards. Compaction summaries preserve finite benchmark metric values without rounding away small differences; percentage deltas remain rounded display hints.
- Optional redirected working directories for isolated worktrees.
- Finalization skill that groups experiment commits into independent review branches.
- Clean-worktree activation guard: existing staged, tracked, and untracked user changes stop
  activation before any later `git add -A`, checkout, or clean operation can touch them.
- Strict configuration parsing: malformed or unknown settings fail closed instead of silently
  falling back to a different directory or iteration policy.
- Local repeated-benchmark runner with separate warmups, median metrics, and optional per-trial
  JSON evidence. Failed or incomplete series never emit aggregate metrics.

## Progress delivery failures

Benchmark progress callbacks are optional synchronous observers. If one throws, that run stops
calling it and continues the benchmark and correctness checks without replay. The final tool
result includes `progressUpdateFailed: true` and a warning; exit status, timeout and check
results remain authoritative. Later runs start with a fresh observer. Cancellation still
rejects normally and does not promise a final warning. This does not contain unrelated widget
or renderer exceptions, or support asynchronous/rejecting progress callbacks.

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

Concurrent dashboard exports for the same working directory share one local server, including
while it is starting. `off`, `clear`, and session shutdown cancel pending exports and close the
owned server; a cancelled export does not open a browser or announce a live URL. Exporting another
working directory replaces the old server. A later explicit export can start a fresh server.
This lifecycle is extension-wide (not one server per session); it does not change session switching,
request validation, dashboard temporary-file retention, or browser windows already opened.

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

## Benchmark cancellation

`run_experiment` rejects calls whose abort signal is already cancelled without launching a
benchmark. On timeout, cancellation, or output-artifact failure during a benchmark, it requests `SIGTERM`, then after
250 ms requests `SIGKILL` for the same process group (falling back to the direct child
only while it has not been observed to exit).
Escalation remains active even if the direct child exits first. The runner then releases its
owned output pipes so detached descendants cannot hold the tool open indefinitely.

Timeout remains a failed benchmark even if a termination handler exits zero; correctness checks
are not run. Cancellation rejects with `aborted`. Output-artifact failure rejects with the original
persistence error after cleanup, even when benchmark timeout is disabled; it never runs correctness
checks or reports a partial artifact as successful. Measured duration includes this cleanup grace.
This is best-effort process cleanup, not a security sandbox or a hard real-time deadline:
escaped descendants can continue running, Windows cleanup is limited to the direct child, and
blocking event-loop work or output storage can still delay completion. Hook/check subprocess
policies are unchanged. Captured output may end at the cleanup boundary.

## Session files

All current session artifacts live under `.auto/` in the effective working directory:

On startup or session-tree navigation, a successfully read session log takes precedence over
historical tool results, including an empty or config-only log. Clearing a session and initializing
a new goal therefore does not restore the old goal or baseline before the first new result.
Missing or unreadable logs retain the legacy history fallback; this does not validate or repair
damaged logs.

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

## Recording a kept experiment

`log_experiment` reports a kept result only after Git has a verified outcome and the JSONL append
returns successfully. It checks HEAD before staging, accepts only exit 0 (unchanged) or 1 (changed)
from `git diff --cached --quiet`, and verifies that a successful new commit advances HEAD. A keep
with no staged changes remains valid and records the verified current HEAD, not a new commit.
The caller's commit argument does not override this verified hash.

A failure before a commit attempt returns an error without publishing a result, incrementing the
experiment counter, or firing success hooks. Repair the reported problem before retrying. Staging
may already have happened; the extension leaves the working tree and index as Git left them.

If a commit fails, times out, or cannot be verified, its outcome is **uncertain**: Git may already
have created it. An append error is also uncertain, because a partial or complete log entry may
have been written before the error. Autoresearch pauses and rejects further experiment calls.
Inspect HEAD, the index and `.auto/log.jsonl` (or the active legacy log), reconcile them, then
explicitly resume with `/autoresearch <goal>`. Do not blindly repeat the keep or append a duplicate.
The response includes the verified Git hash when available. No commit rollback, index reset, log
repair, or automatic retry is performed.

Explicit resume rebuilds runtime state from the reconciled log, preserving any complete result
you retained. The log must be readable, contain complete JSON objects on nonempty lines and end
with a newline before further appends. Invalid or missing logs keep the session paused; repair
them manually or use the explicit clear command to reset the session. Resume does not fall back
to stale tool history or certify that your manual Git/log reconciliation was correct. Previous
benchmark/check timing evidence is cleared; run a fresh benchmark before the next decision.

While a log operation is pending, other log calls, initialization, benchmark runs, clearing and
restarting that same runtime are rejected; `/autoresearch off` remains available. Successful
keeps publish their state before updating the dashboard and running hooks. The existing session
activation record preserves a pause across same-session reloads when saving that record succeeds;
failure to save the pause or abort the loop is reported explicitly.

Initialization follows the same persistence-first rule: a new goal, metric, direction,
segment, and reset baseline are published in memory only after its configuration header
is written successfully. If that write throws, the old in-memory state remains intact,
but the append may have written nothing, a partial header, or a complete header. The
session pauses behind the same explicit reconciliation gate; inspect the active log
before resuming, rather than retrying initialization and appending another header.
This is not an atomic filesystem transaction or a cross-process recovery journal.

After publication, hook invocation or steering-delivery errors are reported as warnings alongside
the recorded success, not as an uncertain keep. Per-run checks and timing are consumed before
these follow-up actions. Do not repeat an already-recorded keep just because its hook failed.

This is in-process outcome reporting, not an atomic Git/log transaction or a recovery journal.
It does not lock other sessions or external writers, guarantee physical durability, or recover
automatically after process death. A different session has no new persisted uncertainty marker.
Discard/crash rollback behavior is unchanged.

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

## Structured metric output

Emit one `METRIC name=value` record per line. Names accept ASCII word characters,
dots and `µ`; `__proto__`, `constructor` and `prototype` are rejected. Values retain
the existing finite JavaScript `Number` syntax, including decimal/scientific and
hexadecimal/binary literals. Nonfinite values and malformed records are ignored;
a record split across newlines is malformed. A final line need not end in a newline.

Metrics are collected while output streams in, before the display tail is evicted.
Each stdout/stderr pipe has its own UTF-8 decoder and line buffer. The last valid
duplicate wins in observed line-completion order, including a final line completed
by stream end. This does not establish a reliable chronology between the two pipes.
Display truncation and full-output artifacts retain their existing behavior.

Collection is bounded to 4096 decoded UTF-8 bytes per line, 128 characters per name,
and the first 256 distinct valid names. Overlong lines are skipped until the next
line boundary; additional names are ignored, while admitted names can still update.
If a limit is reached, `run_experiment` reports `metricLimits` and a visible warning;
some metrics, including the primary metric, may be missing. Inspect full output or
emit shorter/fewer records and rerun. Limit warnings do not change benchmark success
or failure, and failed benchmarks still return any metrics collected before exit.

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

A non-keep rollback stops at the first failing Git command. A nonzero exit, termination or
execution error pauses the session and requires explicit reconciliation before resuming.
The outcome is already recorded in memory and its log append has been attempted at that point;
do not repeat `log_experiment`. Inspect HEAD, the index, working tree and `.auto/log.jsonl`,
reconcile them, then explicitly resume with `/autoresearch <goal>`. Failed rollback does not
run after/before hooks or claim that changes were reverted. Partial filesystem changes are
not undone automatically. A zero exit still uses the existing checkout/clean semantics; this
is not a transactional rollback or proof that staged/concurrent edits match HEAD.

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
Log completion consumes only the evidence it accepted and reports that run's
duration; delayed logging cannot clear evidence from a newer attempt.

If that run parsed the configured primary `METRIC`, a `keep` must supply exactly
that numeric value. A transcription mismatch is rejected before Git, hooks, or
result publication, even with `force: true`. Correcting the value can reuse the
same unconsumed run. When no primary metric was parsed, manual metrics remain
supported. This guard does not certify unparsed output, secondary metrics, or
benchmark methodology; it does not change the parser's existing output limits.

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
stdout is delivered to the agent as bounded steering context. Each hook stream retains at most
8 KiB of output bytes plus a truncation marker, including stderr from failed hooks. UTF-8
characters split across output chunks are preserved; a character cut by the byte cap is omitted.
This bounds retained output, not the hook process itself or its total emitted data. Non-zero exits and timeouts are
reported and logged rather than hidden. A hook that closes stdin early cannot crash the host with
a broken-pipe error: detected input-delivery failures are reported in steering context and recorded
as `stdin_error`, separately from the actual child exit code. Successful writes only confirm pipe
delivery, not that the hook parsed or acted on the entire JSON payload. Examples live in
[`skills/autoresearch-hooks/examples/`](skills/autoresearch-hooks/examples).

## Repeated measurements

For noisy workloads, `weasley-benchmark` runs the same local command serially and emits the median
of every reported metric. Install the package in the target project to expose the CLI:

```bash
npm install --save-dev weasley-autoresearch
./node_modules/.bin/weasley-benchmark --metric runtime_ms --runs 5 --warmup 1 \
  --report .auto/trials-001.json -- node benchmarks/workload.mjs
```

Create `.auto/` first and choose a new report filename for each experiment. To use the existing
experiment loop, put that command in `.auto/measure.sh` with `set -euo pipefail`. The workload
should emit `METRIC runtime_ms=number` on stdout, plus any secondary metrics. `run_experiment`
then parses the aggregate output normally and runs `.auto/checks.sh` once after the complete
series succeeds. Use those parsed values in `log_experiment`; record the report path in `asi`
if useful. No new log schema or keep/discard policy is introduced.

The CLI is also runnable from a source checkout with `node bin/repeat-benchmark.mjs`. It needs
only Node, not a model provider or the Pi runtime, and performs no network requests itself.

### Trial contract

- `--metric NAME` identifies the required primary metric. `--runs` defaults to 5 (range 1–100);
  `--warmup` defaults to 0 (range 0–20). Warmups must exit successfully but need not emit metrics.
- Measured trials must exit zero and emit the same set of metric names. Each name must occur
  exactly once per trial, be at most 128 characters, and contain only letters/digits/underscore,
  dot or `µ`. At most 256 names are allowed. Values must be finite decimal numbers; scientific
  notation is supported. Missing, duplicate, malformed and non-finite records fail the series.
- Only stdout supplies metrics; stderr is diagnostic output. Non-metric output is not forwarded
  or saved. Each trial is limited to 1 MiB of combined stdout/stderr. `--timeout-seconds` defaults
  to 60 per trial (range 0.001–86400), including warmups. Set the outer `run_experiment` timeout
  high enough for the whole series plus process-cleanup time.
- The first failed trial stops the series. No successful subset is aggregated. A requested JSON
  report includes every attempted trial, its phase, exit/signal/error, duration and measured
  metrics, plus requested and completed counts. Unattempted trials remain visible in the plan's
  denominator. Failed series have `summary: null` and exit 1; invalid arguments exit 2.
- A successful report includes count, median, minimum, maximum and median absolute deviation
  (MAD) for each metric. An unrepresentable MAD is `null`, not Infinity. Warmups are excluded.
  Stdout contains only aggregate `METRIC name=median` lines for successful series.
- `--report FILE` is optional and never overwrites an existing destination. Its parent directory
  must exist. Report-write failure prevents aggregate output and exits nonzero. Ordinary
  SIGINT/SIGTERM interruption attempts to save a failed report; abrupt process/OS failure can
  leave no report or an incomplete file. Writes are not a durable transaction.

Commands are executed as literal executable/argument lists after `--`, without shell expansion.
Use `-- bash script.sh` when a script needs Bash. They inherit the working directory, environment
and user permissions: this is not a sandbox. Timeouts/interruption terminate the POSIX process
group on a best-effort basis, escalating after a 250 ms grace period; on Windows only the direct
child is terminated. The runner closes its own pipes after that grace period rather than waiting
indefinitely for an escaped descendant. A program can escape process-group cleanup and continue
running, so use trusted workloads and an isolated worktree where appropriate.

Reports record the command, cwd, Node version, platform and architecture, but not environment
variables or raw stdout/stderr. Command arguments and paths may still be sensitive; inspect a
report before sharing it. Keep reports under `.auto/` (or ignored paths) so they do not contaminate
candidate provenance. This captures observations, not an exact environment/input snapshot or
proof of reproducibility. Serial trials are not guaranteed independent, and median/MAD are
descriptive statistics, not a confidence interval or significance test.
### Compaction source failures

Active AutoResearch compaction is canceled if an existing log, rules, or ideas
source cannot be read, rather than replacing history with an incomplete summary.
The source files are not repaired or overwritten. Repair the reported file and
retry compaction; truly absent optional files retain their existing behavior.
A dangling source symlink is treated as a read failure, not as an empty source.
Cancellation clears the pending continuation for that compaction, but does not
turn off AutoResearch or abort an ongoing experiment. This is a read-error guard,
not JSONL schema validation or an atomic snapshot of concurrently edited files.

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

### Experiment timeout admission

`run_experiment` validates both `timeout_seconds` and `checks_timeout_seconds`
before launching the benchmark, even if no checks file exists. Omitted values keep
600-second benchmark and 300-second checks defaults. Explicit `0` keeps the existing
no-timeout option. Other values must be finite numbers from 0 through 2147483.647
seconds; negative values, null, and overflowing delays are rejected rather than
silently disabling a timer or letting Node clamp it to 1 ms. Positive fractional
seconds are converted to whole milliseconds, rounding down with a minimum of 1 ms.
This is argument validation, not a hard real-time guarantee or a redesign of process
termination, cancellation, or evidence recovery.

### Benchmark output persistence

Large benchmark output is streamed to a temporary log. `run_experiment` waits for
the stream to finish before returning the completed output path. Benchmark
duration ends when the child closes; waiting for artifact finalization does not
inflate the reported benchmark duration. An output-file
open, write, finalization, or premature-close failure rejects the run rather than
crashing the host or advertising an incomplete log as successful. The benchmark
is terminated using the existing best-effort process-tree termination. A partial
file can remain for diagnosis; no automatic retry or deletion occurs. This is not
a disk durability (`fsync`) guarantee or a change to metric parsing or experiment
evidence policy.

When the output file asks for backpressure, both benchmark pipes pause until its
`drain` event. This prevents a slow sink from queuing the entire benchmark output
in Node memory. The initial buffered prefix and the current pipe chunk can still
exceed the sink high-water mark; this is not a fixed process-memory or disk quota.
Slow storage can slow the benchmark and contribute to its timeout and measured
duration. Final flush waiting remains excluded from the duration. Cancellation
retains best-effort cleanup; storage that never completes can still delay finalization.

Benchmark display output decodes UTF-8 independently for stdout and stderr, so an
incomplete codepoint in one pipe is not corrupted by bytes from the other. Text
is appended when decoded; this is not a global ordering guarantee between pipes.
Incomplete UTF-8 at pipe closure is represented by the standard replacement
character. The streamed artifact (above the full-output byte threshold) retains raw bytes
in observed data-event order,
so mixed-pipe raw files may not themselves form valid UTF-8. Smaller artifacts
created only because the LLM display is truncated retain decoded display text. Display retention
remains bounded and does not promise to retain every diagnostic line.
