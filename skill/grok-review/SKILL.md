---
name: grok-review
description: Run Grok (xAI Grok CLI, default model grok-4.5) as a read-only, second-opinion structural review gate on the current PR/branch, then triage and fix the findings. A peer of codex-review / kimi-review — interchangeable interactively whenever reviewer != implementer, and an AFK fallback pool member when the 外门 or Kimi 终审 is out of credits. Scoped to architecture + real bugs. CTO review first, external gate last. Never run Grok as a reviewer of a change Grok implemented. Triggers include "/grok-review", "run grok review", "grok gate".
preferred_model: claude-opus-4-7
role: external-reviewer
phase: pre-merge
workflow: review-and-fix
---

# Grok Review Gate

You are running the **Grok review gate** — an independent second-opinion review by
the xAI Grok CLI (a *different* model, default **grok-4.5**), used as a structural
check before a PR is handed back for approval. Grok is a **peer of the
[Codex](../codex-review/SKILL.md) and [Kimi](../kimi-review/SKILL.md) gates**: same
role, same discipline, same output contract — only the underlying model differs.

The core invariant is unchanged: **a reviewer is never the implementer.** Use Grok
only to review a change Grok did *not* write. Run the CTO review (`cto-pr-review`)
**first** and resolve its verdict, then run this gate on the result. Grok reviews the
diff read-only; you (Claude) triage and fix.

The helper and prompt **ship with this repo** at
[`skill/grok-review/grok-gate.mjs`](grok-gate.mjs) — the gate travels with the code,
so every clone/worktree/operator gets the same pipeline.

## Where Grok fits (peer / fallback — it does NOT change the AFK waterfall)

The mandatory AFK waterfall is unchanged: **CTO → 外门 → Kimi 终审** (Codex 外门 under
default `/afk`, Claude 外门 under `/afk codex`). Grok joins as an **interchangeable
peer**, not a new mandatory stage:

- **Interactive:** the operator may pick Grok as either external gate, exactly like
  Codex or Kimi, as long as Grok did not implement the change.
- **AFK fallback pool:** if the 外门 **or** the Kimi 终审 is unavailable (out of
  quota / not installed / not logged in / timed out), Grok is an eligible stand-in so
  the run still gets two independent external reviews instead of degrading to one.
  Substituting Grok for a downed gate is **not** a degraded run — but note the
  substitution in the report. Only when no valid non-implementer gate remains do you
  fall back to CTO alone and record `external gate unavailable`.
- **Never as its own reviewer:** if a future `/afk grok` driver variant is added,
  Grok is the implementer there and this gate must not run — pick Codex/Claude/Kimi.

Adding Grok does **not** add a third always-run stage; it widens the pool of valid
non-implementer gates so a single outage no longer forces a single-review run.

**Grok calls are metered — keep invocations to an absolute minimum.** Batch all
findings into one fix pass, self-review, and only then re-run; defer
documentation/minor items to a single final pass. Never burn a round-trip on a small
or doc-only edit.

