#!/usr/bin/env node
// Independent Claude Code structural review gate.
// The wrapper, not Claude, resolves git scope and creates the review packet.
// Claude runs in plan mode with read-only tools; a before/after workspace
// fingerprint is a second containment layer.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const isWin = process.platform === 'win32';
const MAX_BUFFER = 64 * 1024 * 1024;

function marker(message) {
  process.stdout.write('===== CLAUDE REVIEW (final message) =====\n');
  process.stdout.write(`${message.trim()}\n`);
  process.stdout.write('===== END CLAUDE REVIEW =====\n');
}

function skip(reason) {
  process.stderr.write(`[claude-gate] skipped: ${reason}\n`);
  marker(`SKIPPED: ${reason}`);
  process.exit(0);
}

function fail(reason) {
  process.stderr.write(`[claude-gate] ${reason}\n`);
  process.exit(1);
}

function positiveIntEnv(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  process.stderr.write(
    `[claude-gate] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}\n`,
  );
  return fallback;
}

const gateFlag = (process.env.CLAUDE_REVIEW_GATE || '').trim().toLowerCase();
if (['off', '0', 'false', 'no', 'disabled'].includes(gateFlag)) {
  skip('Claude gate disabled via CLAUDE_REVIEW_GATE.');
}

const timeoutMs = positiveIntEnv('CLAUDE_REVIEW_TIMEOUT_MS', 15 * 60 * 1000);
const maxTurns = positiveIntEnv('CLAUDE_REVIEW_MAX_TURNS', 20);
const modelRaw = (process.env.CLAUDE_REVIEW_MODEL || 'opus').trim();
const inheritModel = ['inherit', 'default', 'config', ''].includes(
  modelRaw.toLowerCase(),
);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
    ...options,
  });
}

