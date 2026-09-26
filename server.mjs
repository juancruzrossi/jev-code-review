#!/usr/bin/env node
// jev-code-review — dependency-free MCP server exposing one tool, `jev_review`, that scores
// a code change with the Jev API (https://api.typesafe.ai) across six staff-
// engineer dimensions and returns a deterministic round-by-round table.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout,
// with zero runtime dependencies.

import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const JEV_API_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const MAX_ROUNDS = 3;
const PASS_SCORE = 8;

// The review framing (Q5/Q18): sent only to Jev, never to the coding model
// (see context.mjs).
const STANDARD_FRAMING =
  'Judge as a staff engineer with years in this codebase and its business, who ships the simplest professional code.';

// Order is fixed: it drives the table rows.
const DIMENSIONS = [
  {
    key: 'correctness',
    label: 'Correctness',
    sentence: 'Does exactly what the task asks, handles the real edge cases, and breaks nothing that worked.',
    weaknesses: {
      missing_behavior: 'Requested behavior appears missing or incomplete.',
      edge_case: 'An important edge case or invalid state appears insufficiently handled.',
      incorrect_assumption: 'The implementation appears to rely on an unsafe or incorrect assumption.',
      regression_risk: 'The change creates a meaningful risk of breaking existing behavior.'
    }
  },
  {
    key: 'simplicity',
    label: 'Simplicity',
    sentence:
      'Minimum code that solves the problem: no speculative features, single-use abstractions, unrequested configurability, or handling for impossible cases.',
    weaknesses: {
      speculative_feature: 'Adds a feature, branch, or config not requested by the task.',
      single_use_abstraction: 'Introduces an abstraction, interface, or class used by only one caller.',
      unrequested_config: 'Adds configurability or parameters nothing currently needs.',
      impossible_case_handling: 'Handles a case that cannot occur in this codebase.'
    }
  },
  {
    key: 'scope',
    label: 'Surgical scope',
    sentence: 'Every changed line traces to the task; no drive-by refactors, reformatting, or edits to unrelated code.',
    weaknesses: {
      drive_by_refactor: 'Refactors or renames code unrelated to the task.',
      reformatting: 'Reformats or reorders unrelated code.',
      unrelated_edit: 'Changes a file or line that does not trace to the task.',
      scope_creep: 'Does more than the task asked for.'
    }
  },
  {
    key: 'conventions',
    label: 'Conventions',
    sentence:
      "Matches the repository's existing style, patterns, and neighboring code, reusing what already exists instead of reinventing it.",
    weaknesses: {
      repository_pattern: 'Diverges from an established repository pattern without justification.',
      ignores_neighbor: 'Ignores an existing neighboring implementation solving the same problem.',
      naming_convention: 'Naming or style conflicts with nearby code.',
      reinvents_existing: 'Reimplements something that already exists in the codebase.'
    }
  },
  {
    key: 'readability',
    label: 'Readability',
    sentence: 'A new teammate understands the intent at first read: clear names, direct flow, no cleverness.',
    weaknesses: {
      naming: 'Names do not communicate intent clearly.',
      flow_clarity: 'Control or data flow is hard to follow at first read.',
      unnecessary_cleverness: 'Uses a clever trick where a direct approach would be clearer.',
      comment_quality: 'Comments are missing where needed or add noise.'
    }
  },
  {
    key: 'maintainability',
    label: 'Maintainability',
    sentence: 'The next change of the same kind touches one predictable place; no duplicated knowledge or hidden coupling.',
    weaknesses: {
      duplicated_knowledge: 'The same rule or knowledge is duplicated in more than one place.',
      hidden_coupling: 'Hidden coupling makes the impact of a future change hard to predict.',
      unpredictable_location: 'The next similar change would not have one predictable place to go.',
      change_amplification: 'A small future change would likely require edits in many places.'
    }
  }
];

const STANDARD = [STANDARD_FRAMING, ...DIMENSIONS.map((d) => `${d.label}: ${d.sentence}`)].join('\n');

const SCORE_LEVELS = [
  '1 — Serious, fundamental problems; unsafe or substantially unfit.',
  '2 — Severe problems dominate; major rework is required.',
  '3 — Serious weaknesses; important behavior or design is unreliable.',
  '4 — Meaningful weaknesses materially impede quality.',
  '5 — Several consequential weaknesses remain.',
  '6 — Acceptable baseline, but notable improvement is warranted.',
  '7 — Sound overall with limited, concrete weaknesses.',
  '8 — Strong; only minor meaningful improvements are available.',
  '9 — Very strong and well fitted to its context.',
  '10 — Exceptional; little meaningful improvement is available. Use rarely.'
];

function buildQuestions() {
  const questions = {};
  for (const dim of DIMENSIONS) {
    questions[`${dim.key}_score`] = {
      type: 'score',
      instructions: `Rate ${dim.label} for the implementation in the supplied software-change state. ${dim.sentence}`,
      criteria: SCORE_LEVELS
    };
    questions[`${dim.key}_weakness`] = {
      type: 'choice',
      instructions: `Identify the single most consequential ${dim.label} weakness evidenced by the supplied software-change state. Choose no_material_issue when no listed concern is justified. Do not speculate beyond the state.`,
      criteria: { no_material_issue: 'No material issue is evident from the supplied context.', ...dim.weaknesses }
    };
  }
  return questions;
}

function readApiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  try {
    process.loadEnvFile(path.join(os.homedir(), '.env'));
  } catch {
    // no ~/.env or it couldn't be read — fall through to the missing-key error below
  }
  return process.env.JEV_API_KEY || null;
}

