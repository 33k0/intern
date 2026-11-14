// Structural check for the hand-written evaluation cases and the worked examples.
//   node eval/cases/check.mjs
// Exits 1 if anything is wrong. It checks shape, not music: whether an accepted answer is
// musically right is a matter for a reader, not for this script.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', '..', 'context-pack', 'worked-examples.json');

const CASE_CALLS = [
  'setup', 'plan', 'theme_shape', 'theme_note', 'theme_judge',
  'phrase_direction', 'chord_path', 'voice_leading', 'phrase_judge', 'orchestration',
];
const CASES_PER_FILE = 20;
const MAX_TESTS_WORDS = 15;

// Worked examples: every call type the engine makes that reads examples, with its minimum count.
const EXAMPLE_MINIMUM = {
  setup: 3, plan: 3, theme_shape: 3, theme_note: 3, theme_judge: 3,
  phrase_direction: 3, chord_path: 3, voice_leading: 3, phrase_judge: 3, orchestration: 3,
  theme_derive: 2, hold: 2, ending: 2, plan_revision: 1,
};
const EXAMPLE_CALLS = [...Object.keys(EXAMPLE_MINIMUM), 'backdrop'];
const WORD_LIMIT = { state: 45, choice: 15, reason: 30 };

const problems = [];
const bad = (where, message) => problems.push(`${where}: ${message}`);
const words = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;
const isText = (x) => typeof x === 'string' && x.trim().length > 0;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function readJson(path, where) {
  if (!existsSync(path)) { bad(where, 'file is missing'); return null; }
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (err) { bad(where, `not valid JSON (${err.message})`); return null; }
}

/** How many keys of a choice question may be accepted: one or two, never more than a third of the options. */
const acceptLimit = (options) => Math.min(2, Math.max(1, Math.floor(options / 3)));

function checkQuestion(where, q, accept) {
  if (!isObject(q)) return bad(where, 'question must be an object');
  const extra = Object.keys(q).filter((k) => !['type', 'instructions', 'criteria'].includes(k));
  if (extra.length) bad(where, `question has unknown field(s): ${extra.join(', ')}`);
  if (!isText(q.instructions)) bad(where, 'question.instructions is empty');
  if (!Array.isArray(accept) || accept.length === 0) return bad(where, 'accept must be a non-empty array');
  if (accept.some((a) => typeof a !== 'string')) return bad(where, 'accept entries must be strings');
  if (new Set(accept).size !== accept.length) bad(where, 'accept has duplicates');

  if (q.type === 'choice') {
    if (!isObject(q.criteria)) return bad(where, 'choice question needs criteria as an object of option key -> text');
    const keys = Object.keys(q.criteria);
    if (keys.length < 2) bad(where, 'choice question needs at least two options');
    for (const k of keys) if (!isText(q.criteria[k])) bad(where, `option "${k}" has no text`);
    for (const a of accept) if (!keys.includes(a)) bad(where, `accept key "${a}" is not one of the options (${keys.join(', ')})`);
    const limit = acceptLimit(keys.length);
    if (accept.length > limit) bad(where, `accepts ${accept.length} of ${keys.length} options; the limit is ${limit}`);
  } else if (q.type === 'noul') {
    if (q.criteria !== undefined) {
      if (!isObject(q.criteria)) bad(where, 'noul criteria, when present, must be an object');
      else {
        for (const k of Object.keys(q.criteria)) if (k !== 'true' && k !== 'false') bad(where, `noul criteria key "${k}" must be "true" or "false"`);
        for (const k of Object.keys(q.criteria)) if (!isText(q.criteria[k])) bad(where, `noul criteria "${k}" has no text`);
      }
    }
    if (accept.length !== 1 || !['yes', 'no'].includes(accept[0])) bad(where, 'noul accept must be ["yes"] or ["no"]');
  } else if (q.type === 'score') {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.some((l) => !isText(l))) return bad(where, 'score question needs criteria as an array of level strings');
    if (accept.length > 3) bad(where, `score accept band has ${accept.length} levels; at most 3`);
    const levels = accept.map((a) => (/^\d+$/.test(a) ? Number(a) : NaN));
    if (levels.some((n) => Number.isNaN(n) || n < 0 || n >= q.criteria.length)) return bad(where, `score accept must be level indices 0..${q.criteria.length - 1} as strings`);
    const sorted = [...levels].sort((a, b) => a - b);
    if (sorted.some((n, i) => i > 0 && n !== sorted[i - 1] + 1)) bad(where, 'score accept band is not contiguous');
  } else {
    bad(where, `question.type must be choice, noul or score (got ${JSON.stringify(q.type)})`);
  }
}

