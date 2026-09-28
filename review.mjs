// jev-code-review — shared review core used by server.mjs, the per-edit hook
// in context.mjs, and the OpenCode plugin.
//
// Turns a diff into small yes/no ("noul") rules plus a line-locating
// ("choice") question per rule, asks Jev, and reports findings in tiers.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const JEV_API_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const BLOCK_TIER = 0.9;
export const ADVISE_TIER = 0.55;
export const MAX_CHOICES = 255;
export const LINE_CONFIDENCE = 0.4;

export const RULES = [
  {
    name: 'addresses_task',
    label: 'Task not done',
    needsTask: true,
    locate: false,
    ask: "Does the change fail to do what the task asks?",
    violation:
      "Yes: the change does not accomplish what the task asks, does it only partly, or breaks a constraint the task states.",
    clean: "No: the change does what the task asks and respects its stated constraints."
  },
  {
    name: 'unrelated_change',
    label: 'Unrelated changes',
    needsTask: true,
    locate: true,
    ask: "Does the diff change existing code that the task does not need changed?",
    violation:
      "Yes: it renames, reformats, reorders, or rewrites existing lines that the requested behavior does not depend on.",
    clean: "No: every changed existing line is needed for the requested behavior; new files, tests, and docs for the requested behavior count as needed."
  },
  {
    name: 'missing_requirement',
    label: 'Missing requirements',
    needsTask: true,
    locate: false,
    ask: "Is something the task explicitly asks for absent from the diff?",
    violation:
      "Yes: a behavior, flag, output, test, or file that the task names explicitly is not implemented anywhere in the diff.",
    clean: "No: everything the task names explicitly is implemented in the diff."
  },
  {
    name: 'defect',
    label: 'Defects',
    needsTask: false,
    locate: true,
    ask: "Does an added line contain a concrete behavioral defect that the task's inputs or a caller can reach?",
    violation:
      "Yes: for some input it can receive, an added line returns a wrong value, skips or double-counts an item, leaves wrong state, swallows an error into a misleading result, forgets to await, or has a condition or bound the wrong way round.",
    clean: "No: every added line behaves correctly for every input it can receive; style, performance and hypothetical misuse do not count."
  }
];

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function decodeGitPath(value) {
  if (!value.startsWith('"')) return value;
  const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  return Buffer.concat([...value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/gs)].map(([, escape, literal]) => {
    if (literal) return Buffer.from(literal);
    if (/^[0-7]{1,3}$/.test(escape)) return Buffer.from([parseInt(escape, 8)]);
    return Buffer.from(escapes[escape] ?? escape);
  })).toString('utf8');
}

