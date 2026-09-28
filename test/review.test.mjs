import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  tagDiff,
  buildQuestions,
  loadRepoRules,
  instructionFiles,
  extractRules,
  projectRules,
  askJev,
  askInStages,
  findings,
  findingLine,
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

test('projectRules returns [] for an empty AGENTS.md, without calling fetch', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  const cachePath = cachePathFor('');
  try {
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'AGENTS.md'), '');
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { ok: true, json: async () => ({ answers: {} }) };
    };
    const rules = await projectRules({ apiKey: 'k', root, changedPaths: ['x.js'], fetchImpl });
    assert.deepEqual(rules, []);
    assert.equal(called, false);
  } finally {
    rmSync(cachePath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('instructionFiles skips an unreadable AGENTS.md instead of throwing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  try {
    mkdirSync(path.join(root, '.git'));
    const blocked = path.join(root, 'AGENTS.md');
    writeFileSync(blocked, 'Never call console.log directly.');
    chmodSync(blocked, 0o000);
    try {
      assert.doesNotThrow(() => instructionFiles(root, ['x.js']));
      const files = instructionFiles(root, ['x.js']);
      assert.deepEqual(files, []);
    } finally {
      chmodSync(blocked, 0o644);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function cachePathFor(content) {
  const key = createHash('sha1').update(content).digest('hex');
  return path.join(tmpdir(), `jev-rules-${key}.json`);
}

test('extractRules keeps candidate lines at or above 0.5 probability and drops the rest', async () => {
  const file = { path: 'AGENTS.md', dir: '', content: 'Never call console.log directly in this codebase.\nThis file describes our team process.\n' };
  const cachePath = cachePathFor(file.content);
  try {
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { noul: key === 'line_1' ? 0.9 : 0.1 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const rules = await extractRules({ apiKey: 'k', file, fetchImpl });
    assert.deepEqual(rules, ['Never call console.log directly in this codebase.']);
  } finally {
    rmSync(cachePath, { force: true });
  }
});

test('extractRules reuses the content-hash cache on a second call, without calling fetch again', async () => {
  const file = { path: 'AGENTS.md', dir: '', content: 'Never call console.log directly in this codebase.\n' };
  const cachePath = cachePathFor(file.content);
  try {
    let calls = 0;
    const fetchImpl = async (url, opts) => {
      calls += 1;
      const body = JSON.parse(opts.body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { noul: 0.9 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const first = await extractRules({ apiKey: 'k', file, fetchImpl });
    const second = await extractRules({ apiKey: 'k', file, fetchImpl });
    assert.deepEqual(first, second);
    assert.equal(calls, 1);
  } finally {
    rmSync(cachePath, { force: true });
  }
});

test('extractRules returns [] and writes no cache when the request fails', async () => {
  const file = { path: 'AGENTS.md', dir: '', content: 'Never call console.log directly in this codebase.\n' };
  const cachePath = cachePathFor(file.content);
  try {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const rules = await extractRules({ apiKey: 'k', file, fetchImpl });
    assert.deepEqual(rules, []);
    assert.throws(() => readFileSync(cachePath, 'utf8'));
  } finally {
    rmSync(cachePath, { force: true });
  }
});

test('projectRules turns each extracted line into a locate rule named for its position, with dir and source', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-repo-'));
  const cachePaths = [];
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'packages', 'api'), { recursive: true });
    writeFileSync(path.join(root, 'packages', 'api', 'AGENTS.md'), 'Never call console.log directly in this codebase.\n');
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      cachePaths.push(cachePathFor(readFileSync(path.join(root, 'packages', 'api', 'AGENTS.md'), 'utf8')));
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { noul: 0.9 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const rules = await projectRules({ apiKey: 'k', root, changedPaths: ['packages/api/x.js'], fetchImpl });
    assert.equal(rules.length, 1);
    assert.equal(rules[0].name, 'agents_1');
    assert.equal(rules[0].dir, 'packages/api');
    assert.equal(rules[0].source, 'packages/api/AGENTS.md');
    assert.equal(rules[0].ruleText, 'Never call console.log directly in this codebase.');
    assert.equal(rules[0].locate, true);
  } finally {
    for (const p of cachePaths) rmSync(p, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectRules returns [] when root is not a valid git root', async () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'jev-noroot-'));
  try {
    const rules = await projectRules({ apiKey: 'k', root: path.join(outside, 'missing'), changedPaths: ['x.js'], fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {} }) }) });
    assert.deepEqual(rules, []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('findingLine prints the rule text and source for a project rule, and name plus violation for a built-in rule', () => {
  const projectFinding = {
    probability: 0.95,
    where: { path: 'packages/api/x.js', line: 3 },
    lineConfidence: 0.9,
    ruleText: 'Never call console.log directly in this codebase.',
    source: 'packages/api/AGENTS.md'
  };
  assert.equal(
    findingLine(projectFinding),
    '- packages/api/x.js:3 — "Never call console.log directly in this codebase." (packages/api/AGENTS.md) 95%'
  );

  const builtIn = { probability: 0.9, where: { path: 'a.js', line: 2 }, lineConfidence: 0.9, name: 'defect', violation: 'a bug' };
  assert.equal(findingLine(builtIn), '- a.js:2 — defect 90%: a bug');
});

test('askInStages skips the locate stage when no project rule reaches the advisory tier', async () => {
  const tagged = tagDiff('diff --git a/x.js b/x.js\nindex 1..2 100644\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,2 @@\n a\n+b\n');
  const projectRule = {
    name: 'agents_1',
    needsTask: false,
    locate: true,
    dir: '',
    source: 'AGENTS.md',
    ruleText: 'r',
    ask: 'q?',
    violation: 'Yes: v',
    clean: 'No: c'
  };
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls += 1;
    const body = JSON.parse(opts.body);
    const answers = {};
    for (const key of Object.keys(body.questions)) answers[key] = { noul: 0.05 };
    return { ok: true, json: async () => ({ answers }) };
  };
  const results = await askInStages({ apiKey: 'k', state: { task: 't' }, rules: [projectRule], tagged, fetchImpl });
  assert.equal(calls, 1);
  const found = findings(results, [projectRule], tagged);
  assert.equal(found[0].tier, 'none');
});

test('askInStages asks the locate question only for an elevated project rule, scoped to its own lines', async () => {
  const diff = `diff --git a/api/x.js b/api/x.js
index 1..2 100644
--- a/api/x.js
+++ b/api/x.js
@@ -1,1 +1,2 @@
 a
+console.log(1);
diff --git a/web/y.js b/web/y.js
index 1..2 100644
--- a/web/y.js
+++ b/web/y.js
@@ -1,1 +1,2 @@
 a
+const y = 1;
`;
  const tagged = tagDiff(diff);
  const apiRule = {
    name: 'agents_1',
    needsTask: false,
    locate: true,
    dir: 'api',
    source: 'api/AGENTS.md',
    ruleText: 'no console.log',
    ask: 'q?',
    violation: 'Yes: v',
    clean: 'No: c'
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.questions);
    const answers = {};
    for (const [key, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[key] = { noul: 0.95 };
      if (q.type === 'choice') {
        const ids = Object.keys(q.criteria);
        answers[key] = { choice: ids[0], probabilities: { [ids[0]]: 0.9 } };
      }
    }
    return { ok: true, json: async () => ({ answers }) };
  };
  const results = await askInStages({ apiKey: 'k', state: { task: 't' }, rules: [apiRule], tagged, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].agents_1_line, undefined);
  assert.deepEqual(Object.keys(calls[1].agents_1_line.criteria), ['L0001']);

  const found = findings(results, [apiRule], tagged);
  assert.equal(found[0].tier, 'block');
  assert.deepEqual(found[0].where, { path: 'api/x.js', line: 2 });
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

test('filesToLint returns files until a successful review, then only re-edits, per session', async () => {
  const dir = makeRepo('jev-tolint-');
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 2;\n');
    writeFileSync(path.join(dir, 'b.js'), 'const b = 1;\n');

    const first = await filesToLint({ cwd: dir, sessionId: 's1' });
    assert.deepEqual(new Set(first), new Set(['a.js', 'b.js']));

    assert.deepEqual(new Set(await filesToLint({ cwd: dir, sessionId: 's1' })), new Set(first));
    await lintAfterEdit({ cwd: dir, sessionId: 's1', apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { defect: { noul: 0 } } }) }) });
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


test('findings rejects a missing answer in any response, including a partial chunk', () => {
  const rule = RULES.find((r) => r.name === 'defect');
  for (const noul of [undefined, '0', null, NaN, Infinity]) {
    assert.throws(() => findings([
      { response: { answers: { defect: { noul: 0 } } }, rules: [rule] },
      { response: { answers: { defect: { noul } } }, rules: [rule] }
    ], [rule], tagDiff(TWO_FILE_DIFF)), /Jev returned no answer for: defect. Review not completed./);
  }
});


test('project rule questions see only their directory and skip untouched directories', async () => {
  const rule = { name: 'agents_1', dir: 'bridge', source: 'bridge/AGENTS.md', locate: true, violation: 'Yes: v', clean: 'No: c' };
  for (const includeBridge of [false, true]) {
    const tagged = tagDiff((includeBridge ? bigDiffFile('bridge/a.js', 1, 0) : '') + bigDiffFile('tools/b.js', 1, 1));
    const calls = [];
    const results = await askInStages({ apiKey: 'k', state: {}, rules: [...RULES, rule, { ...rule, name: 'agents_2' }], tagged,
      fetchImpl: async (_, opts) => {
        const body = JSON.parse(opts.body);
        calls.push(body);
        const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]) => [name, q.type === 'noul' ? { noul: 0 } : { choice: Object.keys(q.criteria)[0] }]));
        return { ok: true, json: async () => ({ answers }) };
      }
    });
    const scoped = calls.filter((body) => body.questions.agents_1);
    assert.equal(scoped.length, includeBridge ? 1 : 0);
    if (includeBridge) {
      assert.match(scoped[0].state.diff, /bridge\/a.js/);
      assert.doesNotMatch(scoped[0].state.diff, /tools\/|v1 = 1/);
      assert.ok(scoped[0].questions.agents_2);
    }
    assert.match(calls.find((body) => body.questions.defect).state.diff, /tools\/b.js/);
    assert.doesNotThrow(() => findings(results, [...RULES, rule, { ...rule, name: 'agents_2' }], tagged));
  }
});

test('project locations are chunked and keep the highest-confidence location', async () => {
  const rule = { name: 'agents_1', dir: '', source: 'AGENTS.md', locate: true, violation: 'Yes: v', clean: 'No: c' };
  const tagged = tagDiff(bigDiff(260));
  const widths = [];
  const results = await askInStages({ apiKey: 'k', state: {}, rules: [rule], tagged,
    fetchImpl: async (_, opts) => {
      const body = JSON.parse(opts.body);
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === 'noul') answers[name] = { noul: 0.99 };
        else {
          const ids = Object.keys(q.criteria);
          widths.push(ids.length);
          answers[name] = { choice: ids[0], confidence: widths.length === 1 ? 0.5 : 0.95 };
        }
      }
      return { ok: true, json: async () => ({ answers }) };
    }
  });
  assert.deepEqual(widths, [255, 5]);
  assert.deepEqual(findings(results, [rule], tagged)[0].where, { path: 'big.js', line: 256 });
});


