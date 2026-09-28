#!/usr/bin/env node
// jev-code-review — context injected into the coding agent (not into Jev; see server.mjs
// for the staff-engineer standard Jev alone receives).
//
// FULL is injected at SessionStart, after compaction, and at SubagentStart.
// REMINDER is injected on every UserPromptSubmit.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { lintAfterEdit, readApiKey } from './review.mjs';

export const FIX_RULE =
  'fix only a concrete defect you can point to in your diff; never add validation, dependencies, or scope just to satisfy a vague weakness';

export const FULL = `Jev is a code-review model (via the \`jev-code-review\` MCP server) that asks small yes/no rules about a change and locates the line each one breaks. It solves the problem of a coding agent grading its own work.

Tool available: \`jev_review\` (task, diff, cwd?, files?, context?). Its text result has a ready-made box-drawing table, must-resolve and check sections, and a verdict line.

Mandatory rules:
- \`task\` is the user's request as given, the same in every round; \`diff\` is only the real diff of the change (e.g. \`git diff\`), no hand-written pseudo-diffs or changes outside it — describe those in \`context\` instead.
- After changing a project's source code that the user asked to change (not docs, prose, pure formatting, config, or throwaway/scratch scripts) and before answering, call \`jev_review\` with the task and the diff; always pass \`cwd\` = the agent's current working directory.
- Fix every must-resolve finding at its line, or explain in your answer why it is not a real problem. For a check finding, open the line and change it only if the problem is real. ${FIX_RULE}. Then call \`jev_review\` again with the same task, until it reports PASSED, no real progress, or 3 rounds; if you find no concrete defect, deliver.
- A subagent that edits code runs this loop itself before returning; a read-only subagent skips it.
- End your answer by pasting the tool's box-drawing table verbatim in a code block.`;

export const REMINDER = "Jev: if you changed a project's source code this turn, run jev_review before answering and paste its final table.";

async function main() {
  let data;
  try {
    data = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return; // Never block the user's prompt or session over a malformed hook payload.
  }
  const event = data.hook_event_name;
  try {
    if (event === 'PostToolUse') {
      const apiKey = readApiKey();
      if (!apiKey) return;
      const additionalContext = await lintAfterEdit({ cwd: data.cwd || process.cwd(), sessionId: data.session_id ?? '', apiKey });
      if (additionalContext) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
      }
      return;
    }
    const additionalContext = event === 'UserPromptSubmit' ? REMINDER : FULL;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
  } catch {
    // Never block the session over a hook failure.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
