// jev-code-review — shared review core used by server.mjs, the per-edit hook
// in context.mjs, and the OpenCode plugin.
//
// Turns a diff into small yes/no ("noul") rules plus a line-locating
// ("choice") question per rule, asks Jev, and reports findings in tiers.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const JEV_API_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const FIX_TIER = 0.8;
export const VERIFY_TIER = 0.55;
export const MAX_CHOICES = 255;

export const RULES = [
  {
    name: 'defect',
    needsTask: false,
    locate: true,
    violation:
      'For some input the task or the callers can pass, an added line returns a wrong result, leaves wrong state, throws when it should not, or fails to throw when it should.',
    clean: 'Every added line behaves correctly for the inputs it can receive; style, performance and hypothetical misuse do not count.'
  },
  {
    name: 'missing_requirement',
    needsTask: true,
    locate: false,
    violation: 'Something the task explicitly asks for is not implemented anywhere in the diff.',
    clean: 'Everything the task explicitly asks for is implemented in the diff.'
  },
  {
    name: 'speculative_code',
    needsTask: true,
    locate: true,
    violation:
      'An added line introduces a feature, option, parameter, branch, or validation that the task did not ask for and nothing shown needs, such as validating data this same program just wrote.',
    clean: 'Every added line is needed by the task or by code shown.'
  },
  {
    name: 'new_dependency',
    needsTask: false,
    locate: true,
    violation: 'The diff adds a third-party package, dependency, or test framework to a manifest or lockfile that the task did not ask for.',
    clean: 'The diff adds no new third-party dependency, or the task asked for it.'
  },
  {
    name: 'reinvents_existing',
    needsTask: false,
    locate: true,
    violation: 'An added line reimplements a helper, constant, or logic that already exists in the shown code or context instead of reusing it.',
    clean: 'Added lines reuse what the shown code already provides.'
  },
  {
    name: 'unrelated_change',
    needsTask: true,
    locate: true,
    violation: 'The diff changes lines unrelated to the task: a drive-by refactor, rename, reformat, or edit to code the task does not touch.',
    clean: 'Every changed line traces to the task.'
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
      instructions: 'Is this true of the change?',
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

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const chunkRules = i === 0 ? rules : rules.filter((r) => r.locate);
    const questions = buildQuestions(chunkRules, chunk.ids);
    const response = await callJev(apiKey, { ...state, diff: chunk.text }, questions, fetchImpl);
    results.push({ response, questions, rules: chunkRules, lineIds: chunk.ids });
  }
  return results;
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
      if (answer.noul <= entry.probability && entry.where !== null) continue;
      if (answer.noul < entry.probability) continue;

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
      violation: rule.violation,
      probability: entry.probability,
      where: entry.where,
      lineConfidence: entry.lineConfidence,
      tier: tierFor(entry.probability)
    };
  });
}