test('per-edit requests exclude untracked secret names while retaining tracked files', async () => {
  const dir = makeRepo('jev-secrets-');
  try {
    writeFileSync(path.join(dir, '.env.tracked'), 'tracked before\n');
    execFileSync('git', ['-C', dir, 'add', '.env.tracked']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'track fixture']);
    writeFileSync(path.join(dir, '.env.tracked'), 'tracked after\n');
    mkdirSync(path.join(dir, 'nested'));
    for (const name of ['.env', '.env.local', 'cert.pem', 'private.key', 'id_rsa', 'id_rsa.pub', 'café.pem', 'tab\t.key']) {
      writeFileSync(path.join(dir, name), 'SYNTHETIC_SECRET\n');
      writeFileSync(path.join(dir, 'nested', name), 'SYNTHETIC_SECRET\n');
    }
    writeFileSync(path.join(dir, 'safe.js'), 'const safe = 1;\n');
    assert.deepEqual(new Set(await changedFiles(dir)), new Set(['.env.tracked', 'safe.js']));
    const requests = [];
    await lintAfterEdit({ cwd: dir, sessionId: 'secrets', apiKey: 'k', fetchImpl: async (_, opts) => {
      requests.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ answers: { defect: { noul: 0 } } }) };
    } });
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(requests), /SYNTHETIC_SECRET/);
    assert.match(requests[0].state.diff, /tracked after/);
    assert.match(requests[0].state.diff, /const safe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const failure of ['outage', 'missing']) {
  test(`a ${failure} failure leaves the previous review state intact and retries`, async () => {
    const dir = makeRepo('jev-retry-');
    try {
      writeFileSync(path.join(dir, 'a.js'), 'const a = 2;\n');
      let calls = 0;
      const opts = { cwd: dir, sessionId: failure, apiKey: 'k', fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          if (failure === 'outage') throw new Error('outage');
          return { ok: true, json: async () => ({ answers: {} }) };
        }
        return { ok: true, json: async () => ({ answers: { defect: { noul: 0.95 } } }) };
      } };
      assert.equal(await lintAfterEdit(opts), '');
      assert.match(await lintAfterEdit(opts), /defect 95%/);
      assert.equal(calls, 2);
      assert.equal(await lintAfterEdit(opts), '');
      assert.equal(calls, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('tagDiff decodes real Git quoted paths as UTF-8 and preserves escaped characters', () => {
  const dir = makeRepo('jev-unicode-');
  const names = ['café.js', 'quote"slash\\tab\t.js'];
  try {
    for (const name of names) writeFileSync(path.join(dir, name), 'const n = 1;\n');
    execFileSync('git', ['-C', dir, 'add', '--', ...names]);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'quoted paths']);
    for (const name of names) writeFileSync(path.join(dir, name), 'const n = 2;\n');
    const diff = execFileSync('git', ['-C', dir, '-c', 'core.quotePath=true', 'diff'], { encoding: 'utf8' });
    const tagged = tagDiff(diff);
    assert.deepEqual(new Set([...tagged.lines.values()].map((info) => info.path)), new Set(names));
    assert.ok([...tagged.lines.values()].every((info) => info.line === 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
