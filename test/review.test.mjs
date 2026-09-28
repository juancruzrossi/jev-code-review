import './isolated-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  tagDiff,
  loadRepoRules,
  instructionFiles,
  extractRules,
  askJev,
  askInStages,
  findings,
  readApiKey,
  changedFiles,
  lintAfterEdit,
  RULES,
  MAX_CHOICES
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

test('tagDiff maps IDs to the correct path and new-side line number, and decodes real Git quoted paths as UTF-8', () => {
  const { lines } = tagDiff(TWO_FILE_DIFF);
  assert.deepEqual([...lines.keys()], ['L0001', 'L0002', 'L0003']);
  assert.deepEqual(lines.get('L0001'), { path: 'a.js', line: 2 });
  assert.deepEqual(lines.get('L0002'), { path: 'a.js', line: 4 });
  assert.deepEqual(lines.get('L0003'), { path: 'b.js', line: 6 });

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

test('instructionFiles returns root and api AGENTS*.md for a change under packages/api, never web or CLAUDE.md, and does not follow a symlink or an escaping path', () => {
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

    const outside = mkdtempSync(path.join(tmpdir(), 'jev-outside-'));
    try {
      writeFileSync(path.join(outside, 'secret.md'), 'Outside rule.');
      symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'packages', 'api', 'AGENTS.link.md'));
      const filesWithSymlink = instructionFiles(root, ['packages/api/x.ts']);
      assert.ok(!filesWithSymlink.some((f) => f.content === 'Outside rule.'));

      const escaping = instructionFiles(root, ['../outside/evil.ts']);
      assert.deepEqual(escaping, []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function cachePathFor(content) {
  const key = createHash('sha1').update(content).digest('hex');
  return path.join(tmpdir(), `jev-rules-${key}.json`);
}

test('extractRules reuses the content-hash cache on a second call, and returns [] and writes no cache when the request fails', async () => {
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

  const failingFile = { path: 'AGENTS.md', dir: '', content: 'Never call console.warn directly in this codebase.\n' };
  const failingCachePath = cachePathFor(failingFile.content);
  try {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const rules = await extractRules({ apiKey: 'k', file: failingFile, fetchImpl });
    assert.deepEqual(rules, []);
    assert.throws(() => readFileSync(failingCachePath, 'utf8'));
  } finally {
    rmSync(failingCachePath, { force: true });
  }
});

function bigDiff(count) {
  const header = 'diff --git a/big.js b/big.js\nindex 111..222 100644\n--- a/big.js\n+++ b/big.js\n@@ -1,0 +1,' + count + ' @@\n';
  const body = Array.from({ length: count }, (_, i) => `+const v${i} = ${i};`).join('\n');
  return header + body + '\n';
}

function bigDiffFile(name, count, startId) {
  const header = `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,0 +1,${count} @@\n`;
  const body = Array.from({ length: count }, (_, i) => `+const v${startId + i} = ${startId + i};`).join('\n');
  return header + body + '\n';
}

test('more than 255 added lines splits requests, each choice at most 255 options, merged findings, and project locations are chunked keeping the highest-confidence location', async () => {
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

  const rule = { name: 'agents_1', dir: '', source: 'AGENTS.md', locate: true, violation: 'Yes: v', clean: 'No: c' };
  const chunkedTagged = tagDiff(bigDiff(260));
  const widths = [];
  const chunkedResults = await askInStages({ apiKey: 'k', state: {}, rules: [rule], tagged: chunkedTagged,
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
  assert.deepEqual(findings(chunkedResults, [rule], chunkedTagged)[0].where, { path: 'big.js', line: 256 });
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

test('a failure leaves the previous review state intact and retries, whether an outage or a missing answer', async () => {
  for (const failure of ['outage', 'missing']) {
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
      assert.match(await lintAfterEdit(opts), /Defects 95%/);
      assert.equal(calls, 2);
      assert.equal(await lintAfterEdit(opts), '');
      assert.equal(calls, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