function checkCaseFile(call, seenIds) {
  const file = `${call}.json`;
  const data = readJson(join(HERE, file), file);
  if (!data) return 0;
  if (data.call !== call) bad(file, `"call" is ${JSON.stringify(data.call)}, expected "${call}"`);
  if (!Array.isArray(data.cases)) { bad(file, '"cases" must be an array'); return 0; }
  if (data.cases.length !== CASES_PER_FILE) bad(file, `has ${data.cases.length} cases, expected ${CASES_PER_FILE}`);

  data.cases.forEach((c, i) => {
    const where = `${file} #${i + 1}${c && c.id ? ` (${c.id})` : ''}`;
    if (!isObject(c)) return bad(where, 'case must be an object');
    for (const f of ['id', 'tests', 'state', 'question', 'accept', 'why']) if (!(f in c)) bad(where, `missing field "${f}"`);
    const extra = Object.keys(c).filter((k) => !['id', 'tests', 'state', 'question', 'accept', 'why'].includes(k));
    if (extra.length) bad(where, `unknown field(s): ${extra.join(', ')}`);

    if (!isText(c.id)) bad(where, 'id is empty');
    else if (seenIds.has(c.id)) bad(where, `id "${c.id}" is used more than once`);
    else seenIds.add(c.id);

    if (!isText(c.tests)) bad(where, 'tests is empty');
    else if (words(c.tests) > MAX_TESTS_WORDS) bad(where, `tests has ${words(c.tests)} words; at most ${MAX_TESTS_WORDS}`);
    if (!isText(c.why)) bad(where, 'why is empty');

    if (!isText(c.state)) bad(where, 'state is empty');
    else {
      if (!c.state.startsWith('PROMPT  "')) bad(where, 'state should begin with the PROMPT line');
      // The harness appends the real theory slice and worked examples; a case must not carry its own.
      if (/^THEORY\b/m.test(c.state)) bad(where, 'state contains a THEORY block');
      if (/^WORKED EXAMPLES\b/m.test(c.state)) bad(where, 'state contains a WORKED EXAMPLES block');
    }
    checkQuestion(where, c.question, c.accept);
  });
  return data.cases.length;
}

function checkExamples() {
  const where = 'worked-examples.json';
  const data = readJson(EXAMPLES, where);
  if (!data) return 0;
  if (data.version !== 1) bad(where, '"version" must be 1');
  if (!Array.isArray(data.examples)) { bad(where, '"examples" must be an array'); return 0; }
  const count = {};
  data.examples.forEach((e, i) => {
    const at = `${where} #${i + 1}`;
    if (!isObject(e)) return bad(at, 'example must be an object');
    for (const f of ['call', 'state', 'choice', 'reason']) if (!isText(e[f])) bad(at, `"${f}" is missing or empty`);
    const extra = Object.keys(e).filter((k) => !['call', 'state', 'choice', 'reason'].includes(k));
    if (extra.length) bad(at, `unknown field(s): ${extra.join(', ')}`);
    if (isText(e.call)) {
      if (!EXAMPLE_CALLS.includes(e.call)) bad(at, `call "${e.call}" is not a call type the engine makes`);
      count[e.call] = (count[e.call] ?? 0) + 1;
    }
    for (const f of ['state', 'choice', 'reason']) {
      if (isText(e[f]) && words(e[f]) > WORD_LIMIT[f]) bad(at, `${f} has ${words(e[f])} words; at most ${WORD_LIMIT[f]}`);
    }
    // Each example is rendered on one line as "Given: … Good choice: … Why: …".
    for (const f of ['state', 'choice', 'reason']) if (isText(e[f]) && /\n/.test(e[f])) bad(at, `${f} contains a line break`);
  });
  for (const [call, min] of Object.entries(EXAMPLE_MINIMUM)) {
    if ((count[call] ?? 0) < min) bad(where, `${call} has ${count[call] ?? 0} example(s); at least ${min} needed`);
  }
  // The engine sends the first three of a type: they should not all teach the same answer.
  for (const call of Object.keys(EXAMPLE_MINIMUM)) {
    const firstThree = data.examples.filter((e) => e && e.call === call).slice(0, 3).map((e) => e.choice);
    if (firstThree.length === 3 && new Set(firstThree).size === 1) bad(where, `the first three ${call} examples all give the same choice ("${firstThree[0]}")`);
  }
  return data.examples.length;
}

const seenIds = new Set();
let total = 0;
const perFile = [];
for (const call of CASE_CALLS) {
  const n = checkCaseFile(call, seenIds);
  total += n;
  perFile.push(`${call} ${n}`);
}
// Any other JSON file in this folder is unexpected: the harness reads one file per call type.
for (const f of readdirSync(HERE)) {
  if (f.endsWith('.json') && !CASE_CALLS.includes(f.replace(/\.json$/, ''))) bad(f, 'unexpected file: not one of the ten call types');
}
const exampleCount = checkExamples();

if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`ok: ${total} cases in ${CASE_CALLS.length} files (${perFile.join(', ')}); ${exampleCount} worked examples.`);