**Scope:** the gate drives Grok as a **structural code reviewer** — architecture/
design, correctness, security, safety, missed edge cases. Like Kimi (and unlike
Codex's built-in `review` subcommand), Grok is a general agentic CLI, so the helper
passes a strict READ-ONLY review prompt via `grok -p` and lets Grok run git itself to
read the diff. Treat what comes back as high-signal — but still verify each finding,
prioritise structural items over nitpicks, and do **not** chase exhaustive polish
(see **When to stop**).

## How to run it

1. Invoke the in-repo helper **in the background** (the review is slow — it reads the
   diff, traces code paths, may run tests). Capture stdout to a file, and pass any
   operator-provided target flag (`--base <branch>` / `--commit <sha>` /
   `--uncommitted`; default = current branch vs the repo's default branch):

   - **Windows (PowerShell):**
     `node "skill/grok-review/grok-gate.mjs" 1> "$env:TEMP\grok_gate.out" 2> "$env:TEMP\grok_gate.err"`
   - **macOS / Linux (zsh/bash):**
     `node "skill/grok-review/grok-gate.mjs" 1> "${TMPDIR:-/tmp}/grok_gate.out" 2> "${TMPDIR:-/tmp}/grok_gate.err"`

   Run it with `run_in_background: true` and a generous timeout (≥ 900000 ms). Do not
   poll in a sleep loop — wait for the completion notification.

   The helper enforces its own bounded review settings so AFK cannot hang if the outer
   tool timeout is missed: it drives `grok -p` headless with `--output-format plain`
   (final message only, no event stream) and `--permission-mode bypassPermissions` (so
   it never stalls on tool-approval prompts). Model defaults to **grok-4.5**
   (`GROK_REVIEW_MODEL` overrides); `GROK_REVIEW_TIMEOUT_MS` defaults to 900000 (15
   minutes); `GROK_REVIEW_EFFORT` (unset by default) maps to `--reasoning-effort`;
   `GROK_REVIEW_MAX_TURNS` (unset by default) opts into a turn cap. A helper timeout
   emits a normal `SKIPPED: ... timed out ...` marker; treat it as a degraded review,
   report it to the operator, and continue with the remaining gate.

2. When it completes, read the `.out` file. Grok's verdict is between the
   `===== GROK REVIEW (final message) =====` markers. The `.err` file holds the
   invocation line and the path to the full transcript log. **If the verdict is
   `SKIPPED: …`** — Grok not installed, not logged in, or disabled via
   `GROK_REVIEW_GATE=off` — the gate is intentionally optional: report that it was
   skipped and continue. Do not treat a skip as a failure and do not retry.

## How to handle the findings (batch — minimise calls)

Identical discipline to `codex-review` / `kimi-review`. The cost you are managing is
the **number of invocations**, not the size of each one. Never re-run for a single fix
or a doc tweak.

1. **Sort findings by kind.** *Structural* (architecture, design, correctness bugs,
   security loopholes, missed edge cases) — act on these. *Minor* (naming, comments,
   cosmetics) — set aside in a deferred list; do NOT act yet.
2. **Verify before trusting.** Each finding is a hypothesis. Read the cited file:line
   — Grok can misread context. Push back with evidence (file:line + actual behavior +
   spec) on anything you can disprove; do not capitulate to a wrong finding.
3. **Fix every confirmed structural finding in one batch**, and sweep for the same
   pattern elsewhere. Keep design/spec docs in sync in the same change.
4. **Run one additional self-review pass** over your fixes.
5. **Only then re-run this gate once.** Repeat 1–5 until the **stop rule** holds.
6. **Deferred-docs/minor pass — once, at the very end.** Do NOT re-run just to confirm.

## When to stop (convergence)

Stop and hand back to the operator when ANY holds:

- a round returns **no new P1 (blocker) findings** — only P2/minor or implementation-detail;
- you have done roughly **2–3 fix→re-run rounds** and findings are getting progressively
  finer, or narrowing to one already-addressed subsystem (you are reviewing your own
  last fix's wording);
- it is a **design-only doc** and the remainder is implementation-detail that TDD will
  enforce in code anyway.

Report honestly — `CLEAN` (nothing structural) vs `OUTSTANDING — loop stopped by
judgment` (with what's left) — and let the **operator** decide whether to spend more
metered rounds.

## Report back

End with a concise summary:

- **Grok verdict:** (its final message, quoted)
- **Confirmed & fixed:** (each finding + the fix)
- **Disagreed:** (each finding you rejected + the evidence)
- **Gate status:** CLEAN / OUTSTANDING (and what remains)

Do not merge, push, or declare the PR ready on the strength of a clean pass alone —
hand it back to the operator for their own approval, per the project workflow.

## Relationship to codex-review / kimi-review

- **Same output contract** (a marker block + per-finding triage) as the other two
  gates, so they compose cleanly and Grok can substitute for either.
- **AFK order is unchanged:** the mandatory waterfall is still CTO → 外门 → Kimi 终审.
  Grok is a fallback stand-in for a downed 外门 or 终审, not an added stage.
- **Interactive:** the operator picks any one valid non-implementer gate; if it is out
  of credits, fall back to another (Codex / Kimi / Grok).

## Setup (per machine, once)

Grok is optional and self-skipping. To make the gate live: install the Grok CLI
(`curl -fsSL https://x.ai/cli/install.sh | bash`) then **`grok login`** (browser
OAuth; credentials cached in `~/.grok/auth.json`). Needs Node + `git` on PATH; on
Windows the installer drops `grok.exe` in `%USERPROFILE%\.grok\bin` (add it to PATH).
Disable permanently with `GROK_REVIEW_GATE=off`. The helper drives `grok -p` headless
with a read-only prompt.
