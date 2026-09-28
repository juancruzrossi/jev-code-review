import './isolated-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeRepo } from './git-repo-fixture.mjs';

import plugin from '../.opencode/plugins/jev-code-review.mjs';

function stubFetch(probability) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const answers = {};
    for (const [key, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[key] = { noul: probability };
      if (q.type === 'choice') {
        const ids = Object.keys(q.criteria);
        const pick = ids[0];
        answers[key] = { choice: pick, probabilities: { [pick]: 0.9 } };
      }
    }
    return { ok: true, json: async () => ({ answers }) };
  };
}

test('tool.execute.after appends the finding text after a file change, and leaves output unchanged on a second call with no new change', async () => {
  const dir = makeRepo('jev-opencode-repo-');
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const originalKey = process.env.JEV_API_KEY;
  try {
    writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    globalThis.fetch = stubFetch(0.9);
    process.env.JEV_API_KEY = 'test';
    process.chdir(dir);

    const hooks = await plugin();
    const first = { output: 'original output' };
    await hooks['tool.execute.after']({ tool: 'edit', sessionID: 's2', args: {} }, first);
    assert.match(first.output, /original output/);
    assert.match(first.output, /Jev after edit:/);
    assert.match(first.output, /a\.js:2 — Defects 90%/);

    const second = { output: 'original output' };
    await hooks['tool.execute.after']({ tool: 'edit', sessionID: 's2', args: {} }, second);
    assert.equal(second.output, 'original output');
  } finally {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = originalKey;
  }
});