function requireOutput(result, label) {
  if (result.error) {
    fail(`${label} failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim();
    fail(`${label} failed (exit ${result.status}): ${detail}`);
  }
  return result.stdout || '';
}

const repoResult = run('git', ['rev-parse', '--show-toplevel']);
const repo = requireOutput(repoResult, 'git rev-parse').trim();

function git(args) {
  return run('git', args, { cwd: repo });
}

function gitText(args, label) {
  return requireOutput(git(args), label || `git ${args[0]}`);
}

function resolveRef(ref, label) {
  if (!/^[a-zA-Z0-9._\-/~:@]+$/.test(ref) || ref.startsWith('-')) {
    fail(`unsafe ${label} value rejected: ${JSON.stringify(ref)}`);
  }
  const resolved = gitText(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    `resolve ${label}`,
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(resolved)) {
    fail(`could not resolve ${label}: ${JSON.stringify(ref)}`);
  }
  return resolved;
}

function detectBase() {
  const remote = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.status === 0 && remote.stdout.trim()) {
    return remote.stdout.trim().replace(/^origin\//, '');
  }
  for (const name of ['main', 'master']) {
    const found = git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
    if (found.status === 0) return name;
  }
  fail('cannot detect a default base branch; pass --base <branch>.');
}

function parseTarget(args) {
  let target = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--uncommitted') {
      if (target) fail('pass exactly one review target.');
      target = { kind: 'uncommitted' };
      continue;
    }
    if (arg === '--base' || arg === '--commit') {
      if (target || i + 1 >= args.length) {
        fail(`invalid or duplicate target ${arg}.`);
      }
      target = { kind: arg.slice(2), value: args[i + 1] };
      i += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return target || { kind: 'base', value: detectBase() };
}

function buildPacket(target) {
  const head = resolveRef('HEAD', 'HEAD');
  const status = gitText(
    ['status', '--short', '--untracked-files=all'],
    'git status',
  );
  let scope;
  let diff;

  if (target.kind === 'commit') {
    const commit = resolveRef(target.value, '--commit');
    scope = `single commit ${commit}`;
    diff = gitText(
      [
        'show',
        '--no-ext-diff',
        '--no-color',
        '--find-renames',
        '--format=fuller',
        commit,
        '--',
      ],
      'git show',
    );
  } else if (target.kind === 'uncommitted') {
    scope = `uncommitted changes relative to HEAD ${head}`;
    const tracked = gitText(
      ['diff', '--no-ext-diff', '--no-color', '--find-renames', 'HEAD', '--'],
      'git diff HEAD',
    );
    const untracked = gitText(
      ['ls-files', '--others', '--exclude-standard'],
      'git ls-files',
    );
    diff = `${tracked}\n\nUNTRACKED FILES (read from the repository when relevant):\n${untracked}`;
  } else {
    const base = resolveRef(target.value, '--base');
    scope = `current HEAD ${head} versus base ${base} (${target.value})`;
    diff = gitText(
      [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--find-renames',
        `${base}...${head}`,
        '--',
      ],
      'git diff base',
    );
  }

  return [
    'CLAUDE REVIEW PACKET',
    `Repository: ${repo}`,
    `Scope: ${scope}`,
    '',
    'WORKTREE STATUS AT REVIEW START',
    status || '(clean)',
    '',
    'TARGET DIFF',
    diff || '(empty diff)',
  ].join('\n');
}

function workspaceFingerprint() {
  const status = gitText(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    'fingerprint status',
  );
  const tracked = gitText(
    ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'],
    'fingerprint diff',
  );
  const untracked = gitText(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    'fingerprint untracked',
  );
  const hash = createHash('sha256').update(status).update('\0').update(tracked);
  for (const relativePath of untracked.split('\0').filter(Boolean).sort()) {
    const absolutePath = resolve(repo, relativePath);
    hash.update('\0').update(relativePath).update('\0');
    try {
      hash.update(readFileSync(absolutePath));
    } catch (error) {
      hash.update(`[unreadable:${error.code || error.message}]`);
    }
  }
  return hash.digest('hex');
}

function parsePrefixArgs() {
  const raw = (process.env.CLAUDE_REVIEW_BIN_ARGS || '').trim();
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error('must be a JSON string array');
    }
    return value;
  } catch (error) {
    fail(`invalid CLAUDE_REVIEW_BIN_ARGS: ${error.message}`);
  }
}

function resolveClaude() {
  const override = (process.env.CLAUDE_REVIEW_BIN || '').trim();
  if (override) return { command: override, prefixArgs: parsePrefixArgs() };

  if (isWin && process.env.APPDATA) {
    const native = join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (existsSync(native)) return { command: native, prefixArgs: [] };

    const where = run('where.exe', ['claude.exe']);
    const candidate = (where.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (where.status === 0 && candidate) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  return { command: 'claude', prefixArgs: [] };
}

const target = parseTarget(process.argv.slice(2));
const packet = buildPacket(target);
const before = workspaceFingerprint();
const work = mkdtempSync(join(tmpdir(), 'claude-gate-'));
const packetFile = join(work, 'review-packet.txt');
const logFile = join(work, 'claude.log');
writeFileSync(packetFile, packet, 'utf8');

const prompt = [
  'You are the independent OUTER structural review gate before a PR reaches final review.',
  'This is strictly READ-ONLY. Do not modify, create, delete, stage, commit, push, or merge anything.',
  `Read the review packet at ${JSON.stringify(packetFile)} first.`,
  'Then read AGENTS.md and only the surrounding repository files needed to verify the diff.',
  'Use only Read, Glob, and Grep. Do not ask for or attempt any other tool.',
  'Focus on real structural risks: architecture, correctness, security, concurrency, data integrity, recovery behavior, breaking changes, and missed edge cases.',
  'Ignore pure style, naming, formatting, and comment nitpicks.',
  'For each finding output [P1] blocker, [P2], or [minor], followed by file:line, impact, evidence, and a concrete fix.',
  'Finish with exactly one overall verdict: APPROVE, APPROVE WITH COMMENTS, or REQUEST CHANGES.',
  'If no structural issue exists, say so plainly. Output only the review, without a preamble.',
].join('\n');

const claude = resolveClaude();
const version = run(claude.command, [...claude.prefixArgs, '--version'], { cwd: repo });
if (version.error && version.error.code === 'ENOENT') {
  skip('Claude Code CLI not installed.');
}
if (version.status !== 0) {
  skip('Claude Code CLI is installed but unavailable.');
}

const args = [
  ...claude.prefixArgs,
  '-p',
  prompt,
  '--output-format',
  'json',
  '--permission-mode',
  'plan',
  '--max-turns',
  String(maxTurns),
  '--allowedTools',
  'Read,Glob,Grep',
  '--disallowedTools',
  'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch',
  '--add-dir',
  work,
];
if (!inheritModel) args.push('--model', modelRaw);

process.stderr.write(
  `[claude-gate] ${claude.command} <read-only review prompt> --max-turns ${maxTurns}` +
    `${inheritModel ? '' : ` --model ${modelRaw}`}\n`,
);
process.stderr.write(`[claude-gate] packet -> ${packetFile}\n`);
process.stderr.write(`[claude-gate] transcript -> ${logFile}\n`);
process.stderr.write(`[claude-gate] timeout -> ${timeoutMs}ms\n`);

const result = run(claude.command, args, {
  cwd: repo,
  timeout: timeoutMs,
});
const stdout = result.stdout || '';
const stderr = result.stderr || '';
writeFileSync(logFile, `${stdout}\n----- stderr -----\n${stderr}`, 'utf8');

const after = workspaceFingerprint();
if (after !== before) {
  fail(
    'working tree changed during read-only review; preserve evidence and do not auto-revert user work.',
  );
}

if (result.error && result.error.code === 'ETIMEDOUT') {
  skip(`Claude review timed out after ${Math.round(timeoutMs / 1000)}s.`);
}
if (result.error && result.error.code === 'ENOENT') {
  skip('Claude Code CLI not installed.');
}

const combined = `${stdout}\n${stderr}`;
const unavailable =
  /not logged in|not authenticated|authentication required|please (log|sign) in|usage limit|rate limit|quota|out of credits|credit balance/i;

let payload = null;
try {
  payload = JSON.parse(stdout.trim());
} catch {
  if (unavailable.test(combined)) {
    skip('Claude is not authenticated or has no available quota.');
  }
  fail(`Claude produced invalid JSON (exit ${result.status}); see ${logFile}`);
}

if (payload?.is_error || result.status !== 0) {
  const detail = String(payload?.result || payload?.error || stderr || '').trim();
  if (unavailable.test(detail || combined)) {
    skip('Claude is not authenticated or has no available quota.');
  }
  fail(`Claude review failed (exit ${result.status}): ${detail || `see ${logFile}`}`);
}

const review = String(payload?.result || '').trim();
if (!review) {
  fail(`Claude produced no final review; see ${logFile}`);
}

marker(review);

