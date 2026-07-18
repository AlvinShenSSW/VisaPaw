import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const gate = join(here, 'claude-gate.mjs');

function command(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-gate-test-'));
  command(dir, 'git', ['init', '-q']);
  command(dir, 'git', ['config', 'user.email', 'gate@example.invalid']);
  command(dir, 'git', ['config', 'user.name', 'Gate Test']);
  writeFileSync(join(dir, 'app.py'), 'value = 1\n', 'utf8');
  command(dir, 'git', ['add', 'app.py']);
  command(dir, 'git', ['commit', '-qm', 'initial']);
  writeFileSync(join(dir, 'app.py'), 'value = 2\n', 'utf8');

  const fake = join(dir, 'fake-claude.mjs');
  writeFileSync(
    fake,
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake claude 1.0'); process.exit(0); }
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const mode = process.env.FAKE_CLAUDE_MODE || 'success';
if (mode === 'auth') { console.error('Not logged in. Please log in.'); process.exit(1); }
if (mode === 'timeout') { await new Promise((r) => setTimeout(r, 2000)); }
if (mode === 'mutate') writeFileSync(join(process.cwd(), 'app.py'), 'value = 999\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '[P2] app.py:1 example finding\\nREQUEST CHANGES' }));
`,
    'utf8',
  );
  return { dir, fake };
}

function runGate({ dir, fake, mode = 'success', extraEnv = {} }) {
  return spawnSync(process.execPath, [gate, '--uncommitted'], {
    cwd: dir,
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_REVIEW_BIN: process.execPath,
      CLAUDE_REVIEW_BIN_ARGS: JSON.stringify([fake]),
      CLAUDE_REVIEW_MODEL: 'inherit',
      FAKE_CLAUDE_MODE: mode,
      ...extraEnv,
    },
  });
}

test('disabled gate self-skips without a repository', () => {
  const result = spawnSync(process.execPath, [gate], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_REVIEW_GATE: 'off' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SKIPPED: Claude gate disabled/);
});

test('successful gate emits only the final marker and enforces read-only flags', () => {
  const { dir, fake } = fixture();
  const argsFile = join(mkdtempSync(join(tmpdir(), 'claude-gate-args-')), 'args.json');
  const result = runGate({ dir, fake, extraEnv: { FAKE_ARGS_FILE: argsFile } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^===== CLAUDE REVIEW/m);
  assert.match(result.stdout, /REQUEST CHANGES/);
  const args = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.ok(args.includes('plan'));
  assert.ok(args.includes('Read,Glob,Grep'));
  assert.ok(args.includes('Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch'));
});

test('authentication failure self-skips', () => {
  const { dir, fake } = fixture();
  const result = runGate({ dir, fake, mode: 'auth' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIPPED: Claude is not authenticated/);
});

test('timeout self-skips', () => {
  const { dir, fake } = fixture();
  const result = runGate({
    dir,
    fake,
    mode: 'timeout',
    extraEnv: { CLAUDE_REVIEW_TIMEOUT_MS: '100' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIPPED: Claude review timed out/);
});

test('workspace mutation is a hard failure', () => {
  const { dir, fake } = fixture();
  const result = runGate({ dir, fake, mode: 'mutate' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /working tree changed during read-only review/);
});

test(
  'real Claude CLI completes a read-only one-line diff review',
  { skip: process.env.CLAUDE_REVIEW_REAL_SMOKE !== '1', timeout: 180000 },
  () => {
    const { dir } = fixture();
    const result = spawnSync(process.execPath, [gate, '--uncommitted'], {
      cwd: dir,
      encoding: 'utf8',
      shell: false,
      timeout: 180000,
      env: {
        ...process.env,
        CLAUDE_REVIEW_MODEL: 'opus',
        CLAUDE_REVIEW_MAX_TURNS: '6',
        CLAUDE_REVIEW_TIMEOUT_MS: '120000',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^===== CLAUDE REVIEW/m);
    assert.doesNotMatch(result.stdout, /SKIPPED:/);
    assert.match(
      result.stdout,
      /APPROVE|APPROVE WITH COMMENTS|REQUEST CHANGES/,
    );
    assert.equal(readFileSync(join(dir, 'app.py'), 'utf8'), 'value = 2\n');
  },
);
