import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  tagDiff,
  buildQuestions,
  loadRepoRules,
  loadProjectInstructions,
  instructionFiles,
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

test('RULES names are exactly the task-alignment set plus missing_requirement and defect', () => {
  assert.deepEqual(RULES.map((r) => r.name), ['addresses_task', 'unrelated_change', 'needs_clarification', 'missing_requirement', 'defect']);
});

test('each built-in rule asks its own question', () => {
  const questions = buildQuestions(RULES, ['L0001']);
  for (const rule of RULES) {
    assert.equal(typeof rule.ask, 'string');
    assert.equal(questions[rule.name].instructions, rule.ask);
  }
});

test('finding text drops the answer prefix of the rule criterion', () => {
  const rules = [RULES.find((r) => r.name === 'defect')];
  const response = { answers: { defect: { noul: 0.9 } } };
  const [finding] = findings([{ response, rules }], rules, { lines: new Map() });
  assert.doesNotMatch(finding.violation, /^Yes:/);
  assert.match(finding.violation, /^for some input/);
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

test('loadProjectInstructions joins AGENTS.md and CLAUDE.md with a header line per file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  try {
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'AGENTS.md'), 'Never call console.log.');
    writeFileSync(path.join(root, 'CLAUDE.md'), 'Money amounts are integers in cents.');
    const text = loadProjectInstructions(root);
    assert.match(text, /# AGENTS\.md/);
    assert.match(text, /Never call console\.log\./);
    assert.match(text, /# CLAUDE\.md/);
    assert.match(text, /Money amounts are integers in cents\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadProjectInstructions returns null when neither file exists', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  try {
    mkdirSync(path.join(root, '.git'));
    assert.equal(loadProjectInstructions(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadProjectInstructions caps the joined text at 6000 characters', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  try {
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(4000));
    writeFileSync(path.join(root, 'CLAUDE.md'), 'b'.repeat(4000));
    const text = loadProjectInstructions(root);
    assert.equal(text.length, 6000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeMonorepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-monorepo-'));
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'packages', 'api'), { recursive: true });
  mkdirSync(path.join(root, 'packages', 'web'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), 'Root rule.');
  writeFileSync(path.join(root, 'CLAUDE.md'), 'Never read this.');
  writeFileSync(path.join(root, 'packages', 'api', 'AGENTS.md'), 'API rule.');
  writeFileSync(path.join(root, 'packages', 'api', 'AGENTS.local.md'), 'API local rule.');
  writeFileSync(path.join(root, 'packages', 'web', 'AGENTS.md'), 'Web rule.');
  return root;
}

test('instructionFiles returns root and api AGENTS*.md for a change under packages/api, never web or CLAUDE.md', () => {
  const root = makeMonorepo();
  try {
    const files = instructionFiles(root, ['packages/api/x.ts']);
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['AGENTS.md', 'packages/api/AGENTS.local.md', 'packages/api/AGENTS.md'].sort());
    assert.ok(!paths.includes('packages/web/AGENTS.md'));
    assert.ok(!paths.some((p) => p.includes('CLAUDE.md')));
    const apiFile = files.find((f) => f.path === 'packages/api/AGENTS.md');
    assert.equal(apiFile.dir, 'packages/api');
    assert.equal(apiFile.content, 'API rule.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('instructionFiles returns only the root file for a change at the root', () => {
  const root = makeMonorepo();
  try {
    const files = instructionFiles(root, ['x.ts']);
    assert.deepEqual(files.map((f) => f.path), ['AGENTS.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('instructionFiles returns [] for no changed paths', () => {
  const root = makeMonorepo();
  try {
    assert.deepEqual(instructionFiles(root, []), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('instructionFiles does not follow a symlinked AGENTS.md or a path escaping root', () => {
  const root = makeMonorepo();
  try {
    const outside = mkdtempSync(path.join(tmpdir(), 'jev-outside-'));
    try {
      writeFileSync(path.join(outside, 'secret.md'), 'Outside rule.');
      symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'packages', 'api', 'AGENTS.link.md'));
      const files = instructionFiles(root, ['packages/api/x.ts']);
      assert.ok(!files.some((f) => f.content === 'Outside rule.'));

      const escaping = instructionFiles(root, ['../outside/evil.ts']);
      assert.deepEqual(escaping, []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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
  assert.equal(defect.tier, 'block');
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

test('tier boundaries: 0.90 block, 0.89 advise, 0.55 advise, 0.54 none', () => {
  const tagged = { lines: new Map() };
  const rules = [RULES.find((r) => r.name === 'missing_requirement')];
  const caseFor = (probability) => {
    const response = { answers: { missing_requirement: { noul: probability } } };
    const [f] = findings([{ response, rules }], rules, tagged);
    return f.tier;
  };
  assert.equal(caseFor(0.9), 'block');
  assert.equal(caseFor(0.89), 'advise');
  assert.equal(caseFor(0.55), 'advise');
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

test('changedFiles returns paths relative to cwd, for both a modified tracked file and a new untracked file, when cwd is a subdirectory of the repo', async () => {
  const dir = makeRepo('jev-subdir-');
  try {
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'tracked.js'), 'const t = 1;\n');
    execFileSync('git', ['-C', dir, 'add', 'src/tracked.js']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'add tracked.js']);
    writeFileSync(path.join(dir, 'src', 'tracked.js'), 'const t = 2;\n');
    writeFileSync(path.join(dir, 'src', 'untracked.js'), 'const u = 1;\n');

    const files = await changedFiles(path.join(dir, 'src'));
    assert.deepEqual(new Set(files), new Set(['tracked.js', 'untracked.js']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
