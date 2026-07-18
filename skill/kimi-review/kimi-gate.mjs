#!/usr/bin/env node
// kimi-gate.mjs — cross-platform Kimi Code CLI external review wrapper.
//
// Mirrors codex-gate.mjs, but drives the Kimi Code CLI (`kimi`). Runs a READ-ONLY
// structural review of a branch/commit diff headlessly via `kimi -p "<prompt>"` and
// prints ONLY Kimi's final review between markers (transcript -> a log file).
//
// Purpose: the AFK 终审 (final external review), run LAST after the 外门 in BOTH
// variants — Codex 外门 under default /afk, Claude 外门 under /afk codex. Kimi is
// always the final reviewer; the 外门 is the non-implementer driver model. A
// reviewer is never the implementer (no Codex reviewer under /afk codex).
//
// Unlike codex (which has a built-in `review` subcommand + diff selectors), Kimi is
// a general agentic CLI: we pass a structured review PROMPT via `-p` and let Kimi run
// git itself to read the diff. `-p` is headless on its own (kimi rejects combining it
// with -y/--auto). The prompt is strictly READ-ONLY and the repo is git-tracked (any
// stray edit is trivially recoverable), mirroring codex-gate's read-only review.
//
// Usage (target flags mirror codex-gate for a familiar interface):
//   node kimi-gate.mjs                 # review current branch vs default base
//   node kimi-gate.mjs --base master   # review vs an explicit base branch
//   node kimi-gate.mjs --commit <sha>  # review one commit
//   node kimi-gate.mjs --uncommitted   # review staged/unstaged/untracked
//
// Opt out with KIMI_REVIEW_GATE=off. Exit code mirrors kimi; skips cleanly (exit 0)
// if kimi is missing or not logged in.

