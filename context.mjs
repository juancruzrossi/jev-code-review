#!/usr/bin/env node
// jev-code-review — context injected into the coding agent (not into Jev; see server.mjs
// for the staff-engineer standard Jev alone receives).
//
// FULL is injected at SessionStart, after compaction, and at SubagentStart.
// REMINDER is injected on every UserPromptSubmit.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FULL = `Jev is a code-review model (via the \`jev-code-review\` MCP server) that scores a change against a staff-engineer standard. It solves the problem of a coding agent grading its own work.

Tool available: \`jev_review\` (task, diff, files?, context?, previous?). Its text result has a ready-made box-drawing table, a verdict line, and a final \`<!-- jev:previous ... -->\` marker line (bookkeeping only, never show it to the user).

Mandatory rules:
- After changing code in a turn (not docs, prose, or pure formatting) and before answering, call \`jev_review\` with the task and the diff.
- If any dimension fails, fix it and call \`jev_review\` again, passing the previous result's \`<!-- jev:previous ... -->\` marker line unchanged as \`previous\`, until it reports PASSED or 3 rounds are reached.
- A subagent that edits code runs this loop itself before returning; a read-only subagent skips it.
- End your answer by pasting the tool's box-drawing table verbatim in a code block (omit the \`jev:previous\` marker line — that one is only for your next tool call, never for the user).`;

export const REMINDER = 'Jev: if you change code this turn, run jev_review before answering and paste its final table.';

function main() {
  try {
    const data = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const event = data.hook_event_name;
    const additionalContext = event === 'UserPromptSubmit' ? REMINDER : FULL;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
  } catch {
    // Never block the user's prompt or session over a malformed hook payload.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
