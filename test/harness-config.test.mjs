import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Codex hooks use only the Codex plugin-root variable, Claude hooks use only the Claude plugin-root variable, and both register the same events', () => {
  assert.equal(JSON.parse(read('.codex-plugin/plugin.json')).hooks, './hooks/codex.json');
  const codexHooks = read('hooks/codex.json');
  assert.match(codexHooks, /\$\{PLUGIN_ROOT\}/);
  assert.doesNotMatch(codexHooks, /CLAUDE_PLUGIN_ROOT/);

  const claudeHooks = read('hooks/hooks.json');
  assert.match(claudeHooks, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.doesNotMatch(claudeHooks, /[^_]\$\{PLUGIN_ROOT\}/);

  const events = (path) => Object.keys(JSON.parse(read(path)).hooks).sort();
  assert.deepEqual(events('hooks/codex.json'), events('hooks/hooks.json'));
});
