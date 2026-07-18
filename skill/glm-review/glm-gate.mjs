#!/usr/bin/env node
// glm-gate.mjs — Z.ai GLM (glm-5.2) external review wrapper.
//
// Mirrors kimi-gate.mjs / codex-gate.mjs, but GLM is reached over the Z.ai
// REST API (NOT an agentic CLI), so this script gathers the diff + full
// changed-file contents ITSELF via git and sends them to glm-5.2's chat
// completions endpoint. Prints ONLY GLM's final review between markers.
//
// External review gate, interchangeable with codex/kimi. Run ONE gate per
// round; the gate model must differ from the implementer's (never self-review)
// and be a current-generation mainstream frontier model. glm-5.2 qualifies.
//
// Usage (target flags mirror kimi-gate for a familiar interface):
//   node glm-gate.mjs                 # review current branch vs default base
//   node glm-gate.mjs --base main     # review vs an explicit base branch
//   node glm-gate.mjs --commit <sha>  # review one commit
//   node glm-gate.mjs --uncommitted   # review staged/unstaged/untracked
//
// Auth: reads ZAI_API_KEY (or GLM_API_KEY) from the environment.
// Opt out with GLM_REVIEW_GATE=off. Skips cleanly (exit 0) if no key.
//
// Env knobs:
//   ZAI_API_KEY / GLM_API_KEY   — API key (required; else clean skip)
//   GLM_REVIEW_MODEL            — model id (default: glm-5.2)
//   GLM_REVIEW_BASE_URL         — override base (default: https://api.z.ai/api/paas/v4)
//   GLM_REVIEW_MAX_CTX_BYTES    — cap on diff+files payload (default: 400000)
//   GLM_REVIEW_GATE=off         — disable the gate

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MARK_START = '===== GLM REVIEW (final message) =====';
const MARK_END = '===== END GLM REVIEW =====';

function emitSkip(reason) {
  process.stderr.write(`[glm-gate] skipped: ${reason}\n`);
  process.stdout.write(MARK_START + '\n');
  process.stdout.write(`SKIPPED: ${reason}\n`);
  process.stdout.write(MARK_END + '\n');
  process.exit(0);
}

function emitReview(text) {
  process.stdout.write(MARK_START + '\n');
  process.stdout.write(text.trim() + '\n');
  process.stdout.write(MARK_END + '\n');
}

// --- opt-out ---
const gateFlag = (process.env.GLM_REVIEW_GATE || '').trim().toLowerCase();
if (['off', '0', 'false', 'no', 'disabled'].includes(gateFlag)) {
  emitSkip('GLM gate disabled via GLM_REVIEW_GATE.');
}

// Key resolution: env first, then a .env file (repo convention). When run from
// a git worktree, .env lives in the MAIN worktree, so probe the common-dir too.
function keyFromDotenv() {
  const gitTop = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim();
  const commonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout?.trim();
  const mainWorktree = commonDir ? dirname(commonDir) : ''; // .../moomoo/.git -> .../moomoo
  const candidates = [join(process.cwd(), '.env'), gitTop && join(gitTop, '.env'), mainWorktree && join(mainWorktree, '.env')].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?(ZAI_API_KEY|GLM_API_KEY)\s*=\s*(.+?)\s*$/);
        if (m) return m[2].replace(/^["']|["']$/g, '').trim();
      }
    } catch { /* ignore */ }
  }
  return '';
}

const apiKey = (process.env.ZAI_API_KEY || process.env.GLM_API_KEY || keyFromDotenv() || '').trim();
if (!apiKey) {
  emitSkip('No API key — set ZAI_API_KEY (or GLM_API_KEY) in env or .env, or GLM_REVIEW_GATE=off to disable.');
}

const model = (process.env.GLM_REVIEW_MODEL || 'glm-5.2').trim();
// Default to the Anthropic-compatible endpoint (covered by the GLM Coding Plan
// subscription, same one Claude Code/Cline use). GLM_REVIEW_BASE_URL overrides:
// https://api.z.ai/api/coding/paas/v4 = Coding Plan OpenAI-style;
// https://api.z.ai/api/paas/v4 = pay-as-you-go (needs a pay-as-you-go key —
// Coding Plan keys are not interchangeable with it).
// The request/response format is auto-selected from the URL (see below).
const baseUrl = (process.env.GLM_REVIEW_BASE_URL || 'https://api.z.ai/api/anthropic').replace(/\/+$/, '');
const maxCtx = parseInt(process.env.GLM_REVIEW_MAX_CTX_BYTES || '400000', 10) || 400000;

// --- git helpers ---
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : '';
}
function detectBase() {
  const r = git(['rev-parse', '--abbrev-ref', 'origin/HEAD']).trim();
  if (r) return r.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (git(['rev-parse', '--verify', b]).trim()) return b;
  return 'main';
}

// --- resolve target ---
const userArgs = process.argv.slice(2);
const optVal = (n) => { const i = userArgs.indexOf(n); return i >= 0 && i + 1 < userArgs.length ? userArgs[i + 1] : null; };
const commitArg = optVal('--commit');
const uncommitted = userArgs.includes('--uncommitted');
const baseArg = optVal('--base');

