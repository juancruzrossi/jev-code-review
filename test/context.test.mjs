import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const contextPath = fileURLToPath(new URL('../context.mjs', import.meta.url));

const FETCH_STUB = `
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const prob = Number(process.env.JEV_STUB_PROB ?? 0.05);
  const answers = {};
  for (const [key, q] of Object.entries(body.questions)) {
    if (q.type === 'noul') answers[key] = { noul: prob };
    if (q.type === 'choice') {
      const ids = Object.keys(q.criteria);
      const pick = ids[0];
      answers[key] = { choice: pick, probabilities: { [pick]: 0.9 } };
    }
  }
  return { ok: true, json: async () => ({ answers }) };
};
`;

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-hook-repo-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  execFileSync('git', ['-C', dir, 'add', 'a.js']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function runHook(payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, contextPath],
      { env: { ...process.env, JEV_API_KEY: 'test', ...extraEnv } }
    );
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test('a PostToolUse Edit payload with a Fix-tier defect reports the right path:line', async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const stdout = await runHook(
      { hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.js') } },
      { JEV_STUB_PROB: '0.9' }
    );
    const message = JSON.parse(stdout);
    assert.match(message.hookSpecificOutput.additionalContext, /Jev after edit:/);
    assert.match(message.hookSpecificOutput.additionalContext, /a\.js:2 — defect 90%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('below-tier answers produce no output', async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const stdout = await runHook(
      { hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.js') } },
      { JEV_STUB_PROB: '0.05' }
    );
    assert.equal(stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrelated tool produces no output', async () => {
  const dir = makeRepo();
  try {
    const stdout = await runHook(
      { hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } },
      { JEV_STUB_PROB: '0.9' }
    );
    assert.equal(stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart still emits the full context, unaffected by the PostToolUse handler', async () => {
  const dir = makeRepo();
  try {
    const stdout = await runHook({ hook_event_name: 'SessionStart', cwd: dir });
    const message = JSON.parse(stdout);
    assert.match(message.hookSpecificOutput.additionalContext, /jev-code-review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
