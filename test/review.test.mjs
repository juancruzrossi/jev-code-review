import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  tagDiff,
  buildQuestions,
  loadRepoRules,
  askJev,
  findings,
  formatWhere,
  readApiKey,
  changedFiles,
  filesToLint,
  lintAfterEdit,
  RULES,
  MAX_CHOICES,
  LINE_CONFIDENCE
} from '../review.mjs';
import { makeRepo } from './git-repo-fixture.mjs';

const TWO_FILE_DIFF = `diff --git a/a.js b/a.js
index 111..222 100644
--- a/a.js
+++ b/a.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
+const d = 4;
diff --git a/b.js b/b.js
index 333..444 100644
--- a/b.js
+++ b/b.js
@@ -5,2 +5,3 @@
 const e = 5;
+const f = 6;
`;

test('tagDiff maps IDs to the correct path and new-side line number', () => {
  const { lines } = tagDiff(TWO_FILE_DIFF);
  assert.deepEqual([...lines.keys()], ['L0001', 'L0002', 'L0003']);
  assert.deepEqual(lines.get('L0001'), { path: 'a.js', line: 2 });
  assert.deepEqual(lines.get('L0002'), { path: 'a.js', line: 4 });
  assert.deepEqual(lines.get('L0003'), { path: 'b.js', line: 6 });
});

test('buildQuestions emits one noul per rule and one choice per locating rule', () => {
  const lineIds = ['L0001', 'L0002'];
  const questions = buildQuestions(RULES, lineIds);
  for (const rule of RULES) {
    assert.equal(questions[rule.name].type, 'noul');
    if (rule.locate) {
      assert.equal(questions[`${rule.name}_line`].type, 'choice');
      assert.deepEqual(Object.keys(questions[`${rule.name}_line`].criteria), lineIds);
    } else {
      assert.equal(questions[`${rule.name}_line`], undefined);
    }
  }
});

test('loadRepoRules reads .jev/rules.json from a temp git root found from a subdirectory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, '.jev'));
    mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    writeFileSync(
      path.join(root, '.jev', 'rules.json'),
      JSON.stringify([{ name: 'no_console', rule: 'never call console.log' }])
    );
    const rules = loadRepoRules(path.join(root, 'src', 'nested'));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].name, 'no_console');
    assert.equal(rules[0].needsTask, false);
    assert.equal(rules[0].locate, true);
    assert.match(rules[0].violation, /never call console.log/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadRepoRules returns [] when .jev/rules.json is missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  try {
    mkdirSync(path.join(root, '.git'));
    assert.deepEqual(loadRepoRules(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadRepoRules throws on invalid JSON', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, '.jev'));
    writeFileSync(path.join(root, '.jev', 'rules.json'), '{ not json');
    assert.throws(() => loadRepoRules(root), /must be a JSON list/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function bigDiff(count) {
  const header = 'diff --git a/big.js b/big.js\nindex 111..222 100644\n--- a/big.js\n+++ b/big.js\n@@ -1,0 +1,' + count + ' @@\n';
  const body = Array.from({ length: count }, (_, i) => `+const v${i} = ${i};`).join('\n');
  return header + body + '\n';
}

test('more than 255 added lines splits requests, each choice at most 255 options, merged findings', async () => {
  const diff = bigDiff(300);
  const tagged = tagDiff(diff);
  assert.equal(tagged.lines.size, 300);

  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.questions);
    const answers = {};
    for (const [key, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[key] = { noul: key === 'defect' ? 0.9 : 0.1 };
      if (q.type === 'choice') {
        const ids = Object.keys(q.criteria);
        const pick = ids[0];
        answers[key] = { choice: pick, probabilities: { [pick]: 0.9 } };
      }
    }
    return { ok: true, json: async () => ({ answers }) };
  };

  const results = await askJev({ apiKey: 'k', state: { task: 't' }, rules: RULES, tagged, fetchImpl });
  assert.equal(results.length, 3);
  for (const call of calls) {
    if (call.defect_line) assert.ok(Object.keys(call.defect_line.criteria).length <= MAX_CHOICES);
  }

  const found = findings(results, RULES, tagged);
  const defect = found.find((f) => f.name === 'defect');
  assert.equal(defect.tier, 'fix');
  assert.ok(defect.where);
});

function bigDiffFile(name, count, startId) {
  const header = `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,0 +1,${count} @@\n`;
  const body = Array.from({ length: count }, (_, i) => `+const v${startId + i} = ${startId + i};`).join('\n');
  return header + body + '\n';
}

test('a split diff asks missing_requirement once, over the whole untagged diff', async () => {
  const diff = bigDiffFile('one.js', 200, 0) + bigDiffFile('two.js', 200, 200);
  const tagged = tagDiff(diff);
  assert.equal(tagged.lines.size, 400);

  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const answers = {};
    for (const [key, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[key] = { noul: 0.5 };
      if (q.type === 'choice') {
        const ids = Object.keys(q.criteria);
        answers[key] = { choice: ids[0], probabilities: { [ids[0]]: 0.9 } };
      }
    }
    return { ok: true, json: async () => ({ answers }) };
  };

  await askJev({ apiKey: 'k', state: { task: 't' }, rules: RULES, tagged, fetchImpl });

  const taskCalls = calls.filter((c) => c.questions.missing_requirement);
  assert.equal(taskCalls.length, 1);
  assert.equal(taskCalls[0].questions.missing_requirement_line, undefined);
  assert.match(taskCalls[0].state.diff, /one\.js/);
  assert.match(taskCalls[0].state.diff, /two\.js/);
  assert.match(taskCalls[0].state.diff, /v0 = 0/);
  assert.match(taskCalls[0].state.diff, /v399 = 399/);

  const chunkCalls = calls.filter((c) => !c.questions.missing_requirement);
  assert.equal(chunkCalls.length, 2);
  for (const c of chunkCalls) assert.equal(c.questions.missing_requirement, undefined);
});

test('formatWhere flags a line confidence below LINE_CONFIDENCE as uncertain', () => {
  const uncertain = { where: { path: 'a.js', line: 2 }, lineConfidence: LINE_CONFIDENCE - 0.01 };
  const confident = { where: { path: 'a.js', line: 2 }, lineConfidence: LINE_CONFIDENCE };
  const noLocation = { where: null, lineConfidence: null };
  assert.equal(formatWhere(uncertain), 'a.js:2 (line uncertain) — ');
  assert.equal(formatWhere(confident), 'a.js:2 — ');
  assert.equal(formatWhere(noLocation), '');
});

test('readApiKey reads JEV_API_KEY from ~/.env when Bun has no process.loadEnvFile', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'jev-home-'));
  const originalHome = process.env.HOME;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'JEV_API_KEY');
  const originalKey = process.env.JEV_API_KEY;
  const originalLoadEnvFile = process.loadEnvFile;
  try {
    delete process.env.JEV_API_KEY;
    process.env.HOME = home;
    delete process.loadEnvFile;

    writeFileSync(path.join(home, '.env'), 'JEV_API_KEY="abc"\n');
    assert.equal(readApiKey(), 'abc');

    writeFileSync(path.join(home, '.env'), 'export JEV_API_KEY="abc"\n');
    assert.equal(readApiKey(), 'abc');
  } finally {
    if (hadKey) process.env.JEV_API_KEY = originalKey;
    else delete process.env.JEV_API_KEY;
    process.env.HOME = originalHome;
    if (originalLoadEnvFile) process.loadEnvFile = originalLoadEnvFile;
    rmSync(home, { recursive: true, force: true });
  }
});

