#!/usr/bin/env node
// jev-code-review — dependency-free MCP server exposing one tool, `jev_review`, that asks
// the Jev API (https://api.typesafe.ai) small yes/no rules about a code change and
// locates the line each one breaks, returning findings in Fix and Verify tiers.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout,
// with zero runtime dependencies.

import readline from 'node:readline';
import { MARKER_HINT, MARKER_TAG } from './context.mjs';
import { RULES, FIX_TIER, tagDiff, loadRepoRules, askJev, findings, formatWhere, readApiKey } from './review.mjs';

const MAX_ROUNDS = 3;
const DELIVER = 'deliver with your own judgment.';
const MARKER_PATTERN = new RegExp(`${MARKER_TAG}\\s*(\\{.*\\})`, 's');

function padCenter(text, width) {
  const left = Math.floor((width - text.length) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left);
}

function padLeftAlign(text, width) {
  return ' ' + text + ' '.repeat(width - 1 - text.length);
}

// Final is the last round. ✓/✗ instead of emoji: emoji width varies by
// terminal font and would misalign the right border.
function renderTable(ruleNames, rounds) {
  const finals = rounds[rounds.length - 1];
  const headers = ['Rule', ...rounds.slice(0, -1).map((_, i) => `Round ${i + 1}`), 'Final'];
  const rows = ruleNames.map((name, row) => [
    name,
    ...rounds.slice(0, -1).map((round) => `${round[row]}%`),
    `${finals[row]}% ${finals[row] / 100 < FIX_TIER ? '✓' : '✗'}`
  ]);

  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map((row) => row[col].length)) + 2);

  const border = (left, mid, right) => left + widths.map((w) => '─'.repeat(w)).join(mid) + right;
  const headerLine = '│' + headers.map((h, i) => padCenter(h, widths[i])).join('│') + '│';
  const dataLines = rows.map((row) => '│' + row.map((cell, i) => padLeftAlign(cell, widths[i])).join('│') + '│');

  return [
    border('┌', '┬', '┐'),
    headerLine,
    border('├', '┼', '┤'),
    ...dataLines,
    border('└', '┴', '┘')
  ].join('\n');
}

function findingLine(finding) {
  const percent = Math.round(finding.probability * 100);
  return `- ${formatWhere(finding)}${finding.name} ${percent}%: ${finding.violation}`;
}

function verdictLine(round, fixFindings, noProgress) {
  if (fixFindings.length === 0) return 'PASSED — deliver.';
  if (noProgress) return `No real progress since the last round — ${DELIVER}`;
  if (round < MAX_ROUNDS) {
    return `Round ${round}/${MAX_ROUNDS} — fix the Fix items at those lines, then call jev_review again with previous.`;
  }
  return `Max rounds reached — ${DELIVER}`;
}