async function callJev(apiKey, state, questions) {
  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetch(JEV_API_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(60_000)
      });
    } catch (error) {
      if (error.name === 'TimeoutError') throw new Error('Jev did not respond within 60s. Try again.');
      throw new Error('Could not reach the Jev API. Check network access and try again.');
    }

    if (response.ok) return response.json();

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) continue;

    if (response.status === 401) {
      throw new Error('Jev rejected JEV_API_KEY. Check that the key is current and available to the MCP process.');
    }
    if (response.status === 400) {
      let errorType;
      try {
        errorType = (await response.json())?.detail?.error_type;
      } catch {
        // ignore unparseable body
      }
      if (errorType === 'max_tokens_exceeded') {
        throw new Error("Jev's input limit was exceeded. Send a smaller diff and try again.");
      }
    }
    if (response.status === 429) throw new Error('Jev rate-limited the request after a retry. Try again shortly.');
    throw new Error(`Jev API request failed with HTTP ${response.status}.`);
  }
  throw new Error('Jev request failed after a retry.');
}

function padCenter(text, width) {
  const left = Math.floor((width - text.length) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left);
}

function padLeftAlign(text, width) {
  return ' ' + text + ' '.repeat(width - 1 - text.length);
}

// Final is the last round. ✓/✗ instead of emoji: emoji width varies by
// terminal font and would misalign the right border.
function renderTable(rounds) {
  const finals = rounds[rounds.length - 1];
  const headers = ['Dimension', ...rounds.slice(0, -1).map((_, i) => `Round ${i + 1}`), 'Final'];
  const finalWidth = Math.max(...finals.map((score) => score.toFixed(1).length));
  const rows = DIMENSIONS.map((dim, row) => [
    dim.label,
    ...rounds.slice(0, -1).map((round) => round[row].toFixed(1)),
    `${finals[row].toFixed(1).padStart(finalWidth)} ${finals[row] >= PASS_SCORE ? '✓' : '✗'}`
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

function verdictLine(round, allPassed) {
  if (allPassed) return 'PASSED — deliver.';
  if (round < MAX_ROUNDS) return `Round ${round}/${MAX_ROUNDS} — fix the failing dimensions and call jev_review again with previous.`;
  return 'Max rounds reached — deliver with your own judgment.';
}

async function runReview(args) {
  const { task, diff, files, context, previous } = args || {};
  if (!task || typeof task !== 'string') throw new Error('jev_review requires a non-empty "task" string.');
  if (!diff || typeof diff !== 'string') throw new Error('jev_review requires a non-empty "diff" string.');

  const apiKey = readApiKey();
  if (!apiKey) {
    return { isError: true, content: [{ type: 'text', text: 'JEV_API_KEY is not set (checked process.env and ~/.env).' }] };
  }

  const prior = parsePrevious(previous);
  const pinnedTask = prior.task || task;

  const state = { standard: STANDARD, task: pinnedTask, diff };
  if (Array.isArray(files) && files.length > 0) state.files = files;
  if (context) state.context = context;

  const response = await callJev(apiKey, state, buildQuestions());

  const roundScores = DIMENSIONS.map((dim) => {
    const answer = response.answers?.[`${dim.key}_score`];
    if (!answer || answer.type !== 'score') throw new Error(`Jev omitted the score for ${dim.key}.`);
    return Math.round((answer.score + 1) * 10) / 10;
  });
  const weaknesses = DIMENSIONS.map((dim) => {
    const answer = response.answers?.[`${dim.key}_weakness`];
    const choice = answer?.type === 'choice' ? answer.choice : 'no_material_issue';
    return choice === 'no_material_issue' ? null : dim.weaknesses[choice] || choice;
  });

  const rounds = [...prior.rounds, roundScores];
  const round = rounds.length;
  const passedPerDim = roundScores.map((score) => score >= PASS_SCORE);
  const passed = passedPerDim.every(Boolean);

  const lines = [renderTable(rounds), ''];
  DIMENSIONS.forEach((dim, i) => {
    if (!passedPerDim[i] && weaknesses[i]) lines.push(`${dim.label} ${roundScores[i].toFixed(1)}: ${weaknesses[i]}`);
  });
  if (lines.length > 2) lines.push('');
  lines.push(verdictLine(round, passed));
  // Bookkeeping for the next call's `previous`, appended to the same text the
  // model already reads (Claude Code's client drops `content` text whenever
  // `structuredContent` is also present, so round state travels inline instead).
  lines.push(`<!-- jev:previous ${JSON.stringify({ rounds, task: pinnedTask }).replaceAll('>', '\\u003e')} -->`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function parsePrevious(previous) {
  if (!previous) return { rounds: [] };
  const match = /<!--\s*jev:previous\s+(.*?)\s*-->/s.exec(String(previous));
  if (!match) return { rounds: [] };
  try {
    const parsed = JSON.parse(match[1]);
    return { rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [], task: parsed.task };
  } catch {
    return { rounds: [] };
  }
}

const TOOL_DEFINITION = {
  name: 'jev_review',
  description:
    'Score the current code change with Jev (a staff-engineer-level review model) across six dimensions: correctness, simplicity, surgical scope, conventions, readability, maintainability. Returns a deterministic round-by-round table. Call again with `previous` set to the last result to continue the loop after fixes.',
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
        description: "The last line of the previous jev_review call's text output (the `<!-- jev:previous ... -->` marker), pasted unchanged."
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
