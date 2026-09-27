import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

const RULE_NAMES = ['defect', 'missing_requirement', 'speculative_code', 'new_dependency', 'reinvents_existing', 'unrelated_change'];

const DIFF = `diff --git a/a.js b/a.js
index 111..222 100644
--- a/a.js
+++ b/a.js
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;

const FETCH_STUB = `
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  process.stderr.write('TASK:' + JSON.stringify(body.state.task) + '\\n');
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

function runServer(requests, extraEnv = {}) {
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

function extractMarkerLine(stdout, id) {
  const response = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((msg) => msg.id === id);
  const text = response.result.content[0].text;
  return /<!--\s*jev:previous\s+(.*?)\s*-->/s.exec(text)[0];
}

function extractMarker(stdout, id) {
  const match = /<!--\s*jev:previous\s+(.*?)\s*-->/s.exec(extractMarkerLine(stdout, id));
  return JSON.parse(match[1]);
}

function extractResult(stdout, id) {
  return stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((msg) => msg.id === id).result;
}

function marker(rounds, task) {
  return `<!-- jev:previous ${JSON.stringify({ rules: RULE_NAMES, rounds, task })} -->`;
}

test('round 1 sends its own task and the marker carries it and the rule names', async () => {
  const { stdout, stderr } = await runServer([call(1, { task: 'A' })]);
  assert.deepEqual(extractTasks(stderr), ['A']);
  const m = extractMarker(stdout, 1);
  assert.equal(m.task, 'A');
  assert.deepEqual(m.rules, RULE_NAMES);
});

test('round 2 reuses the round-1 task from previous', async () => {
  const previous = marker([[85, 85, 85, 85, 85, 85]], 'A');
  const { stdout, stderr } = await runServer([call(1, { task: 'B', previous })]);
  assert.deepEqual(extractTasks(stderr), ['A']);
  const m = extractMarker(stdout, 1);
  assert.equal(m.task, 'A');
  assert.equal(m.rounds.length, 2);
});

test('a task containing --> survives the marker into round 2', async () => {
  const task = 'Render <!-- note --> in the template';
  const { stdout } = await runServer([call(1, { task })]);
  const markerLine = extractMarkerLine(stdout, 1);
  const { stdout: stdout2, stderr: stderr2 } = await runServer([call(1, { task: 'B', previous: markerLine })]);
  assert.deepEqual(extractTasks(stderr2), [task]);
  assert.equal(extractMarker(stdout2, 1).rounds.length, 2);
});

test('a marker truncated without --> still continues the round and keeps the pinned task', async () => {
  const previous = `<!-- jev:previous ${JSON.stringify({ rules: RULE_NAMES, rounds: [[85, 85, 85, 85, 85, 85]], task: 'A' })}`;
  const { stdout, stderr } = await runServer([call(1, { task: 'B', previous })]);
  assert.deepEqual(extractTasks(stderr), ['A']);
  const m = extractMarker(stdout, 1);
  assert.equal(m.task, 'A');
  assert.equal(m.rounds.length, 2);
});

test('an unreadable previous errors instead of silently resetting, without calling Jev', async () => {
  const previous = 'garbage <!-- jev:previous {broken';
  const { stdout, stderr } = await runServer([call(1, { task: 'B', previous })]);
  const result = extractResult(stdout, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unchanged/);
  assert.deepEqual(extractTasks(stderr), []);
});

test('below the verify tier reports PASSED with no Fix or Verify section', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.05' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /PASSED — deliver\./);
  assert.doesNotMatch(text, /^Fix:/m);
  assert.doesNotMatch(text, /^Verify/m);
});

test('a Fix-tier finding is printed with its path:line and the verdict names round 1', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.85' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /^Fix:/m);
  assert.match(text, /- a\.js:2 — defect 85%:/);
  assert.match(text, /Round 1\/3/);
});

test('a Verify-tier finding prints the Verify section', async () => {
  const { stdout } = await runServer([call(1, { task: 'A' })], { JEV_STUB_PROB: '0.6' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /^Verify — open the line/m);
  assert.match(text, /- a\.js:2 — defect 60%:/);
});

test('a Fix count that does not drop reports no real progress', async () => {
  const previous = marker([[85, 85, 85, 85, 85, 85]], 'A');
  const { stdout } = await runServer([call(1, { task: 'A', previous })], { JEV_STUB_PROB: '0.85' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /No real progress/);
});

test('a dropping Fix count reports the next round', async () => {
  const previous = marker([[85, 85, 85, 85, 85, 85]], 'A');
  const { stdout } = await runServer([call(1, { task: 'A', previous })], { JEV_STUB_PROB: '0.05' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /PASSED — deliver\./);
});

test('round 3 reports max rounds reached regardless of progress', async () => {
  const previous = marker([[85, 85, 85, 85, 85, 85], [85, 85, 85, 85, 85, 85]], 'A');
  const { stdout } = await runServer([call(1, { task: 'A', previous })], { JEV_STUB_PROB: '0.85' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /Max rounds reached/);
});
