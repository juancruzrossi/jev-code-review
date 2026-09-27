import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './git-repo-fixture.mjs';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

const DIFF = `diff --git a/a.js b/a.js
index 111..222 100644
--- a/a.js
+++ b/a.js
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;

const RULE_NAMES = ['addresses_task', 'unrelated_change', 'needs_clarification', 'missing_requirement', 'defect'];

const FETCH_STUB = `
const RULE_NAMES = ${JSON.stringify(RULE_NAMES)};
let __call = 0;
const __roundProbs = process.env.JEV_STUB_ROUND_PROBS ? JSON.parse(process.env.JEV_STUB_ROUND_PROBS) : null;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  process.stderr.write('TASK:' + JSON.stringify(body.state.task) + '\\n');
  process.stderr.write('PROJECT_RULES:' + JSON.stringify(body.state.project_rules ?? null) + '\\n');
  const delayMs = Number(process.env.JEV_STUB_DELAY_MS ?? 0);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  const round = __call;
  __call += 1;
  const scalarProb = Number(process.env.JEV_STUB_PROB ?? 0.05);
  const lineProb = Number(process.env.JEV_STUB_LINE_PROB ?? 0.9);
  const answers = {};
  for (const [key, q] of Object.entries(body.questions)) {
    if (q.type === 'noul') {
      let prob = scalarProb;
      if (__roundProbs) {
        const idx = RULE_NAMES.indexOf(key);
        const roundArr = __roundProbs[Math.min(round, __roundProbs.length - 1)];
        prob = roundArr[idx];
      }
      answers[key] = { noul: prob };
    }
    if (q.type === 'choice') {
      const ids = Object.keys(q.criteria);
      const pick = ids[0];
      answers[key] = { choice: pick, probabilities: { [pick]: lineProb } };
    }
  }
  return { ok: true, json: async () => ({ answers }) };
};
`;

function runServer(requests, extraEnv = {}, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, serverPath],
      { env: { ...process.env, JEV_API_KEY: 'test', ...extraEnv }, ...(cwd ? { cwd } : {}) }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));

    let index = 0;
    const sendNext = () => {
      if (index >= requests.length) {
        child.stdin.end();
        return;
      }
      const req = requests[index];
      index += 1;
      const onData = (d) => {
        if (new RegExp(`"id":${req.id}\\b`).test(d.toString())) {
          child.stdout.removeListener('data', onData);
          sendNext();
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify(req) + '\n');
    };
    sendNext();
  });
}

function runServerPipelined(requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, serverPath],
      { env: { ...process.env, JEV_API_KEY: 'test', ...extraEnv } }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));
    for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n');
    child.stdin.end();
  });
}

function call(id, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'jev_review', arguments: { diff: DIFF, ...args } } };
}

function extractTasks(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('TASK:'))
    .map((line) => JSON.parse(line.slice(5)));
}

function extractResult(stdout, id) {
  return stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((msg) => msg.id === id).result;
}

function extractProjectRules(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('PROJECT_RULES:'))
    .map((line) => JSON.parse(line.slice('PROJECT_RULES:'.length)));
}

test('a single call sends its own task, reports round 1, and never prints a marker', async () => {
  const { stdout, stderr } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.95' });
  assert.deepEqual(extractTasks(stderr), ['A']);
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /Round 1\/3/);
  assert.doesNotMatch(text, /jev:previous/);
});

test('below the advise tier reports PASSED with no Must-resolve or Check section', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /PASSED — deliver\./);
  assert.doesNotMatch(text, /^Must resolve/m);
  assert.doesNotMatch(text, /^Check/m);
});

test('a must-resolve finding is printed with its path:line and the verdict names round 1', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.95' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /^Must resolve/m);
  assert.match(text, /- a\.js:2 — defect 95%:/);
  assert.match(text, /Round 1\/3/);
});

test('a must-resolve finding with a low line confidence flags the location as uncertain', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.95', JEV_STUB_LINE_PROB: '0.3' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /- a\.js:2 \(line uncertain\) — defect 95%:/);
});

test('an advise-tier finding prints the Check section', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.6' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /^Check — open the line/m);
  assert.match(text, /- a\.js:2 — defect 60%:/);
});

test('two calls with the same task continue the loop as round 2 with two table columns', async () => {
  const { stdout, stderr } = await runServer(
    [call(1, { task: 'A' }), call(2, { task: 'A' })],
    { JEV_STUB_PROB: '0.95' }
  );
  assert.deepEqual(extractTasks(stderr), ['A', 'A']);
  const text2 = extractResult(stdout, 2).content[0].text;
  assert.match(text2, /│\s*Round 1\s*│\s*Final\s*│/);
});

test('a reworded task with exactly one open loop continues it', async () => {
  const { stdout, stderr } = await runServer(
    [call(1, { task: 'A' }), call(2, { task: 'A, but rephrased' })],
    { JEV_STUB_PROB: '0.95' }
  );
  assert.deepEqual(extractTasks(stderr), ['A', 'A']);
  const text2 = extractResult(stdout, 2).content[0].text;
  assert.match(text2, /│\s*Round 1\s*│\s*Final\s*│/);
});

test('after PASSED the next call with the same task starts a new round 1', async () => {
  const { stdout } = await runServer(
    [call(1, { task: 'A' }), call(2, { task: 'A' })],
    { JEV_STUB_PROB: '0.05' }
  );
  const text1 = extractResult(stdout, 1).content[0].text;
  const text2 = extractResult(stdout, 2).content[0].text;
  assert.match(text1, /PASSED — deliver\./);
  assert.match(text2, /PASSED — deliver\./);
  assert.doesNotMatch(text2, /Round \d/);
});

test('a block count that does not drop reports no real progress', async () => {
  const { stdout } = await runServer(
    [call(1, { task: 'A' }), call(2, { task: 'A' })],
    { JEV_STUB_PROB: '0.95' }
  );
  const text2 = extractResult(stdout, 2).content[0].text;
  assert.match(text2, /No real progress/);
});

test('three rounds hit max rounds, then the next call starts a new round 1', async () => {
  const roundProbs = JSON.stringify([
    [0.9, 0.9, 0.9, 0.9, 0.9],
    [0.9, 0.05, 0.05, 0.05, 0.05],
    [0.9, 0.05, 0.05, 0.05, 0.05],
    [0.05, 0.05, 0.05, 0.05, 0.05]
  ]);
  const { stdout } = await runServer(
    [call(1, { task: 'A' }), call(2, { task: 'A' }), call(3, { task: 'A' }), call(4, { task: 'A' })],
    { JEV_STUB_ROUND_PROBS: roundProbs }
  );
  const text3 = extractResult(stdout, 3).content[0].text;
  const text4 = extractResult(stdout, 4).content[0].text;
  assert.match(text3, /Max rounds reached/);
  assert.match(text4, /PASSED — deliver\./);
  assert.doesNotMatch(text4, /Round \d/);
});

test('two pipelined calls sent before either response arrives still resolve as round 1 then round 2', async () => {
  const { stdout } = await runServerPipelined(
    [call(1, { task: 'A' }), call(2, { task: 'A' })],
    { JEV_STUB_PROB: '0.95', JEV_STUB_DELAY_MS: '30' }
  );
  const text1 = extractResult(stdout, 1).content[0].text;
  const text2 = extractResult(stdout, 2).content[0].text;
  assert.doesNotMatch(text1, /│\s*Round 1\s*│\s*Final\s*│/);
  assert.match(text2, /│\s*Round 1\s*│\s*Final\s*│/);
});

test('a call with a stray previous argument works', async () => {
  const { stdout } = await runServer([call(1, { task: 'A', previous: 'garbage' })], { JEV_STUB_PROB: '0.05' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /PASSED — deliver\./);
});

test('a git root with AGENTS.md sends its text as state.project_rules and asks the project_rules question', async () => {
  const dir = makeRepo('jev-agents-');
  try {
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Never call console.log.');
    const { stdout, stderr } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' }, dir);
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /project_rules/);
    const [rules] = extractProjectRules(stderr);
    assert.match(rules, /# AGENTS\.md/);
    assert.match(rules, /Never call console\.log\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a git root with CLAUDE.md only sends its text as state.project_rules', async () => {
  const dir = makeRepo('jev-claude-');
  try {
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'Money amounts are integers in cents.');
    const { stdout, stderr } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' }, dir);
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /project_rules/);
    const [rules] = extractProjectRules(stderr);
    assert.match(rules, /# CLAUDE\.md/);
    assert.match(rules, /Money amounts are integers in cents\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a git root with neither file never asks the project_rules question', async () => {
  const dir = makeRepo('jev-noagents-');
  try {
    const { stdout, stderr } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' }, dir);
    const text = extractResult(stdout, 1).content[0].text;
    assert.doesNotMatch(text, /project_rules/);
    const [rules] = extractProjectRules(stderr);
    assert.equal(rules, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
