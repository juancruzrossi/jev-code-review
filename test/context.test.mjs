import './isolated-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('a Claude Bash payload and a Codex apply_patch payload each report the right path:line, and a read-only tool call with no change prints nothing', async () => {
  const payloads = [
    { tool_name: 'Bash', tool_input: { command: "cat >> a.js <<'EOF'\nconst b = 2;\nEOF" } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: a.js\n@@\n-const b = 2;\n+const b = 3;\n*** End Patch' } }
  ];
  for (const payload of payloads) {
    const dir = makeRepo('jev-hook-repo-');
    writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const stdout = await runHook(
      { hook_event_name: 'PostToolUse', cwd: dir, session_id: 's1', ...payload },
      { JEV_STUB_PROB: '0.9' }
    );
    const message = JSON.parse(stdout);
    assert.match(message.hookSpecificOutput.additionalContext, /Jev after edit:/);
    assert.match(message.hookSpecificOutput.additionalContext, /a\.js:2 — Bug 90%/);
  }
  {
    const dir = makeRepo('jev-hook-repo-');
    const stdout = await runHook(
      { hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } },
      { JEV_STUB_PROB: '0.9' }
    );
    assert.equal(stdout, '');
  }
});
