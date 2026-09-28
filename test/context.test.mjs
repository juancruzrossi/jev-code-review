import './isolated-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL } from '../context.mjs';
import { makeRepo } from './git-repo-fixture.mjs';

const contextPath = fileURLToPath(new URL('../context.mjs', import.meta.url));

const FETCH_STUB = `
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const prob = Number(process.env.JEV_STUB_PROB ?? 0.05);
  const lineProb = Number(process.env.JEV_STUB_LINE_PROB ?? 0.9);
  const answers = {};
  for (const [key, q] of Object.entries(body.questions)) {
    if (q.type === 'noul') answers[key] = { noul: prob };
    if (q.type === 'choice') {
      const ids = Object.keys(q.criteria);
      const pick = ids[0];
      answers[key] = { choice: pick, probabilities: { [pick]: lineProb } };
    }
  }
  return { ok: true, json: async () => ({ answers }) };
};
`;

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

test('a Bash payload after appending to a tracked file reports the right path:line (Claude Code)', async () => {
  const dir = makeRepo('jev-hook-repo-');
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const stdout = await runHook(
      {
        hook_event_name: 'PostToolUse',
        cwd: dir,
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: "cat >> a.js <<'EOF'\nconst b = 2;\nEOF" }
      },
      { JEV_STUB_PROB: '0.9' }
    );
    const message = JSON.parse(stdout);
    assert.match(message.hookSpecificOutput.additionalContext, /Jev after edit:/);
    assert.match(message.hookSpecificOutput.additionalContext, /a\.js:2 — defect 90%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex apply_patch payload with tool_input.command reports the right path:line', async () => {
  const dir = makeRepo('jev-hook-repo-');
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const stdout = await runHook(
      {
        hook_event_name: 'PostToolUse',
        cwd: dir,
        session_id: 's1',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Update File: a.js\n@@\n-const b = 2;\n+const b = 3;\n*** End Patch' }
      },
      { JEV_STUB_PROB: '0.9' }
    );
    const message = JSON.parse(stdout);
    assert.match(message.hookSpecificOutput.additionalContext, /Jev after edit:/);
    assert.match(message.hookSpecificOutput.additionalContext, /a\.js:2 — defect 90%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PostToolUse Edit payload with a Fix-tier defect reports the right path:line', async () => {
  const dir = makeRepo('jev-hook-repo-');
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

test('a Fix-tier defect with a low line confidence flags the location as uncertain', async () => {
  const dir = makeRepo('jev-hook-repo-');
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const stdout = await runHook(
      { hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.js') } },
      { JEV_STUB_PROB: '0.9', JEV_STUB_LINE_PROB: '0.3' }
    );
    const message = JSON.parse(stdout);
    assert.match(message.hookSpecificOutput.additionalContext, /a\.js:2 \(line uncertain\) — defect 90%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('below-tier answers produce no output', async () => {
  const dir = makeRepo('jev-hook-repo-');
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

test('a read-only tool call with no file change produces no output', async () => {
  const dir = makeRepo('jev-hook-repo-');
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
  const dir = makeRepo('jev-hook-repo-');
  try {
    const stdout = await runHook({ hook_event_name: 'SessionStart', cwd: dir });
    const message = JSON.parse(stdout);
    assert.match(message.hookSpecificOutput.additionalContext, /jev-code-review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('full context tells callers to always pass their working directory', () => {
  assert.match(FULL, /task, diff, cwd\?, files\?, context\?/);
  assert.match(FULL, /always pass `cwd` = the agent's current working directory/);
});

test('full context describes honest verdicts without promising correctness', () => {
  assert.match(FULL, /No findings/);
  assert.match(FULL, /No blockers/);
  assert.match(FULL, /neither guarantees correctness/);
  assert.doesNotMatch(FULL, /PASSED/);
});