export function tagDiff(diff) {
  const lines = new Map();
  const out = [];
  let currentPath = null;
  let newLine = null;
  let counter = 0;

  for (const rawLine of diff.split('\n')) {
    const fileMatch = /^\+\+\+ (b\/.+|".+")$/.exec(rawLine);
    if (fileMatch) {
      currentPath = decodeGitPath(fileMatch[1]).slice(2);
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

export function findGitRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const AGENTS_FILE_PATTERN = /^AGENTS.*\.md$/;

export function instructionFiles(root, changedPaths) {
  const resolvedRoot = path.resolve(root);
  const seen = new Map();

  for (const changedPath of changedPaths) {
    let dir = path.resolve(resolvedRoot, path.dirname(changedPath));
    if (dir !== resolvedRoot && !dir.startsWith(resolvedRoot + path.sep)) continue;

    for (;;) {
      for (const file of listAgentsFiles(resolvedRoot, dir)) {
        if (!seen.has(file.path)) seen.set(file.path, file);
      }
      if (dir === resolvedRoot) break;
      dir = path.dirname(dir);
    }
  }

  return [...seen.values()];
}

function listAgentsFiles(root, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!AGENTS_FILE_PATTERN.test(entry.name) || !entry.isFile()) continue;
    const absolute = path.join(dir, entry.name);
    let content;
    try {
      content = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    files.push({ path: path.relative(root, absolute), dir: path.relative(root, dir), content });
  }
  return files;
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

const HEADING_LINE = /^#{1,6}\s/;
const FENCE_LINE = /^(```|~~~)/;
const TABLE_SEPARATOR_LINE = /^[\s|:-]+$/;
const LIST_MARKER = /^(?:[-*+]|\d+\.)\s+/;

export function candidateLines(content) {
  const result = [];
  for (const rawLine of content.split('\n')) {
    if (result.length >= 80) break;
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (HEADING_LINE.test(trimmed)) continue;
    if (FENCE_LINE.test(trimmed)) continue;
    if (TABLE_SEPARATOR_LINE.test(trimmed) && trimmed.includes('-')) continue;
    const stripped = trimmed.replace(LIST_MARKER, '').trim();
    if (stripped.length < 12 || stripped.length > 400) continue;
    result.push(stripped);
  }
  return result;
}

export async function extractRules({ apiKey, file, fetchImpl = fetch }) {
  const cacheKey = createHash('sha1').update(file.content).digest('hex');
  const cachePath = path.join(os.tmpdir(), `jev-rules-${cacheKey}.json`);

  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (Array.isArray(cached)) return cached;
  } catch {
    // cache miss or unreadable cache: fall through to extraction
  }

  const candidates = candidateLines(file.content);
  if (candidates.length === 0) {
    try {
      writeFileSync(cachePath, JSON.stringify([]));
    } catch {
      // ignore: the next call re-extracts
    }
    return [];
  }

  const questions = {};
  for (let i = 0; i < candidates.length; i += 1) {
    const n = i + 1;
    questions[`line_${n}`] = {
      type: 'noul',
      instructions: `Is line ${n} a rule about how code in this project must be written?`,
      criteria: {
        true: `Yes: line ${n} states how code must or must not be written.`,
        false: `No: line ${n} is prose, process, or context, not a rule about code.`
      }
    };
  }
  const state = {
    instructions_file: file.path,
    lines: candidates.map((text, i) => `${i + 1}| ${text}`).join('\n')
  };

  let response;
  try {
    response = await callJev(apiKey, state, questions, fetchImpl);
  } catch {
    return [];
  }

  const kept = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const answer = response.answers?.[`line_${i + 1}`];
    if (answer && typeof answer.noul === 'number' && answer.noul >= 0.5) kept.push(candidates[i]);
  }

  try {
    writeFileSync(cachePath, JSON.stringify(kept));
  } catch {
    // ignore: the next call re-extracts
  }
  return kept;
}

const MAX_PROJECT_RULES = 60;

export async function projectRules({ apiKey, root, changedPaths, fetchImpl = fetch }) {
  try {
    const files = instructionFiles(root, changedPaths);
    const rules = [];
    let counter = 0;
    for (const file of files) {
      const extracted = await extractRules({ apiKey, file, fetchImpl });
      for (const ruleText of extracted) {
        counter += 1;
        rules.push({
          name: `agents_${counter}`,
          needsTask: false,
          locate: true,
          dir: file.dir,
          source: file.path,
          ruleText,
          ask: `Does an added line break this project rule: "${ruleText}"?`,
          violation: `Yes: an added line breaks "${ruleText}" (from ${file.path}).`,
          clean: `No: no added line breaks "${ruleText}".`
        });
        if (rules.length >= MAX_PROJECT_RULES) return rules;
      }
    }
    return rules;
  } catch {
    return [];
  }
}

function isProjectRule(rule) {
  return typeof rule.dir === 'string';
}

function underDir(filePath, dir) {
  if (dir === '') return true;
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

function locateQuestion(ruleName, lineIds) {
  const criteria = {};
  for (const id of lineIds) criteria[id] = null;
  return {
    type: 'choice',
    instructions: `If \`${ruleName}\` is true, which numbered added line breaks it? If not, pick the line most likely to.`,
    criteria
  };
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
      questions[`${rule.name}_line`] = locateQuestion(rule.name, lineIds);
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

export async function askInStages({ apiKey, state, rules, tagged, fetchImpl = fetch }) {
  const builtInRules = rules.filter((rule) => !isProjectRule(rule));
  const stage1Results = builtInRules.length > 0
    ? await askJev({ apiKey, state, rules: builtInRules, tagged, fetchImpl })
    : [];
  const groups = new Map();
  for (const rule of rules.filter(isProjectRule)) {
    if (!groups.has(rule.dir)) groups.set(rule.dir, []);
    groups.get(rule.dir).push(rule);
  }

  const scopes = new Map();
  for (const [dir, group] of groups) {
    const lines = new Map([...tagged.lines].filter(([, info]) => underDir(info.path, dir)));
    if (lines.size === 0) continue;
    const text = dir === '' ? tagged.text : tagged.text.split(/(?=^diff --git )/m).filter((section) => {
      const id = /^(L\d+)\|/m.exec(section)?.[1];
      return lines.has(id);
    }).join('');
    const scoped = { text, lines };
    scopes.set(dir, scoped);
    const stage1Rules = group.map((rule) => ({ ...rule, locate: false }));
    const questions = buildQuestions(stage1Rules, []);
    const response = await callJev(apiKey, { ...state, diff: text }, questions, fetchImpl);
    stage1Results.push({ response, questions, rules: stage1Rules });
  }

  const stage1Found = findings(stage1Results, rules, tagged);
  const stage2Results = [];
  for (const [dir, group] of groups) {
    const elevated = group.filter((rule) => stage1Found.some((f) => f.name === rule.name && f.tier !== 'none'));
    if (elevated.length === 0) continue;
    for (const chunk of splitByFileAndSize(scopes.get(dir))) {
      const questions = Object.fromEntries(elevated.map((rule) => [`${rule.name}_line`, locateQuestion(rule.name, chunk.ids)]));
      let response;
      try {
        response = await callJev(apiKey, { ...state, diff: chunk.text }, questions, fetchImpl);
      } catch {
        continue;
      }
      for (const rule of elevated) {
        stage2Results.push({
          response: { answers: {
            [rule.name]: { noul: stage1Found.find((f) => f.name === rule.name).probability },
            [`${rule.name}_line`]: response.answers?.[`${rule.name}_line`]
          } },
          rules: [rule]
        });
      }
    }
  }
  return [...stage1Results, ...stage2Results];
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
  if (probability >= BLOCK_TIER) return 'block';
  if (probability >= ADVISE_TIER) return 'advise';
  return 'none';
}

export function findings(results, rules, tagged) {
  const missing = [...new Set(results.flatMap(({ response, rules: asked }) =>
    asked.filter((rule) => !Number.isFinite(response?.answers?.[rule.name]?.noul)).map((rule) => rule.name)
  ))];
  if (missing.length > 0) throw new Error(`Jev returned no answer for: ${missing.join(', ')}. Review not completed.`);
  const byName = new Map(rules.map((r) => [r.name, { rule: r, probability: 0, where: null, lineConfidence: null }]));

  for (const result of results) {
    const { response, rules: resultRules } = result;
    for (const rule of resultRules) {
      const answer = response.answers?.[rule.name];
      if (!answer || typeof answer.noul !== 'number') continue;
      const entry = byName.get(rule.name);
      let where = null;
      let lineConfidence = null;
      if (rule.locate) {
        const lineAnswer = response.answers?.[`${rule.name}_line`];
        if (lineAnswer && lineAnswer.choice) {
          where = tagged.lines.get(lineAnswer.choice) || null;
          lineConfidence = lineAnswer.probabilities?.[lineAnswer.choice] ?? lineAnswer.confidence ?? null;
        }
      }
      const isHigher = answer.noul > entry.probability ||
        (answer.noul === entry.probability && (entry.where === null || (lineConfidence ?? 0) > (entry.lineConfidence ?? 0)));
      if (isHigher) byName.set(rule.name, { rule, probability: answer.noul, where, lineConfidence });
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
      tier: tierFor(entry.probability),
      ruleText: rule.ruleText,
      source: rule.source
    };
  });
}

export function formatWhere(finding) {
  if (!finding.where) return '';
  const uncertain = finding.lineConfidence !== null && finding.lineConfidence < LINE_CONFIDENCE ? ' (line uncertain)' : '';
  return `${finding.where.path}:${finding.where.line}${uncertain} — `;
}

export function ruleLabel(name) {
  return RULES.find((rule) => rule.name === name)?.label ?? name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function findingLine(finding) {
  const percent = Math.round(finding.probability * 100);
  if (finding.source) {
    return `- ${formatWhere(finding)}"${finding.ruleText}" (${finding.source}) ${percent}%`;
  }
  return `- ${formatWhere(finding)}${ruleLabel(finding.name)} ${percent}%: ${finding.violation}`;
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
      execFileAsync('git', ['-C', cwd, 'diff', '--name-only', '-z', '--relative', 'HEAD']),
      execFileAsync('git', ['-C', cwd, 'ls-files', '-z', '--others', '--exclude-standard'])
    ]);
    const files = new Set();
    for (const file of tracked.stdout.split('\0')) if (file) files.add(file);
    for (const file of untracked.stdout.split('\0')) {
      if (!file || /(^|\/)\.git(\/|$)/.test(file)) continue;
      if (/^(?:\.env(?:\..*)?|.*\.(?:pem|key)|id_rsa.*)$/.test(path.basename(file))) continue;
      files.add(file);
    }
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
  for (const file of changed) {
    const hash = hashFile(cwd, file);
    if (!(file in state) || state[file] !== hash) toLint.push(file);
  }
  return toLint;
}

export async function lintAfterEdit({ cwd, sessionId, apiKey, fetchImpl = fetch }) {
  try {
    const result = await withTimeout(runLintAfterEdit({ cwd, sessionId, apiKey, fetchImpl }), 10_000);
    if (!result) return '';
    try {
      writeFileSync(result.statePath, JSON.stringify(result.nextState));
    } catch {}
    return result.text;
  } catch {
    return '';
  }
}

async function runLintAfterEdit({ cwd, sessionId, apiKey, fetchImpl }) {
  const files = await filesToLint({ cwd, sessionId });
  if (files.length === 0) return '';

  const statePath = stateFilePath(cwd, sessionId);
  const nextState = { ...readState(statePath) };
  for (const file of files) nextState[file] = hashFile(cwd, file);

  const diff = await gitDiffForFiles(cwd, files);
  if (!diff) return '';

  const tagged = tagDiff(diff);
  const root = findGitRoot(cwd);
  const changedPaths = [...new Set([...tagged.lines.values()].map((info) => info.path))];
  const projRules = root ? await projectRules({ apiKey, root, changedPaths, fetchImpl }) : [];
  const rules = [...RULES.filter((r) => !r.needsTask), ...loadRepoRules(cwd), ...projRules];
  const state = { task: '' };
  const results = await askInStages({ apiKey, state, rules, tagged, fetchImpl });
  const blockFindings = findings(results, rules, tagged).filter((f) => f.tier === 'block');
  if (blockFindings.length === 0) return { text: '', statePath, nextState };

  const lines = ['Jev after edit:'];
  for (const f of blockFindings) lines.push(findingLine(f));
  lines.push('Check these lines now.');
  return { text: lines.join('\n'), statePath, nextState };
}
