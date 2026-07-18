---
name: claude-review
description: Run Claude Code as an independent, read-only structural review gate for a PR, branch, commit, or uncommitted diff. Use for the outer gate in Codex-driven AFK (`/afk codex`), or when the operator explicitly requests a Claude review. Never use when Claude implemented the change; preserve reviewer independence.
---

# Claude Review Gate

Run Claude Code as a different-model structural reviewer. The implementer remains
responsible for verifying and fixing findings. This gate reviews only; it must not
edit, stage, commit, push, merge, or open/close issues.

The deterministic wrapper is
[`skill/claude-review/claude-gate.mjs`](claude-gate.mjs). It:

- resolves `--base`, `--commit`, or `--uncommitted` into a bounded review packet;
- runs Claude Code in headless plan mode with only `Read`, `Glob`, and `Grep`;
- explicitly denies `Bash`, `Edit`, `Write`, `NotebookEdit`, and web tools;
- compares the working-tree fingerprint before and after review;
- prints only Claude's final verdict between stable markers;
- self-skips when disabled, unavailable, unauthenticated, out of quota, or timed out.

## Reviewer independence

- `/afk codex`: Codex implements and performs CTO review, then **Claude is the
  outer gate**, then Kimi is the final gate.
- Default `/afk`: Claude implements, so do **not** run this gate; Codex is the
  outer gate.
- Never let a model review work it implemented. If Claude is ineligible or the
  gate self-skips, use the AFK fallback pool and report any degraded review.

## Run the gate

Run the wrapper from the repository/worktree being reviewed. Prefer a background
process with a timeout of at least 20 minutes; the wrapper has its own 15-minute
default timeout.

Windows PowerShell:

```powershell
node "skill/claude-review/claude-gate.mjs" --base main `
  1> "$env:TEMP\claude_gate.out" `
  2> "$env:TEMP\claude_gate.err"
```

macOS/Linux:

```bash
node skill/claude-review/claude-gate.mjs --base main \
  > "${TMPDIR:-/tmp}/claude_gate.out" \
  2> "${TMPDIR:-/tmp}/claude_gate.err"
```

Targets:

- no target: current branch versus the repository default branch;
- `--base <branch>`: current branch versus that base;
- `--commit <sha>`: one commit;
- `--uncommitted`: staged, unstaged, and untracked changes.

Do not pass multiple targets. Ref values are resolved to commit SHAs before any
diff command.

## Interpret the result

Read stdout between:

```text
===== CLAUDE REVIEW (final message) =====
...
===== END CLAUDE REVIEW =====
```

`SKIPPED: ...` exits successfully so AFK can use another eligible reviewer. Do
not retry a skipped gate in a loop. The stderr output contains the invocation
summary and the full transcript path.

A nonzero exit without `SKIPPED` is a real gate/tool failure. In particular,
`working tree changed during read-only review` is a hard failure: preserve the
evidence, do not auto-revert user work, and stop that review stage.

## Triage and fix

1. Treat each finding as a hypothesis. Read the cited code and verify behavior.
2. Prioritize architecture, correctness, security, concurrency, data integrity,
   breaking changes, and missed recovery paths.
3. Reject false findings with file/line evidence and the applicable spec.
4. Fix confirmed structural findings in one batch and sweep for the same pattern.
5. Run targeted and full project gates after fixes.
6. Self-review the fix before spending another Claude invocation.
7. Re-run Claude only after a meaningful structural fix batch. Stop after a clean
   structural pass or when only verified minor/documentation items remain.

Claude is the outer gate, not the final gate under `/afk codex`; Kimi still runs
after Claude.

## Configuration

- `CLAUDE_REVIEW_GATE=off`: cleanly disable the gate.
- `CLAUDE_REVIEW_MODEL=opus`: per-run model alias; default `opus`. Use
  `inherit` to keep the CLI default.
- `CLAUDE_REVIEW_MAX_TURNS=20`: bound agentic turns.
- `CLAUDE_REVIEW_TIMEOUT_MS=900000`: bound total runtime.
- `CLAUDE_REVIEW_BIN` and `CLAUDE_REVIEW_BIN_ARGS`: explicit executable/prefix
  override for tests or nonstandard installations.

The wrapper never reads Claude credential files. Authentication remains owned by
Claude Code.

## Report

Report:

- Claude verdict;
- confirmed and fixed findings;
- rejected findings with evidence;
- gate status: CLEAN / OUTSTANDING / SKIPPED / FAILED;
- whether Kimi final review still ran;
- any fallback or degraded-review condition.

Do not declare a PR mergeable solely because Claude returned a clean verdict.

## Machine setup

Claude Code must be installed and authenticated. On Windows the wrapper prefers
the native npm binary under `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin`
so PowerShell execution policy does not block the `.ps1` shim.

Validate locally:

```powershell
claude.cmd --version
claude.cmd auth status
```

