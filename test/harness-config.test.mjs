import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Codex loads its own hooks file, which uses only the Codex plugin-root variable', () => {
  assert.equal(JSON.parse(read('.codex-plugin/plugin.json')).hooks, './hooks/codex.json');
  const codexHooks = read('hooks/codex.json');
  assert.match(codexHooks, /\$\{PLUGIN_ROOT\}/);
  assert.doesNotMatch(codexHooks, /CLAUDE_PLUGIN_ROOT/);
});

test('Claude Code hooks use only the Claude plugin-root variable', () => {
  const claudeHooks = read('hooks/hooks.json');
  assert.match(claudeHooks, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.doesNotMatch(claudeHooks, /[^_]\$\{PLUGIN_ROOT\}/);
});

test('both harnesses register the same hook events', () => {
  const events = (path) => Object.keys(JSON.parse(read(path)).hooks).sort();
  assert.deepEqual(events('hooks/codex.json'), events('hooks/hooks.json'));
});