test('tier boundaries: 0.80 fix, 0.79 verify, 0.55 verify, 0.54 none', () => {
  const tagged = { lines: new Map() };
  const rules = [RULES[1]]; // missing_requirement: needsTask true, locate false
  const caseFor = (probability) => {
    const response = { answers: { missing_requirement: { noul: probability } } };
    const [f] = findings([{ response, rules }], rules, tagged);
    return f.tier;
  };
  assert.equal(caseFor(0.8), 'fix');
  assert.equal(caseFor(0.79), 'verify');
  assert.equal(caseFor(0.55), 'verify');
  assert.equal(caseFor(0.54), 'none');
});

test('changedFiles returns modified tracked and new untracked files, [] outside a git repo', async () => {
  const dir = makeRepo('jev-changed-');
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 2;\n');
    writeFileSync(path.join(dir, 'b.js'), 'const b = 1;\n');
    const files = await changedFiles(dir);
    assert.deepEqual(new Set(files), new Set(['a.js', 'b.js']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const outside = mkdtempSync(path.join(tmpdir(), 'jev-notgit-'));
  try {
    assert.deepEqual(await changedFiles(outside), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('filesToLint returns changed files once, then only re-edited files, per session', async () => {
  const dir = makeRepo('jev-tolint-');
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 2;\n');
    writeFileSync(path.join(dir, 'b.js'), 'const b = 1;\n');

    const first = await filesToLint({ cwd: dir, sessionId: 's1' });
    assert.deepEqual(new Set(first), new Set(['a.js', 'b.js']));

    const second = await filesToLint({ cwd: dir, sessionId: 's1' });
    assert.deepEqual(second, []);

    writeFileSync(path.join(dir, 'a.js'), 'const a = 3;\n');
    const third = await filesToLint({ cwd: dir, sessionId: 's1' });
    assert.deepEqual(third, ['a.js']);

    const otherSession = await filesToLint({ cwd: dir, sessionId: 's2' });
    assert.deepEqual(new Set(otherSession), new Set(['a.js', 'b.js']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lintAfterEdit returns '' and makes no fetch call when nothing changed", async () => {
  const dir = makeRepo('jev-nolint-');
  try {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { ok: true, json: async () => ({ answers: {} }) };
    };
    const result = await lintAfterEdit({ cwd: dir, sessionId: 'sX', apiKey: 'k', fetchImpl });
    assert.equal(result, '');
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
