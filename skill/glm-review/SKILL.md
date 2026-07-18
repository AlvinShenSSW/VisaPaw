---
name: glm-review
description: Run GLM (Z.ai glm-5.2) as a read-only, second-opinion structural review gate on the current PR/branch, then triage and fix the findings. A peer of codex-review / kimi-review / grok-review — interchangeable as the 外门 whenever reviewer != implementer, and an AFK fallback pool member when the 外门 or Kimi 终审 is down. Same role, different model (reached over the Z.ai REST API rather than an agentic CLI). Scoped to architecture + real bugs. CTO review first, external gates last. Triggers include "/glm-review", "run glm review", "glm gate", "/afk glm".
preferred_model: claude-opus-4-7
role: external-reviewer
phase: pre-merge
workflow: review-and-fix
---

# GLM Review Gate

You are running the **GLM review gate** — an independent second-opinion review by
**Z.ai's `glm-5.2`** (a *different* model from the implementer), used as a structural
check before a PR is handed back for approval. GLM is a **peer of the
[Codex](../codex-review/SKILL.md), [Kimi](../kimi-review/SKILL.md), and
[Grok](../grok-review/SKILL.md) gates**: same role, same discipline, same output
contract — only the underlying model (and transport) differs. Two hard constraints
govern any gate choice: (1) the gate's model is **not the model that implemented the
change** (a model never reviews its own work), and (2) it is a **current-generation
mainstream frontier model** (`glm-5.2` qualifies).

The mandatory AFK waterfall is unchanged (see [`afk`](../afk/SKILL.md), the canonical
spec): **CTO → 外门 → Kimi 终审 — both external stages run.** GLM joins as an
**interchangeable peer**, not a new mandatory stage:

- **Interactive:** the operator may pick GLM as the 外门, exactly like Codex or Grok
  (`/afk glm` names it explicitly; the operator's explicit choice wins).
- **AFK fallback pool:** if the 外门 **or** the Kimi 终审 is unavailable, GLM is an
  eligible stand-in so the run still gets two independent external reviews.
  Substituting GLM for a downed gate is **not** a degraded run — but note the
  substitution in the report.

Run the CTO review (`cto-pr-review`) **first** and resolve its verdict, then run the
external gates on the result: **CTO first, external gates last.**

## How this differs from codex/kimi (important)

Codex and Kimi are **agentic CLIs** that run `git` themselves and can explore the whole
repo and run tests. **GLM here is reached over the Z.ai REST API** (`glm-5.2`), which is
NOT agentic — so the helper (`glm-gate.mjs`) gathers the diff **and the full current
contents of every changed file** itself and sends them to GLM. Consequences:

- GLM sees the **diff + changed files in full**, but cannot freely open arbitrary
  other files or run tests. It is a strong **diff-scoped structural review**, slightly
  narrower than the agentic gates. Still a valid independent frontier-model gate.
- Large diffs are **bounded** (`GLM_REVIEW_MAX_CTX_BYTES`, default 400 KB; the diff is
  capped, then changed-file contents fill the rest) so a huge PR can't blow the request.

## Auth (one-time)

The helper reads the API key from `ZAI_API_KEY` (or `GLM_API_KEY`), from the environment
**or** from `.env` (repo convention; it probes the main-worktree `.env` when run from a
git worktree). Add to `.env`:

```
ZAI_API_KEY=<your Z.ai key>
```

**GLM Coding Plan** (this repo's default setup): create the key from the Coding Plan
dashboard (docs: https://docs.z.ai/devpack/quick-start); it works against the default
base URL `https://api.z.ai/api/anthropic` and is covered by the subscription quota.
Pay-as-you-go keys (https://z.ai/manage-apikey/apikey-list) instead require
`GLM_REVIEW_BASE_URL=https://api.z.ai/api/paas/v4` — the two key types are not
interchangeable.

No key, or `GLM_REVIEW_GATE=off` → the gate **skips cleanly** (exit 0, `SKIPPED: …`),
exactly like an uninstalled codex/kimi.

## How to run it

Invoke the in-repo helper **in the background** (the review reads the diff + files and
calls the API — it is slow). Capture stdout to a file; pass any operator target flag
(`--base <branch>` / `--commit <sha>` / `--uncommitted`; default = current branch vs the
repo's default base, resolved to `origin/<base>` so a stale local ref can't balloon the
diff). Note: under `--uncommitted`, untracked new files don't appear in the diff section
but their full contents are still sent via the changed-files block:

- **macOS / Linux (zsh/bash):**
  `node "skill/glm-review/glm-gate.mjs" --base main 1> "${TMPDIR:-/tmp}/glm_gate.out" 2> "${TMPDIR:-/tmp}/glm_gate.err"`

Run with `run_in_background: true` and a generous timeout (≥ 600000 ms). Wait for the
completion notification — do not sleep-poll.

When it completes, read the `.out` file. GLM's verdict is between the
`===== GLM REVIEW (final message) =====` markers. If the verdict is `SKIPPED: …`
(no key / auth failure / HTTP error / disabled), the gate is intentionally optional:
report that it was skipped, record it, and continue. Do not treat a skip as a failure.

## How to handle the findings (batch — minimise calls)

Identical discipline to `codex-review` / `kimi-review`. Findings carry a severity tag
(`[P1]`=blocker / `[P2]` / `[minor]`), a `file:line`, the problem, and a fix, ending in a
one-line verdict (APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES).

1. **Verify each finding** against the cited code — findings are hypotheses until
   confirmed. GLM only saw the diff + changed files, so double-check any claim that
   depends on code it could not see.
2. **Act on structural findings** (architecture, correctness, security, edge cases,
   data-integrity, fail-direction); defer pure nitpicks to a single final pass.
3. **Push back** on incorrect findings with `file:line` evidence.
4. Batch fixes into **one** commit, re-run targeted tests, then (only if needed) re-run
   the gate. Never burn a round-trip on a single fix or a doc tweak.

## AFK usage

In `afk` mode the waterfall still runs **two** external stages — 外门 then Kimi 终审
(see the `afk` skill's Degraded-external-review rule). GLM slots in as the 外门 when
the operator names it (`/afk glm`), or as a pool stand-in for a downed 外门/终审;
otherwise the variant's default gates apply. Record the gate choice + outcome (incl.
any `SKIPPED`) in the ledger and end-of-run report, exactly as for codex/kimi/grok.

## Config knobs

- `ZAI_API_KEY` / `GLM_API_KEY` — API key (env or `.env`).
- `GLM_REVIEW_MODEL` — model id (default `glm-5.2`).
- `GLM_REVIEW_BASE_URL` — API base (default `https://api.z.ai/api/anthropic`, the
  Coding-Plan Anthropic-compatible endpoint). Alternatives:
  `https://api.z.ai/api/coding/paas/v4` (Coding Plan, OpenAI-style) or
  `https://api.z.ai/api/paas/v4` (pay-as-you-go, OpenAI-style — needs a
  pay-as-you-go key, NOT interchangeable with a Coding Plan key). The wire format
  (Anthropic Messages vs OpenAI chat/completions) is auto-selected from the URL.
- `GLM_REVIEW_MAX_CTX_BYTES` — diff+files payload cap (default `400000`).
- `GLM_REVIEW_GATE=off` — disable the gate (clean skip).
