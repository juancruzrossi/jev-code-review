import './isolated-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const RULE_NAMES = ['addresses_task', 'unrelated_change', 'missing_requirement', 'defect'];

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
  const stateDir = mkdtempSync(path.join(tmpdir(), 'jev-state-'));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, serverPath],
      { env: { ...process.env, JEV_API_KEY: 'test', XDG_STATE_HOME: stateDir, ...extraEnv }, ...(cwd ? { cwd } : {}) }
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
  }).finally(() => rmSync(stateDir, { recursive: true, force: true }));
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

test('a clean review sends its task, reports round 1, renders a well-formed table with no findings, and marks each tier correctly', async () => {
  {
    const { stdout, stderr } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.95' });
    assert.deepEqual(extractTasks(stderr), ['A']);
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /Round 1\/3/);
    assert.doesNotMatch(text, /jev:previous/);
  }

  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /No findings — good to go\./);
  assert.doesNotMatch(text, /^Must resolve/m);
  assert.doesNotMatch(text, /^Check/m);

  const lines = text.split('\n');
  const table = lines.slice(0, lines.findIndex((l) => l.startsWith('└')) + 1);
  assert.match(table[0], /^┌─+┐$/);
  assert.match(table[1], /^│\s+Jev Code Review\s+│$/);
  assert.match(table[2], /^├─+┬[─┬]*┤$/);
  assert.match(table[3], /│\s+Rule\s+│/);
  assert.equal(new Set(table.map((l) => [...l].length)).size, 1);

  for (const [probability, mark] of [[0.549, '✓'], [0.55, '!'], [0.899, '!'], [0.9, '✗']]) {
    const { stdout: out } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: String(probability) });
    const t = extractResult(out, 1).content[0].text;
    assert.match(t, new RegExp(`│ Defects +│ ${Math.round(probability * 100)}% ${mark} +│`));
  }
});

test('a must-resolve finding prints its path:line and flags a low line confidence, an advise-tier finding prints the Check section', async () => {
  {
    const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.95' });
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /^Must resolve/m);
    assert.match(text, /- a\.js:2 — Defects 95%:/);
    assert.match(text, /Round 1\/3/);
  }
  {
    const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.95', JEV_STUB_LINE_PROB: '0.3' });
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /- a\.js:2 \(line uncertain\) — Defects 95%:/);
  }
  {
    const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.6' });
    const text = extractResult(stdout, 1).content[0].text;
    assert.match(text, /^Check — open the line/m);
    assert.match(text, /- a\.js:2 — Defects 60%:/);
    assert.equal(text.split('\n').at(-1), `No blockers — ${RULE_NAMES.length} to check. Open each line and change it only if the problem is real.`);
  }
});

test('rounds progress across calls: same task continues the loop, a different task resets it, no progress and max rounds are reported', async () => {
  {
    const { stdout, stderr } = await runServer(
      [call(1, { task: 'A' }), call(2, { task: 'A' })],
      { JEV_STUB_PROB: '0.95' }
    );
    assert.deepEqual(extractTasks(stderr), ['A', 'A']);
    const text2 = extractResult(stdout, 2).content[0].text;
    assert.match(text2, /│\s*Round 1\s*│\s*Final\s*│/);
    assert.match(text2, /No real progress/);
  }
  {
    const { stdout, stderr } = await runServer(
      [call(1, { task: 'A' }), call(2, { task: 'B' }), call(3, { task: 'A' })],
      { JEV_STUB_PROB: '0.95' }
    );
    assert.deepEqual(extractTasks(stderr), ['A', 'B', 'A']);
    const text2 = extractResult(stdout, 2).content[0].text;
    assert.match(text2, /Round 1\/3/);
    assert.doesNotMatch(text2, /│\s*Round 1\s*│\s*Final\s*│/);
    assert.match(extractResult(stdout, 3).content[0].text, /│\s*Round 1\s*│\s*Final\s*│/);
  }
  {
    const { stdout } = await runServer(
      [call(1, { task: 'A' }), call(2, { task: 'A' })],
      { JEV_STUB_PROB: '0.05' }
    );
    const text1 = extractResult(stdout, 1).content[0].text;
    const text2 = extractResult(stdout, 2).content[0].text;
    assert.match(text1, /No findings — good to go\./);
    assert.match(text2, /No findings — good to go\./);
    assert.doesNotMatch(text2, /Round \d/);
  }
  {
    const roundProbs = JSON.stringify([
      [0.9, 0.9, 0.9, 0.9],
      [0.9, 0.05, 0.05, 0.05],
      [0.9, 0.05, 0.05, 0.05],
      [0.05, 0.05, 0.05, 0.05]
    ]);
    const { stdout } = await runServer(
      [call(1, { task: 'A' }), call(2, { task: 'A' }), call(3, { task: 'A' }), call(4, { task: 'A' })],
      { JEV_STUB_ROUND_PROBS: roundProbs }
    );
    const text3 = extractResult(stdout, 3).content[0].text;
    const text4 = extractResult(stdout, 4).content[0].text;
    assert.match(text3, /Max rounds reached/);
    assert.match(text4, /No findings — good to go\./);
    assert.doesNotMatch(text4, /Round \d/);
  }
});

