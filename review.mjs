// jev-code-review — shared review core used by server.mjs, the per-edit hook
// in context.mjs, and the OpenCode plugin.
//
// Turns a diff into small yes/no ("noul") rules plus a line-locating
// ("choice") question per rule, asks Jev, and reports findings in tiers.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const JEV_API_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const FIX_TIER = 0.75;
export const VERIFY_TIER = 0.55;
export const MAX_CHOICES = 255;
export const LINE_CONFIDENCE = 0.4;

export const RULES = [
  {
    name: 'defect',
    needsTask: false,
    locate: true,
    ask: "Does an added line contain a concrete behavioral defect that the task's inputs or a caller can reach?",
    violation:
      "Yes: for some input it can receive, an added line returns a wrong value, skips or double-counts an item, leaves wrong state, swallows an error into a misleading result, forgets to await, or has a condition or bound the wrong way round.",
    clean: "No: every added line behaves correctly for every input it can receive; style, performance and hypothetical misuse do not count."
  },
  {
    name: 'missing_requirement',
    needsTask: true,
    locate: false,
    ask: "Is something the task explicitly asks for absent from the diff?",
    violation:
      "Yes: a behavior, flag, output, test, or file that the task names explicitly is not implemented anywhere in the diff.",
    clean: "No: everything the task names explicitly is implemented in the diff."
  },
  {
    name: 'speculative_code',
    needsTask: true,
    locate: true,
    ask: "Does the diff add behavior the task did not ask for?",
    violation:
      "Yes: it adds an option, flag, parameter, environment or config setting, cache, retry, fallback, or validation of data this program itself produced, which the task never mentions and no shown code needs.",
    clean: "No: every added behavior is asked for by the task or required by shown code; tests and docs for the requested behavior count as asked for."
  },
  {
    name: 'new_dependency',
    needsTask: false,
    locate: true,
    ask: "Does the diff add a third-party dependency the task did not ask for?",
    violation:
      "Yes: a manifest or lockfile (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml) gains a third-party package, library, or test framework that the task never mentions.",
    clean: "No: no third-party package is added, or the task asked for it."
  },
  {
    name: 'reinvents_existing',
    needsTask: false,
    locate: true,
    ask: "Does an added line reimplement something the shown code already provides?",
    violation:
      "Yes: an added line re-implements a helper, constant, parser, formatter, or query that already exists in the shown files or context, instead of calling it.",
    clean: "No: added lines call what the shown code already provides, or nothing shown does the same job."
  },
  {
    name: 'unrelated_change',
    needsTask: true,
    locate: true,
    ask: "Does the diff change existing code that the task does not need changed?",
    violation:
      "Yes: it renames, reformats, reorders, or rewrites existing lines that the requested behavior does not depend on.",
    clean: "No: every changed existing line is needed for the requested behavior; new files, tests, and docs for the requested behavior count as needed."
  }
];

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function tagDiff(diff) {
  const lines = new Map();
  const out = [];
  let currentPath = null;
  let newLine = null;
  let counter = 0;

  for (const rawLine of diff.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(rawLine);
    if (fileMatch) {
      currentPath = fileMatch[1];
      out.push(rawLine);
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(rawLine);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      out.push(rawLine);
      continue;
    }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      counter += 1;
      const id = `L${String(counter).padStart(4, '0')}`;
      lines.set(id, { path: currentPath, line: newLine });
      newLine += 1;
      out.push(`${id}|${rawLine}`);
      continue;
    }
    if (rawLine.startsWith(' ') || (rawLine.startsWith('-') && !rawLine.startsWith('---'))) {
      if (rawLine.startsWith(' ') && newLine !== null) newLine += 1;
      out.push(rawLine);
      continue;
    }
    out.push(rawLine);
  }

  return { text: out.join('\n'), lines };
}

function findGitRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadRepoRules(cwd) {
  const root = findGitRoot(cwd);
  if (!root) return [];
  let raw;
  try {
    raw = readFileSync(path.join(root, '.jev', 'rules.json'), 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('.jev/rules.json must be a JSON list of { "name", "rule" }.');
  }
  if (!Array.isArray(parsed) || !parsed.every((r) => r && typeof r.name === 'string' && typeof r.rule === 'string')) {
    throw new Error('.jev/rules.json must be a JSON list of { "name", "rule" }.');
  }
  return parsed.map((r) => ({
    name: r.name,
    needsTask: false,
    locate: true,
    violation: `An added line breaks this rule: ${r.rule}`,
    clean: `No added line breaks this rule: ${r.rule}`
  }));
}

export function buildQuestions(rules, lineIds) {
  const questions = {};
  for (const rule of rules) {
    questions[rule.name] = {
      type: 'noul',
      instructions: rule.ask ?? 'Is this true of the change?',
      criteria: { true: rule.violation, false: rule.clean }
    };
    if (rule.locate && lineIds.length > 0) {
      const criteria = {};
      for (const id of lineIds) criteria[id] = null;
      questions[`${rule.name}_line`] = {
        type: 'choice',
        instructions: `If \`${rule.name}\` is true, which numbered added line breaks it? If not, pick the line most likely to.`,
        criteria
      };
    }
  }
  return questions;
}

export async function askJev({ apiKey, state, rules, tagged, fetchImpl = fetch }) {
  const lineIds = [...tagged.lines.keys()];

  if (lineIds.length <= MAX_CHOICES) {
    const questions = buildQuestions(rules, lineIds);
    const response = await callJev(apiKey, { ...state, diff: tagged.text }, questions, fetchImpl);
    return [{ response, questions, rules }];
  }

  const chunks = splitByFileAndSize(tagged);
  const results = [];

  const locatingRules = rules.filter((r) => r.locate);
  for (const chunk of chunks) {
    const questions = buildQuestions(locatingRules, chunk.ids);
    const response = await callJev(apiKey, { ...state, diff: chunk.text }, questions, fetchImpl);
    results.push({ response, questions, rules: locatingRules, lineIds: chunk.ids });
  }

  const taskRules = rules.filter((r) => !r.locate);
  if (taskRules.length > 0) {
    const questions = buildQuestions(taskRules, []);
    const response = await callJev(apiKey, { ...state, diff: untagDiffText(tagged.text) }, questions, fetchImpl);
    results.push({ response, questions, rules: taskRules, lineIds: [] });
  }

  return results;
}

function untagDiffText(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^L\d{4}\|/, ''))
    .join('\n');
}

function splitByFileAndSize(tagged) {
  const byFile = new Map();
  for (const [id, info] of tagged.lines) {
    if (!byFile.has(info.path)) byFile.set(info.path, []);
    byFile.get(info.path).push(id);
  }

  const chunks = [];
  for (const [filePath, ids] of byFile) {
    for (let i = 0; i < ids.length; i += MAX_CHOICES) {
      const idsSlice = ids.slice(i, i + MAX_CHOICES);
      chunks.push({ path: filePath, ids: idsSlice, text: buildChunkText(tagged, idsSlice) });
    }
  }
  return chunks;
}

function buildChunkText(tagged, ids) {
  const idSet = new Set(ids);
  const lines = tagged.text.split('\n');
  const out = [];
  for (const line of lines) {
    const idMatch = /^L\d{4}\|/.exec(line);
    if (idMatch) {
      const id = idMatch[0].slice(0, 5);
      if (!idSet.has(id)) continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export async function callJev(apiKey, state, questions, fetchImpl = fetch) {
  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(JEV_API_ENDPOINT, {
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

function tierFor(probability) {
  if (probability >= FIX_TIER) return 'fix';
  if (probability >= VERIFY_TIER) return 'verify';
  return 'none';
}

export function findings(results, rules, tagged) {
  const byName = new Map(rules.map((r) => [r.name, { rule: r, probability: 0, where: null, lineConfidence: null }]));

  for (const result of results) {
    const { response, rules: resultRules } = result;
    for (const rule of resultRules) {
      const answer = response.answers?.[rule.name];
      if (!answer || typeof answer.noul !== 'number') continue;
      const entry = byName.get(rule.name);
      const isHigher = answer.noul > entry.probability || (answer.noul === entry.probability && entry.where === null);
      if (!isHigher) continue;

      let where = null;
      let lineConfidence = null;
      if (rule.locate) {
        const lineAnswer = response.answers?.[`${rule.name}_line`];
        if (lineAnswer && lineAnswer.choice) {
          where = tagged.lines.get(lineAnswer.choice) || null;
          lineConfidence = lineAnswer.probabilities?.[lineAnswer.choice] ?? lineAnswer.confidence ?? null;
        }
      }
      byName.set(rule.name, { rule, probability: answer.noul, where, lineConfidence });
    }
  }

  return rules.map((rule) => {
    const entry = byName.get(rule.name);
    return {
      name: rule.name,
      violation: rule.violation.replace(/^Yes: /, ''),
      probability: entry.probability,
      where: entry.where,
      lineConfidence: entry.lineConfidence,
      tier: tierFor(entry.probability)
    };
  });
}

export function formatWhere(finding) {
  if (!finding.where) return '';
  const uncertain = finding.lineConfidence !== null && finding.lineConfidence < LINE_CONFIDENCE ? ' (line uncertain)' : '';
  return `${finding.where.path}:${finding.where.line}${uncertain} — `;
}

const ENV_KEY_PATTERN = /^\s*(?:export\s+)?JEV_API_KEY\s*=\s*(.*)$/;

function unquote(value) {
  const trimmed = value.trim();
  const match = /^(['"])(.*)\1$/.exec(trimmed);
  return match ? match[2] : trimmed;
}

export function readApiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  let content;
  try {
    content = readFileSync(path.join(os.homedir(), '.env'), 'utf8');
  } catch {
    return null;
  }
  let value = null;
  for (const line of content.split('\n')) {
    const match = ENV_KEY_PATTERN.exec(line);
    if (match) value = unquote(match[1]);
  }
  return value || null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function isTracked(cwd, file) {
  try {
    await execFileAsync('git', ['-C', cwd, 'ls-files', '--error-unmatch', file]);
    return true;
  } catch {
    return false;
  }
}

async function gitDiffForFiles(cwd, files) {
  const tracked = [];
  const untracked = [];
  for (const file of files) {
    if (await isTracked(cwd, file)) tracked.push(file);
    else untracked.push(file);
  }

  let diff = '';
  if (tracked.length > 0) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'diff', 'HEAD', '--', ...tracked], { maxBuffer: 10 * 1024 * 1024 });
      diff += stdout;
    } catch (error) {
      if (typeof error.stdout === 'string') diff += error.stdout;
    }
  }
  for (const file of untracked) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'diff', '--no-index', '/dev/null', path.relative(cwd, path.resolve(cwd, file))], {
        maxBuffer: 10 * 1024 * 1024
      });
      diff += stdout;
    } catch (error) {
      // --no-index exits 1 when there is a difference, which is the normal case for an untracked file
      if (typeof error.stdout === 'string') diff += error.stdout;
    }
  }
  return diff;
}

