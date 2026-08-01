# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting feature for the
[`potatohoney-p/weasley-autoresearch`](https://github.com/potatohoney-p/weasley-autoresearch)
repository. Include reproduction steps, affected versions, and the expected impact when possible.

## Security model

Weasley AutoResearch intentionally executes user-configured benchmark and hook commands with the
current user's permissions. It can also modify a Git working tree and create commits or branches.
Those documented capabilities are not vulnerabilities by themselves.

Security issues include, but are not limited to:

- modifying or deleting pre-existing user work despite the clean-worktree guard;
- executing commands outside the configured experiment flow;
- escaping the selected working directory through configuration or path handling;
- leaking prompts, logs, credentials, environment data, or hook output;
- silently accepting malformed configuration in a way that weakens safety controls; or
- publishing undeclared files or running unexpected install-time code.

Use a dedicated branch or worktree, review benchmark and hook scripts before execution, avoid
putting secrets in `.auto/`, and apply provider-side spend limits for unattended sessions.