test('missing answers fail the review instead of passing', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_MISSING: 'defect' });
  const result = extractResult(stdout, 1);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Jev returned no answer for: defect. Review not completed.');
  assert.doesNotMatch(result.content[0].text, /PASSED/);
});

test('project rules: an api rule is reported with its text and source file, web rules are never asked, and explicit cwd loads rules from outside the repo', async () => {
  {
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
  }
  {
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
  }
  {
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
      const table = extractResult(stdout, 1).content[0].text;
      for (const label of ['Addresses task', 'Unrelated changes', 'Missing requirements', 'Defects', 'Local rule', 'Project rules']) {
        assert.match(table, new RegExp(`│ ${label} +│`));
      }
      assert.doesNotMatch(table, /│ \w+_\w+/);
      for (const cwd of [undefined, path.join(outside, 'missing'), serverPath, 42]) {
        const result = await runServer([call(1, { task: 'A', cwd })], {}, outside);
        assert.equal(extractResult(result.stdout, 1).isError, undefined);
        assert.doesNotMatch(result.stderr, /agents_1|local_rule/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('decision log: a successful review appends only metadata, a log write failure does not fail the review, and a failed review creates no log', async () => {
  for (const [probability, verdict, tier] of [[0.05, 'clean', 'none'], [0.6, 'check', 'advise'], [0.95, 'block', 'block']]) {
    const dir = makeRepo('jev-decision-repo-');
    const stateDir = mkdtempSync(path.join(tmpdir(), 'jev-decisions-'));
    try {
      writeFileSync(path.join(dir, 'AGENTS.md'), 'Never log private customer records.\n');
      const { stdout } = await runServer(
        [call(1, { task: 'PRIVATE_TASK', cwd: dir }), call(2, { task: 'PRIVATE_TASK', cwd: dir })],
        { XDG_STATE_HOME: stateDir, JEV_STUB_PROB: String(probability) }
      );
      assert.equal(extractResult(stdout, 1).isError, undefined);
      assert.equal(extractResult(stdout, 2).isError, undefined);
      const raw = readFileSync(path.join(stateDir, 'jev-code-review', 'decisions.jsonl'), 'utf8');
      assert.ok(raw.endsWith('\n'));
      const records = raw.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(records.length, 2);
      for (const [index, record] of records.entries()) {
        assert.deepEqual(Object.keys(record).sort(), ['findings', 'repo', 'round', 'ts', 'verdict']);
        assert.equal(new Date(record.ts).toISOString(), record.ts);
        assert.equal(record.repo, path.basename(dir));
        assert.equal(record.round, verdict === 'block' ? index + 1 : 1);
        assert.equal(record.verdict, verdict);
        assert.deepEqual(record.findings.map((f) => f.rule), [...RULE_NAMES, 'agents_1']);
        for (const finding of record.findings) {
          assert.deepEqual(Object.keys(finding).sort(), ['file', 'line', 'probability', 'rule', 'tier']);
          assert.equal(finding.probability, probability);
          assert.equal(finding.tier, tier);
        }
        assert.deepEqual(record.findings.find((f) => f.rule === 'defect'), {
          rule: 'defect', probability, tier, file: 'a.js', line: 2
        });
        assert.equal(record.findings[0].file, null);
        assert.equal(record.findings[0].line, null);
      }
      assert.doesNotMatch(raw, /PRIVATE_TASK|const b|Never log private|violation|ruleText|"task"|"diff"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  for (const failure of ['directory creation', 'append']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'jev-decision-error-'));
    try {
      const logDir = path.join(dir, 'jev-code-review');
      if (failure === 'directory creation') writeFileSync(logDir, 'not a directory');
      else mkdirSync(path.join(logDir, 'decisions.jsonl'), { recursive: true });
      const { stdout } = await runServer([call(1, { task: 'A' })], { XDG_STATE_HOME: dir });
      const result = extractResult(stdout, 1);
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /No findings — good to go\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = mkdtempSync(path.join(tmpdir(), 'jev-decision-failed-'));
    try {
      const { stdout } = await runServer([call(1, { task: 'A' })], { XDG_STATE_HOME: dir, JEV_STUB_MISSING: 'defect' });
      assert.equal(extractResult(stdout, 1).isError, true);
      assert.equal(existsSync(path.join(dir, 'jev-code-review', 'decisions.jsonl')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
