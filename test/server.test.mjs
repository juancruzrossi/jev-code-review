import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

const FETCH_STUB = `
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  process.stderr.write('TASK:' + JSON.stringify(body.state.task) + '\\n');
  const answers = {};
  for (const key of Object.keys(body.questions)) {
    answers[key] = key.endsWith('_score') ? { type: 'score', score: 9 } : { type: 'choice', choice: 'no_material_issue' };
  }
  return { ok: true, json: async () => ({ answers }) };
};
`;

function runServer(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, serverPath],
      { env: { ...process.env, JEV_API_KEY: 'test' } }
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

function extractMarker(stdout, id) {
  const response = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((msg) => msg.id === id);
  const text = response.result.content[0].text;
  const match = /<!--\s*jev:previous\s+(.*?)\s*-->/s.exec(text);
  return JSON.parse(match[1]);
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
