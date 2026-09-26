import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

const FETCH_STUB = `
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  process.stderr.write('TASK:' + JSON.stringify(body.state.task) + '\\n');
  const score = Number(process.env.JEV_STUB_SCORE ?? 9);
  const answers = {};
  for (const key of Object.keys(body.questions)) {
    answers[key] = key.endsWith('_score') ? { type: 'score', score } : { type: 'choice', choice: 'no_material_issue' };
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
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'jev_review', arguments: args } };
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

test('round 1 sends its own task and the marker carries it', async () => {
  const { stdout, stderr } = await runServer([call(1, { task: 'A', diff: 'd' })]);
  assert.deepEqual(extractTasks(stderr), ['A']);
  assert.equal(extractMarker(stdout, 1).task, 'A');
});

test('round 2 reuses the round-1 task from previous', async () => {
  const previous = `<!-- jev:previous ${JSON.stringify({ rounds: [[9, 9, 9, 9, 9, 9]], task: 'A' })} -->`;
  const { stdout, stderr } = await runServer([call(1, { task: 'B', diff: 'd', previous })]);
  assert.deepEqual(extractTasks(stderr), ['A']);
  const marker = extractMarker(stdout, 1);
  assert.equal(marker.task, 'A');
  assert.equal(marker.rounds.length, 2);
});

test('an old marker without task falls back to the current call task', async () => {
  const previous = `<!-- jev:previous ${JSON.stringify({ rounds: [[9, 9, 9, 9, 9, 9]] })} -->`;
  const { stdout, stderr } = await runServer([call(1, { task: 'C', diff: 'd', previous })]);
  assert.deepEqual(extractTasks(stderr), ['C']);
});

test('a task containing --> survives the marker into round 2', async () => {
  const task = 'Render <!-- note --> in the template';
  const { stdout } = await runServer([call(1, { task, diff: 'd' })]);
  const marker = extractMarkerLine(stdout, 1);
  const { stdout: stdout2, stderr: stderr2 } = await runServer([call(1, { task: 'B', diff: 'd', previous: marker })]);
  assert.deepEqual(extractTasks(stderr2), [task]);
  assert.equal(extractMarker(stdout2, 1).rounds.length, 2);
});

test('a marker truncated without --> still continues the round and keeps the pinned task', async () => {
  const previous = `<!-- jev:previous ${JSON.stringify({ rounds: [[9, 9, 9, 9, 9, 9]], task: 'A' })}`;
  const { stdout, stderr } = await runServer([call(1, { task: 'B', diff: 'd', previous })]);
  assert.deepEqual(extractTasks(stderr), ['A']);
  const marker = extractMarker(stdout, 1);
  assert.equal(marker.task, 'A');
  assert.equal(marker.rounds.length, 2);
});

test('an unreadable previous errors instead of silently resetting, without calling Jev', async () => {
  const previous = 'garbage <!-- jev:previous {broken';
  const { stdout, stderr } = await runServer([call(1, { task: 'B', diff: 'd', previous })]);
  const result = extractResult(stdout, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unchanged/);
  assert.deepEqual(extractTasks(stderr), []);
});

test('a small score gain reports no real progress', async () => {
  const previous = `<!-- jev:previous ${JSON.stringify({ rounds: [[7, 7, 7, 7, 7, 7]], task: 'A' })} -->`;
  const { stdout } = await runServer([call(1, { task: 'A', diff: 'd', previous })], { JEV_STUB_SCORE: '6.1' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /No real progress/);
});

test('a real score gain reports the next round', async () => {
  const previous = `<!-- jev:previous ${JSON.stringify({ rounds: [[7, 7, 7, 7, 7, 7]], task: 'A' })} -->`;
  const { stdout } = await runServer([call(1, { task: 'A', diff: 'd', previous })], { JEV_STUB_SCORE: '6.4' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /Round 2\/3/);
});

test('round 3 reports max rounds reached regardless of progress', async () => {
  const previous = `<!-- jev:previous ${JSON.stringify({ rounds: [[7, 7, 7, 7, 7, 7], [7.1, 7.1, 7.1, 7.1, 7.1, 7.1]], task: 'A' })} -->`;
  const { stdout } = await runServer([call(1, { task: 'A', diff: 'd', previous })], { JEV_STUB_SCORE: '6.1' });
  const text = extractResult(stdout, 1).content[0].text;
  assert.match(text, /Max rounds reached/);
});
