# Contributing to Weasley AutoResearch

Contributions are welcome. Weasley AutoResearch runs commands, modifies working trees, and can
create commits and branches, so safety behavior must remain explicit and fail closed.

## Before opening a pull request

1. Start from a clean branch or worktree.
2. Keep the change focused and document user-visible behavior.
3. Add regression coverage for changes to activation, configuration, Git operations, hooks,
   compaction, or experiment logging.
4. Run `npm test`. On Windows, run the finalize integration suite from Git Bash or WSL.
5. Do not commit `.auto/` session data, credentials, generated experiment output, or unrelated
   dependency changes.

## Design expectations

- Preserve user work. Existing staged, tracked, or untracked changes must never be silently
  overwritten, cleaned, or committed.
- Treat benchmark and hook output as untrusted local data.
- Keep configuration validation strict; malformed or unknown settings should not silently select
  a different working directory or policy.
- Avoid hidden network calls and install-time execution.
- Keep dependencies and published files minimal.

By contributing, you agree that your contribution is licensed under the Apache License 2.0.
