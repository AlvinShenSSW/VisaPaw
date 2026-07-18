#!/usr/bin/env node
// grok-gate.mjs — cross-platform Grok CLI external review wrapper.
//
// Mirrors kimi-gate.mjs, but drives the xAI Grok CLI (`grok`). Runs a READ-ONLY
// structural review of a branch/commit diff headlessly via `grok -p "<prompt>"` and
// prints ONLY Grok's final review between markers (transcript -> a log file).
//
// Purpose: an interchangeable external review gate (peer of codex-review /
// kimi-review). A reviewer is NEVER the implementer — use Grok only when Grok did
// not write the change. Interactively it is one of the operator's gate choices; in
// AFK it is a fallback pool member when the 外门 or Kimi 终审 is out of credits.
//
// Like Kimi (and unlike codex, which has a built-in `review` subcommand + diff
// selectors), Grok is a general agentic CLI: we pass a structured review PROMPT via
// `-p` and let Grok run git itself to read the diff. `-p/--single` is headless on its
// own — it prints the final response to stdout and exits. `--output-format plain`
// yields just the final message (no event stream). `--permission-mode
// bypassPermissions` keeps it from hanging on tool-approval prompts; the prompt is
// strictly READ-ONLY and the repo is git-tracked (any stray edit is trivially
// recoverable), mirroring codex-gate / kimi-gate's read-only review.
//
// Usage (target flags mirror kimi-gate for a familiar interface):
//   node grok-gate.mjs                 # review current branch vs default base
//   node grok-gate.mjs --base master   # review vs an explicit base branch
//   node grok-gate.mjs --commit <sha>  # review one commit
//   node grok-gate.mjs --uncommitted   # review staged/unstaged/untracked
//
// Opt out with GROK_REVIEW_GATE=off. Exit code mirrors grok; skips cleanly (exit 0)
// if grok is missing or not logged in.