import { spawnSync } from 'node:child_process';
import { openSync, writeSync, closeSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const isWin = process.platform === 'win32';

function emitSkip(reason) {
  // A skip is NOT a failure — the gate is optional. Emit the marker block so the
  // caller (Claude / the workflow step) sees a clean SKIPPED result and continues.
  process.stderr.write(`[kimi-gate] skipped: ${reason}\n`);
  process.stdout.write('===== KIMI REVIEW (final message) =====\n');
  process.stdout.write(`SKIPPED: ${reason}\n`);
  process.stdout.write('===== END KIMI REVIEW =====\n');
  process.exit(0);
}

// Explicit opt-out — set KIMI_REVIEW_GATE to off/0/false/no/disabled.
const gateFlag = (process.env.KIMI_REVIEW_GATE || '').trim().toLowerCase();
if (['off', '0', 'false', 'no', 'disabled'].includes(gateFlag)) {
  emitSkip('Kimi gate disabled via KIMI_REVIEW_GATE.');
}

function positiveIntEnv(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  process.stderr.write(`[kimi-gate] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}\n`);
  return fallback;
}

// Keep the review gate bounded even when the user's general Kimi config is tuned
// for long-running agent work. A timeout self-skips so AFK can continue in the
// documented degraded-review path instead of hanging indefinitely.
// kimi-code >= 0.23 removed the per-turn step/retry caps and thinking toggles that
// older kimi_cli exposed (--max-steps-per-turn etc.); the helper timeout is now the
// only boundedness control. Warn if the operator still sets the retired knobs.
const reviewTimeoutMs = positiveIntEnv('KIMI_REVIEW_TIMEOUT_MS', 15 * 60 * 1000);
for (const retired of ['KIMI_REVIEW_MAX_STEPS', 'KIMI_REVIEW_MAX_RETRIES', 'KIMI_REVIEW_THINKING']) {
  if ((process.env[retired] || '').trim()) {
    process.stderr.write(`[kimi-gate] ${retired} is retired (kimi-code >= 0.23 dropped the flag); ignoring.\n`);
  }
}

function resolveKimi() {
  if (!isWin) return { command: 'kimi', viaCmd: false };

  const found = spawnSync('where.exe', ['kimi'], { encoding: 'utf8', shell: false });
  const candidates = (found.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exe = candidates.find((candidate) => /\.exe$/i.test(candidate));
  if (exe) return { command: exe, viaCmd: false };

  return { command: 'kimi', viaCmd: true };
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

// --- Resolve the review target (mirror codex-gate's selector semantics) ---
const userArgs = process.argv.slice(2);
function optVal(name) {
  const i = userArgs.indexOf(name);
  return i >= 0 && i + 1 < userArgs.length ? userArgs[i + 1] : null;
}

// Sanitize branch/commit inputs: only allow characters safe for shell interpolation.
// This prevents command injection when shell:true routes args through cmd.exe on Windows.
function sanitizeRef(val, label) {
  if (val === null) return null;
  if (!/^[a-zA-Z0-9._\-/~:@]+$/.test(val)) {
    process.stderr.write(`[kimi-gate] unsafe ${label} value rejected: ${JSON.stringify(val)}\n`);
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
  'You are an independent senior reviewer running the LAST structural gate before a PR merges. This is a READ-ONLY review.',
  `Review ${scope} in this git repository.`,
  'Use git and read surrounding files for context. Do NOT modify, stage, commit, write, or delete ANY file — review only.',
  'Focus on STRUCTURAL issues: architecture/design, correctness bugs, security loopholes, missed edge cases, concurrency/data-integrity, breaking changes. Ignore pure nitpicks (naming, formatting, comments).',
  'For each finding output: a severity tag [P1]=blocker / [P2] / [minor], the file:line, the problem, and a concrete fix.',
  'Finish with a one-line overall verdict (e.g. APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES). If nothing structural is wrong, say so plainly.',
  'Output ONLY the review — no preamble, no restating the task.',
].join('\n');

const kimi = resolveKimi();

// Availability pre-check (local, no model call).
const ver = kimi.viaCmd
  ? spawnSync('cmd.exe', ['/c', kimi.command, '--version'], { encoding: 'utf8', shell: false })
  : spawnSync(kimi.command, ['--version'], { encoding: 'utf8', shell: false });
if (ver.error && ver.error.code === 'ENOENT') {
  emitSkip('Kimi CLI not installed (run: npm i -g @moonshot-ai/kimi-code && kimi login).');
}

const work = mkdtempSync(join(tmpdir(), 'kimi-gate-'));
const logFile = join(work, 'kimi.log');

// `-p` runs one prompt non-interactively and prints the response. It is headless on
// its own — `kimi` rejects combining `-p` with `-y/--auto/--yolo`. The prompt enforces
// read-only; the repo is git-tracked so any stray edit is trivially recoverable.
// Directly spawning kimi.exe on Windows lets Node's timeout kill the actual Kimi
// process instead of only killing cmd.exe. If only a .cmd shim is available, fall
// back to cmd.exe and quote the prompt for shell parsing.
const promptArg = isWin ? reviewPrompt.replace(/\n/g, ' ') : reviewPrompt;
// kimi-code (>= 0.23): `-p/--prompt` runs one prompt non-interactively and prints
// ONLY the response (the old kimi_cli --print/--final-message-only pair is gone —
// prompt mode subsumes both). `--output-format text` keeps stdout to plain text.
const boundedArgs = ['--output-format', 'text'];
const args = isWin
  ? [...boundedArgs, '-p', kimi.viaCmd ? `"${promptArg}"` : promptArg]
  : [...boundedArgs, '-p', promptArg];

// Review-gate context/cost controls:
//   - kimi-code >= 0.23 exposes no thinking toggle or step caps in prompt mode;
//     boundedness comes solely from the helper timeout above.
//   - AGENTS.md project-doc: Kimi injects it once per session (not per-turn), so the cost
//     is small (~1.5k tokens), and the only way to suppress it would be hiding the tracked
//     file mid-review — which pollutes the working-tree git state Kimi inspects. Not worth it.
process.stderr.write(
  `[kimi-gate] kimi ${boundedArgs.join(' ')} -p <structural review prompt>\n`,
);
process.stderr.write(`[kimi-gate] timeout -> ${reviewTimeoutMs}ms\n`);
process.stderr.write(`[kimi-gate] transcript -> ${logFile}\n`);

const res = kimi.viaCmd
  ? spawnSync('cmd.exe', ['/c', kimi.command, ...args], {
      encoding: 'utf8',
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      timeout: reviewTimeoutMs,
    })
  : spawnSync(kimi.command, args, {
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
  emitSkip('Kimi CLI not installed (run: npm i -g @moonshot-ai/kimi-code && kimi login).');
}

if (res.error && res.error.code === 'ETIMEDOUT') {
  emitSkip(
    `Kimi review timed out after ${Math.round(reviewTimeoutMs / 1000)}s. ` +
      'Set KIMI_REVIEW_TIMEOUT_MS to adjust.',
  );
}

// kimi-code appends a session-resume trailer ("To resume this session: kimi -r
// session_...") to stdout in prompt mode — bookkeeping, not review content.
// Strip ONLY trailing lines matching the resume invocation (a review that
// legitimately quotes `kimi -r session_...` mid-text must survive intact).
const lines = out.split('\n');
while (lines.length) {
  const last = lines[lines.length - 1].trim();
  if (last === '' || /kimi\s+-r\s+session_[A-Za-z0-9_-]+/.test(last)) lines.pop();
  else break;
}
const review = lines.join('\n').trim();

// Not authenticated / no model configured → clean skip (not a failure).
// The auth error ("No model configured…") goes to STDERR and produces NO review on
// stdout, so we match on `err` ONLY and require an empty review — otherwise a real
// review that merely *mentions* login/auth/unauthorized (e.g. when reviewing auth code
// or a test's X-API-KEY header) would false-positive into a bogus SKIP.
if (!review && /no model configured|use \/login|\bkimi login\b|not (logged in|authenticated)|unauthorized|please (log|sign) in/i.test(err)) {
  emitSkip('Kimi not authenticated — run `kimi login`, or set KIMI_REVIEW_GATE=off to disable this gate.');
}

if (review) {
  process.stdout.write('===== KIMI REVIEW (final message) =====\n');
  process.stdout.write(review + '\n');
  process.stdout.write('===== END KIMI REVIEW =====\n');
} else {
  process.stderr.write(`[kimi-gate] No review produced (exit ${res.status}). See ${logFile}\n`);
}

process.exit(res.status ?? 1);