export async function changedFiles(cwd) {
  try {
    const [tracked, untracked] = await Promise.all([
      execFileAsync('git', ['-C', cwd, 'diff', '--name-only', '--relative', 'HEAD']),
      execFileAsync('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'])
    ]);
    const files = new Set();
    for (const line of tracked.stdout.split('\n')) if (line.trim()) files.add(line.trim());
    for (const line of untracked.stdout.split('\n')) if (line.trim()) files.add(line.trim());
    return [...files];
  } catch {
    return [];
  }
}

function stateFilePath(cwd, sessionId) {
  const key = createHash('sha1').update(`${cwd}\0${sessionId ?? ''}`).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `jev-edit-${key}.json`);
}

function readState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function hashFile(cwd, file) {
  try {
    return createHash('sha1').update(readFileSync(path.join(cwd, file))).digest('hex');
  } catch {
    return '';
  }
}

export async function filesToLint({ cwd, sessionId }) {
  const changed = await changedFiles(cwd);
  const statePath = stateFilePath(cwd, sessionId);
  const state = readState(statePath);
  const toLint = [];
  const nextState = { ...state };
  for (const file of changed) {
    const hash = hashFile(cwd, file);
    if (!(file in state) || state[file] !== hash) toLint.push(file);
    nextState[file] = hash;
  }
  try {
    writeFileSync(statePath, JSON.stringify(nextState));
  } catch {
    // ignore: the next call falls back to an empty state
  }
  return toLint;
}

export async function lintAfterEdit({ cwd, sessionId, apiKey, fetchImpl = fetch }) {
  try {
    return await withTimeout(runLintAfterEdit({ cwd, sessionId, apiKey, fetchImpl }), 10_000);
  } catch {
    return '';
  }
}

async function runLintAfterEdit({ cwd, sessionId, apiKey, fetchImpl }) {
  const files = await filesToLint({ cwd, sessionId });
  if (files.length === 0) return '';

  const diff = await gitDiffForFiles(cwd, files);
  if (!diff) return '';

  const rules = [...RULES.filter((r) => !r.needsTask), ...loadRepoRules(cwd)];
  const tagged = tagDiff(diff);
  const results = await askJev({ apiKey, state: { task: '' }, rules, tagged, fetchImpl });
  const fixFindings = findings(results, rules, tagged).filter((f) => f.tier === 'fix');
  if (fixFindings.length === 0) return '';

  const lines = ['Jev after edit:'];
  for (const f of fixFindings) {
    lines.push(`- ${formatWhere(f)}${f.name} ${Math.round(f.probability * 100)}%: ${f.violation}`);
  }
  lines.push('Check these lines now.');
  return lines.join('\n');
}
