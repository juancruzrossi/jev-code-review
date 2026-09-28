import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const __ruleProbs = process.env.JEV_STUB_RULE_PROBS ? JSON.parse(process.env.JEV_STUB_RULE_PROBS) : null;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);

  if (typeof body.state.instructions_file === 'string') {
    process.stderr.write('EXTRACT:' + JSON.stringify(body.state.instructions_file) + '\\n');
    const answers = {};
    for (const key of Object.keys(body.questions)) answers[key] = { noul: 0.9 };
    return { ok: true, json: async () => ({ answers }) };
  }

  process.stderr.write('TASK:' + JSON.stringify(body.state.task) + '\\n');
  process.stderr.write('REVIEWKEYS:' + JSON.stringify(Object.keys(body.questions)) + '\\n');
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
      if (__ruleProbs && key in __ruleProbs) {
        prob = __ruleProbs[key];
      } else if (__roundProbs) {
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
  for (const name of (process.env.JEV_STUB_MISSING ?? '').split(',')) delete answers[name];
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

function extractExtractedFiles(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('EXTRACT:'))
    .map((line) => JSON.parse(line.slice('EXTRACT:'.length)));
}

function reviewCallCount(stderr) {
  return stderr.split('\n').filter((line) => line.startsWith('REVIEWKEYS:')).length;
}

function agentsDiff(filePath) {
  return `diff --git a/${filePath} b/${filePath}
index 111..222 100644
--- a/${filePath}
+++ b/${filePath}
@@ -1,1 +1,2 @@
 const a = 1;
+console.log(a);
`;
}

function ruleCachePathFor(content) {
  const key = createHash('sha1').update(content).digest('hex');
  return path.join(tmpdir(), `jev-rules-${key}.json`);
}

function makeApiWebFixture() {
  const dir = makeRepo('jev-monorepo-');
  mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
  mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
  const apiRule = 'Never call console.log directly in this codebase.\n';
  const webRule = 'Never use inline styles in components.\n';
  writeFileSync(path.join(dir, 'packages', 'api', 'AGENTS.md'), apiRule);
  writeFileSync(path.join(dir, 'packages', 'web', 'AGENTS.md'), webRule);
  rmSync(ruleCachePathFor(apiRule), { force: true });
  rmSync(ruleCachePathFor(webRule), { force: true });
  return dir;
}

test('a single call sends its own task, reports round 1, and never prints a marker', async () => {
  const { stdout, stderr } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.95' });
  assert.deepEqual(extractTasks(stderr), ['A']);
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /Round 1\/3/);
  assert.doesNotMatch(text, /jev:previous/);
});

test('below the advise tier reports no findings with no Must-resolve or Check section', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /No findings — deliver\./);
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
  assert.equal(text.split('\n').at(-1), `No blockers — ${RULE_NAMES.length} to check. Open each line and change it only if the problem is real.`);
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

test('after no findings the next call with the same task starts a new round 1', async () => {
  const { stdout } = await runServer(
    [call(1, { task: 'A' }), call(2, { task: 'A' })],
    { JEV_STUB_PROB: '0.05' }
  );
  const text1 = extractResult(stdout, 1).content[0].text;
  const text2 = extractResult(stdout, 2).content[0].text;
  assert.match(text1, /No findings — deliver\./);
  assert.match(text2, /No findings — deliver\./);
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
  assert.match(text4, /No findings — deliver\./);
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
  assert.match(text, /No findings — deliver\./);
});

test('a violation of an api AGENTS.md rule is reported with the rule text and its source file', async () => {
  const dir = makeApiWebFixture();
  try {
    const diff = agentsDiff('packages/api/x.js');
    const { stdout } = await runServer(
      [call(1, { task: 'A', diff })],
      { JEV_STUB_PROB: '0.05', JEV_STUB_RULE_PROBS: JSON.stringify({ agents_1: 0.95 }) },
      dir
    );
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /"Never call console\.log directly in this codebase\." \(packages\/api\/AGENTS\.md\) 95%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rules from web AGENTS.md are never asked for an api-only change', async () => {
  const dir = makeApiWebFixture();
  try {
    const diff = agentsDiff('packages/api/x.js');
    const { stdout, stderr } = await runServer([call(1, { task: 'A', diff })], { JEV_STUB_PROB: '0.05' }, dir);
    const text = extractResult(stdout, 1).content[0].text;
    assert.doesNotMatch(text, /inline styles/);
    assert.deepEqual(extractExtractedFiles(stderr), ['packages/api/AGENTS.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no AGENTS files anywhere means only built-in questions are asked and the output matches the unscoped shape', async () => {
  const dir = makeRepo('jev-noagents-');
  try {
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'Money amounts are integers in cents.');
    const { stdout, stderr } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' }, dir);
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /No findings — deliver\./);
    assert.doesNotMatch(text, /agents_/);
    assert.doesNotMatch(text, /project rules/);
    assert.deepEqual(extractExtractedFiles(stderr), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage 2 locate is skipped when no project rule reaches the advisory tier', async () => {
  const dir = makeRepo('jev-lowscore-');
  try {
    mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
    writeFileSync(path.join(dir, 'packages', 'api', 'AGENTS.md'), 'Never call console.log directly in this codebase.\n');
    const diff = agentsDiff('packages/api/x.js');
    const { stdout, stderr } = await runServer([call(1, { task: 'A', diff })], { JEV_STUB_PROB: '0.05' }, dir);
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /No findings — deliver\./);
    assert.equal(reviewCallCount(stderr), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('explicit cwd loads project rules when the server starts outside a repo', async () => {
  const dir = makeRepo('jev-explicit-cwd-');
  const outside = mkdtempSync(path.join(tmpdir(), 'jev-outside-'));
  try {
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Never call console.warn in this project.\n');
    mkdirSync(path.join(dir, '.jev'));
    writeFileSync(path.join(dir, '.jev', 'rules.json'), JSON.stringify([{ name: 'local_rule', rule: 'Avoid globals.' }]));
    const { stdout, stderr } = await runServer([call(1, { task: 'A', cwd: dir })], {}, outside);
    assert.equal(extractResult(stdout, 1).isError, undefined);
    assert.match(stderr, /REVIEWKEYS:.*agents_1/);
    assert.match(stderr, /REVIEWKEYS:.*local_rule/);
    for (const cwd of [undefined, path.join(outside, 'missing'), serverPath, 42]) {
      const result = await runServer([call(1, { task: 'A', cwd })], {}, outside);
      assert.equal(extractResult(result.stdout, 1).isError, undefined);
      assert.doesNotMatch(result.stderr, /agents_1|local_rule/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


for (const missing of [RULE_NAMES, ['defect']]) {
  test(`missing answers fail the review: ${missing.join(', ')}`, async () => {
    const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_MISSING: missing.join(',') });
    const result = extractResult(stdout, 1);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `Jev returned no answer for: ${missing.join(', ')}. Review not completed.`);
    assert.doesNotMatch(result.content[0].text, /PASSED/);
  });
}

for (const [probability, mark] of [[0.549, '✓'], [0.55, '!'], [0.899, '!'], [0.9, '✗']]) {
  test(`table marks probability ${probability} with ${mark}`, async () => {
    const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: String(probability) });
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, new RegExp(`│ defect +│ ${Math.round(probability * 100)}% ${mark} +│`));
  });
}