async function runReview(args) {
  const { task, diff, files, context, previous } = args || {};
  if (!task || typeof task !== 'string') throw new Error('jev_review requires a non-empty "task" string.');
  if (!diff || typeof diff !== 'string') throw new Error('jev_review requires a non-empty "diff" string.');

  const apiKey = readApiKey();
  if (!apiKey) {
    throw new Error('JEV_API_KEY is not set (checked process.env and ~/.env).');
  }

  const prior = parsePrevious(previous);
  const pinnedTask = prior.task || task;

  const rules = [...RULES, ...loadRepoRules(process.cwd())];
  const ruleNames = rules.map((r) => r.name);

  const state = { task: pinnedTask };
  if (Array.isArray(files) && files.length > 0) state.files = files;
  if (context) state.context = context;

  const tagged = tagDiff(diff);
  const results = await askJev({ apiKey, state, rules, tagged });
  const found = findings(results, rules, tagged);

  const samePriorRules = prior.rules && prior.rules.length === ruleNames.length && prior.rules.every((n, i) => n === ruleNames[i]);
  const currentPercents = found.map((f) => Math.round(f.probability * 100));
  const priorRounds = samePriorRules ? prior.rounds : [];
  const rounds = [...priorRounds, currentPercents];
  const round = prior.rounds.length + 1;

  const fixFindings = found.filter((f) => f.tier === 'fix');
  const verifyFindings = found.filter((f) => f.tier === 'verify');

  const previousRound = samePriorRules ? prior.rounds[prior.rounds.length - 1] : null;
  const previousFixCount = previousRound ? previousRound.filter((p) => p / 100 >= FIX_TIER).length : null;
  const hasProgress = previousRound ? fixFindings.length < previousFixCount : true;
  const noProgress = round >= 2 && fixFindings.length > 0 && round < MAX_ROUNDS && !hasProgress;

  const lines = [renderTable(ruleNames, rounds), ''];
  if (fixFindings.length > 0) {
    lines.push('Fix:');
    for (const f of fixFindings) lines.push(findingLine(f));
    lines.push('');
  }
  if (verifyFindings.length > 0) {
    lines.push('Verify — open the line and confirm; change it only if the problem is real:');
    for (const f of verifyFindings) lines.push(findingLine(f));
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('');
  lines.push(verdictLine(round, fixFindings, noProgress));
  // Bookkeeping for the next call's `previous`, appended to the same text the
  // model already reads (Claude Code's client drops `content` text whenever
  // `structuredContent` is also present, so round state travels inline instead).
  lines.push(`<!-- ${MARKER_TAG} ${JSON.stringify({ rules: ruleNames, rounds, task: pinnedTask }).replaceAll('>', '\\u003e')} -->`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function parsePrevious(previous) {
  if (!previous) return { rounds: [] };
  const unreadable = new Error(
    `Could not read "previous". Pass the last ${MARKER_HINT} line of the previous jev_review result unchanged.`
  );
  const text = String(previous);
  const match = MARKER_PATTERN.exec(text);
  if (!match) throw unreadable;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw unreadable;
  }
  const validRounds =
    Array.isArray(parsed.rules) &&
    Array.isArray(parsed.rounds) &&
    parsed.rounds.every((r) => Array.isArray(r) && r.length === parsed.rules.length && r.every(Number.isFinite));
  if (!validRounds) throw unreadable;
  return { rules: parsed.rules, rounds: parsed.rounds, task: parsed.task };
}

const TOOL_DEFINITION = {
  name: 'jev_review',
  description:
    'Ask Jev (a staff-engineer-level review model) small yes/no rules about the current code change and locate the line each one breaks. Returns findings as `path:line — rule NN%` in a Fix tier (>= 80%) and a Verify tier (55-79%). Call again with `previous` set to the last result to continue the loop after fixes.',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: "The user's requested behavior and constraints, unchanged across rounds — later rounds reuse the round-1 task."
      },
      diff: {
        type: 'string',
        description: 'Only the real diff of the change (e.g. `git diff`); no pseudo-diffs or changes outside the repo — describe those in `context`.'
      },
      files: {
        type: 'array',
        description: 'Only neighboring files needed to judge conventions.',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content']
        }
      },
      context: { type: 'string', description: 'Relevant conventions or business rules not evident from the diff.' },
      previous: {
        type: 'string',
        description: `The last line of the previous jev_review call's text output (the \`${MARKER_HINT}\` marker), pasted unchanged.`
      }
    },
    required: ['task', 'diff']
  },
  annotations: { readOnlyHint: true, openWorldHint: true, title: 'Jev code review' }
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notifications (e.g. notifications/initialized) never get a reply

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'jev-code-review', version: '0.1.0' }
      });
      return;
    }
    if (method === 'ping') {
      reply(id, {});
      return;
    }
    if (method === 'tools/list') {
      reply(id, { tools: [TOOL_DEFINITION] });
      return;
    }
    if (method === 'tools/call') {
      if (params?.name !== 'jev_review') {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      let result;
      try {
        result = await runReview(params.arguments);
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message || String(error) }] };
      }
      reply(id, result);
      return;
    }
    replyError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    replyError(id, -32603, error.message || String(error));
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`jev-code-review: invalid JSON-RPC line: ${trimmed}\n`);
    return;
  }
  handle(message).catch((error) => process.stderr.write(`jev-code-review: ${error.message || error}\n`));
});