import { spawnSync } from 'node:child_process';
import { openSync, writeSync, closeSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const isWin = process.platform === 'win32';

function emitSkip(reason) {
  // A skip is NOT a failure — the gate is optional. Emit the marker block so the
  // caller (Claude / the workflow step) sees a clean SKIPPED result and continues.
  process.stderr.write(`[grok-gate] skipped: ${reason}\n`);
  process.stdout.write('===== GROK REVIEW (final message) =====\n');
  process.stdout.write(`SKIPPED: ${reason}\n`);
  process.stdout.write('===== END GROK REVIEW =====\n');
  process.exit(0);
}

// Explicit opt-out — set GROK_REVIEW_GATE to off/0/false/no/disabled.
const gateFlag = (process.env.GROK_REVIEW_GATE || '').trim().toLowerCase();
if (['off', '0', 'false', 'no', 'disabled'].includes(gateFlag)) {
  emitSkip('Grok gate disabled via GROK_REVIEW_GATE.');
}

function positiveIntEnv(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  process.stderr.write(`[grok-gate] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}\n`);
  return fallback;
}

// Keep the review gate bounded even when the user's general Grok config is tuned for
// long-running agent work. A timeout self-skips so AFK can continue in the documented
// degraded-review path instead of hanging indefinitely.
const reviewTimeoutMs = positiveIntEnv('GROK_REVIEW_TIMEOUT_MS', 15 * 60 * 1000);
// Model + reasoning effort. Default model is grok-4.5 (the CLI default); override with
// GROK_REVIEW_MODEL. Reasoning effort is only passed when GROK_REVIEW_EFFORT is set,
// otherwise Grok picks its own default for the model.
const reviewModel = (process.env.GROK_REVIEW_MODEL || 'grok-4.5').trim();
const reviewEffort = (process.env.GROK_REVIEW_EFFORT || '').trim();
// Optional hard cap on agent turns. Left UNSET by default: `grok` errors out with
// "max turns reached" (and NO review) if the cap is hit mid-review, so a too-small
// value is worse than none. The spawn timeout already bounds wall-clock. Set
// GROK_REVIEW_MAX_TURNS to opt into a cap.
const maxTurns = positiveIntEnv('GROK_REVIEW_MAX_TURNS', 0);

function resolveGrok() {
  if (!isWin) return 'grok';

  const found = spawnSync('where.exe', ['grok'], { encoding: 'utf8', shell: false });
  const candidates = (found.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exe = candidates.find((candidate) => /\.exe$/i.test(candidate));
  // The installer puts grok.exe on PATH; fall back to the default install path so the
  // gate works even before a shell restart picks up the updated PATH.
  if (exe) return exe;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return home ? join(home, '.grok', 'bin', 'grok.exe') : 'grok';
}

function detectBase() {
  // origin/HEAD -> the repo's default branch (main/master/...); fall back sanely.
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    const v = spawnSync('git', ['rev-parse', '--verify', b], { encoding: 'utf8' });
    if (v.status === 0) return b;
  }
  return 'main';
}

// --- Resolve the review target (mirror kimi-gate's selector semantics) ---
const userArgs = process.argv.slice(2);
function optVal(name) {
  const i = userArgs.indexOf(name);
  return i >= 0 && i + 1 < userArgs.length ? userArgs[i + 1] : null;
}

// Sanitize branch/commit inputs: only allow characters safe for interpolation into
// the review prompt / git commands.
function sanitizeRef(val, label) {
  if (val === null) return null;
  if (!/^[a-zA-Z0-9._\-/~:@]+$/.test(val)) {
    process.stderr.write(`[grok-gate] unsafe ${label} value rejected: ${JSON.stringify(val)}\n`);
    process.exit(1);
  }
  return val;
}

const commitArg = sanitizeRef(optVal('--commit'), '--commit');
const uncommitted = userArgs.includes('--uncommitted');
const baseArg = sanitizeRef(optVal('--base'), '--base');

let scope;
if (commitArg) {
  scope = `the single commit \`${commitArg}\` (inspect with \`git show ${commitArg}\`)`;
} else if (uncommitted) {
  scope = 'all uncommitted changes — staged, unstaged, and untracked (`git diff HEAD`, `git status`, and untracked files)';
} else {
  const base = sanitizeRef(baseArg || detectBase(), '--base');
  scope = `the changes on the current branch versus \`${base}\` (inspect with \`git diff ${base}...HEAD\`)`;
}

const reviewPrompt = [
  'You are an independent senior reviewer running a structural gate before a PR merges. This is a READ-ONLY review.',
  `Review ${scope} in this git repository.`,
  'Use git and read surrounding files for context. Do NOT modify, stage, commit, write, or delete ANY file — review only.',
  'Focus on STRUCTURAL issues: architecture/design, correctness bugs, security loopholes, missed edge cases, concurrency/data-integrity, breaking changes. Ignore pure nitpicks (naming, formatting, comments).',
  'For each finding output: a severity tag [P1]=blocker / [P2] / [minor], the file:line, the problem, and a concrete fix.',
  'Finish with a one-line overall verdict (e.g. APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES). If nothing structural is wrong, say so plainly.',
  'Output ONLY the review — no preamble, no restating the task.',
].join('\n');

const grokBin = resolveGrok();

// Availability pre-check (local, no model call).
const ver = spawnSync(grokBin, ['--version'], { encoding: 'utf8', shell: false });
if (ver.error && ver.error.code === 'ENOENT') {
  emitSkip('Grok CLI not installed (run: curl -fsSL https://x.ai/cli/install.sh | bash, then `grok login`).');
}

const work = mkdtempSync(join(tmpdir(), 'grok-gate-'));
const logFile = join(work, 'grok.log');

// `-p/--single` runs one prompt non-interactively, prints the final response to stdout,
// and exits. `--output-format plain` prints just the final assistant message (not the
// agent event stream) — the analog of kimi's --final-message-only. `--permission-mode
// bypassPermissions` prevents the headless run from stalling on tool-approval prompts;
// the prompt enforces read-only and the repo is git-tracked so any stray edit is
// trivially recoverable. `--disallowed-tools` is a best-effort extra guard against the
// obvious edit tools (unknown names are tolerated by grok); git/read access is left
// intact because the review needs it.
const promptArg = isWin ? reviewPrompt.replace(/\n/g, ' ') : reviewPrompt;
const boundedArgs = [
  '--output-format',
  'plain',
  '--permission-mode',
  'bypassPermissions',
  '--disallowed-tools',
  'Write,Edit,MultiEdit,NotebookEdit',
  '--no-memory',
  '-m',
  reviewModel,
];
if (reviewEffort) boundedArgs.push('--reasoning-effort', reviewEffort);
if (maxTurns > 0) boundedArgs.push('--max-turns', String(maxTurns));
const args = [...boundedArgs, '-p', promptArg];

process.stderr.write(
  `[grok-gate] grok ${boundedArgs.join(' ')} -p <structural review prompt>\n`,
);
process.stderr.write(`[grok-gate] timeout -> ${reviewTimeoutMs}ms\n`);
process.stderr.write(`[grok-gate] transcript -> ${logFile}\n`);

const res = spawnSync(grokBin, args, {
  encoding: 'utf8',
  shell: false,
  maxBuffer: 64 * 1024 * 1024,
  timeout: reviewTimeoutMs,
});

const out = res.stdout || '';
const err = res.stderr || '';
try {
  const fd = openSync(logFile, 'w');
  writeSync(fd, out + '\n----- stderr -----\n' + err);
  closeSync(fd);
} catch {}

if (res.error && res.error.code === 'ENOENT') {
  emitSkip('Grok CLI not installed (run: curl -fsSL https://x.ai/cli/install.sh | bash, then `grok login`).');
}

if (res.error && res.error.code === 'ETIMEDOUT') {
  emitSkip(
    `Grok review timed out after ${Math.round(reviewTimeoutMs / 1000)}s. ` +
      'Set GROK_REVIEW_TIMEOUT_MS to adjust.',
  );
}

const review = out.trim();

// Not authenticated → clean skip (not a failure). The auth error goes to STDERR and
// produces NO review on stdout, so we match on `err` ONLY and require an empty review
// — otherwise a real review that merely *mentions* login/auth (e.g. when reviewing
// auth code) would false-positive into a bogus SKIP.
if (!review && /not (logged in|authenticated)|\bgrok login\b|please (log|sign) in|unauthorized|no.*credential|401|authentication (failed|required)/i.test(err)) {
  emitSkip('Grok not authenticated — run `grok login`, or set GROK_REVIEW_GATE=off to disable this gate.');
}

if (review) {
  process.stdout.write('===== GROK REVIEW (final message) =====\n');
  process.stdout.write(review + '\n');
  process.stdout.write('===== END GROK REVIEW =====\n');
} else {
  process.stderr.write(`[grok-gate] No review produced (exit ${res.status}). See ${logFile}\n`);
}

process.exit(res.status ?? 1);