let scopeLabel, diff, stat, changedFiles;
if (commitArg) {
  scopeLabel = `the single commit ${commitArg}`;
  diff = git(['show', commitArg]);
  stat = git(['show', '--stat', '--oneline', commitArg]);
  changedFiles = git(['show', '--name-only', '--pretty=format:', commitArg]).split('\n').filter(Boolean);
} else if (uncommitted) {
  scopeLabel = 'all uncommitted changes (staged + unstaged + untracked)';
  diff = git(['diff', 'HEAD']);
  stat = git(['diff', '--stat', 'HEAD']);
  const tracked = git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  changedFiles = [...new Set([...tracked, ...untracked])];
} else {
  // Prefer the REMOTE base ref — a local `main` can be far stale, which would
  // balloon a 3-dot diff to the whole history. `origin/<base>` is the true base.
  const rawBase = baseArg || detectBase();
  const hasRef = (r) => spawnSync('git', ['rev-parse', '--verify', '--quiet', r]).status === 0;
  const base = /\//.test(rawBase) ? rawBase
    : (hasRef(`origin/${rawBase}`) ? `origin/${rawBase}` : rawBase);
  scopeLabel = `the changes on the current branch versus ${base} (git diff ${base}...HEAD)`;
  diff = git(['diff', `${base}...HEAD`]);
  stat = git(['diff', '--stat', `${base}...HEAD`]);
  changedFiles = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
}

if (!diff.trim() && !changedFiles.length) {
  emitSkip(`No changes found for ${scopeLabel}.`);
}

// --- assemble bounded context: diff first (capped), then full file contents ---
// The diff is the core signal; give it up to 60% of the budget, truncate the
// rest with a marker so a pathologically large diff can't blow the request.
const diffCap = Math.floor(maxCtx * 0.6);
let diffText = diff;
if (diffText.length > diffCap) {
  diffText = diffText.slice(0, diffCap) + `\n\n[diff truncated at ${diffCap} bytes of ${diff.length} — raise GLM_REVIEW_MAX_CTX_BYTES or scope the review to fewer files]\n`;
}
let payload = `## Diff stat\n${stat}\n\n## Full diff\n${diffText}\n`;
let budget = maxCtx - payload.length;

let filesBlock = '\n## Full current contents of changed files (for context)\n';
for (const f of changedFiles) {
  if (budget <= 0) { filesBlock += `\n[omitted remaining files — context budget reached]\n`; break; }
  let content = '';
  try {
    const st = statSync(f);
    if (!st.isFile()) continue;
    if (st.size > 200000) { filesBlock += `\n### ${f}\n[skipped — file >200KB]\n`; continue; }
    content = readFileSync(f, 'utf8');
  } catch { continue; } // deleted/untracked-binary/etc.
  const block = `\n### ${f}\n\`\`\`\n${content}\n\`\`\`\n`;
  if (block.length > budget) { filesBlock += `\n### ${f}\n[truncated — context budget reached]\n`; break; }
  filesBlock += block;
  budget -= block.length;
}
payload += filesBlock;

const systemPrompt = [
  'You are an independent senior software reviewer running the LAST structural gate before a pull request merges. This is a READ-ONLY review — you cannot and must not modify anything; you are given the diff and the full current contents of the changed files.',
  'Focus on STRUCTURAL issues: architecture/design, correctness bugs, security loopholes, missed edge cases, concurrency/data-integrity, breaking changes, fail-direction. Ignore pure nitpicks (naming, formatting, comments) unless they cause a real defect.',
  'For each finding output: a severity tag [P1]=blocker / [P2] / [minor], the file:line, the problem, and a concrete fix.',
  'Finish with a one-line overall verdict: APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES. If nothing structural is wrong, say so plainly.',
  'Output ONLY the review — no preamble, no restating the task.',
].join('\n');

const userPrompt = `Review ${scopeLabel}.\n\n${payload}`;

// Auto-select the wire format from the base URL: the Anthropic-compatible
// endpoint (…/anthropic) uses POST /v1/messages with a top-level `system` and
// `content[].text` responses; the paas/v4 endpoint uses OpenAI chat/completions.
const isAnthropic = /\/anthropic(\/|$)/.test(baseUrl);
const url = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
process.stderr.write(`[glm-gate] POST ${url}  model=${model}  mode=${isAnthropic ? 'anthropic' : 'openai'}  payload=${payload.length}B  files=${changedFiles.length}\n`);

const headers = { 'Content-Type': 'application/json' };
let reqBody;
if (isAnthropic) {
  headers['Authorization'] = `Bearer ${apiKey}`;   // ANTHROPIC_AUTH_TOKEN style
  headers['x-api-key'] = apiKey;                    // x-api-key style (belt-and-suspenders)
  headers['anthropic-version'] = '2023-06-01';
  reqBody = JSON.stringify({
    model,
    max_tokens: 8192,                               // required by the Messages API
    temperature: 0.2,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
} else {
  headers['Authorization'] = `Bearer ${apiKey}`;
  reqBody = JSON.stringify({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
}

let resp, data;
try {
  resp = await fetch(url, { method: 'POST', headers, body: reqBody });
} catch (e) {
  emitSkip(`network error calling Z.ai (${e && e.message ? e.message : e}). Gate skipped.`);
}

const raw = await resp.text();
if (!resp.ok) {
  if (resp.status === 401 || resp.status === 403) {
    emitSkip(`Z.ai auth failed (HTTP ${resp.status}) — check ZAI_API_KEY. ${raw.slice(0, 200)}`);
  }
  process.stderr.write(`[glm-gate] HTTP ${resp.status}: ${raw.slice(0, 500)}\n`);
  emitSkip(`Z.ai HTTP ${resp.status} — gate could not run. ${raw.slice(0, 200)}`);
}

try { data = JSON.parse(raw); } catch { emitSkip(`Z.ai returned non-JSON: ${raw.slice(0, 200)}`); }
const review = (isAnthropic
  ? (Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
  : (data?.choices?.[0]?.message?.content || '')
).trim();
if (!review) {
  emitSkip(`Z.ai returned no content: ${JSON.stringify(data).slice(0, 300)}`);
}

emitReview(review);
process.exit(0);
