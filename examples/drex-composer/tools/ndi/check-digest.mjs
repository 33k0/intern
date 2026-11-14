#!/usr/bin/env node
// check-digest.mjs — validate the context pack.
//
//   node tools/ndi/check-digest.mjs                       # checks context-pack/digest.json
//   node tools/ndi/check-digest.mjs path/to/digest.ndi.json
//
// Checks every rule for: required fields, valid topic and call strings, <= 35 words, unique id,
// id prefix == topic, source/own consistency. For the curated digest it also verifies each
// sourced rule's evidence quote (digest.evidence.json) really sits in books/<book>/text.txt on
// the page the ref cites. Also parses the other JSON files of the pack. Prints rule counts per
// topic and per call type. Exits 1 on any error.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK = join(ROOT, 'context-pack');

export const TOPICS = ['melody', 'phrase_structure', 'cadences', 'tension_release', 'developing_variation', 'departure_return', 'voice_leading', 'harmony', 'orchestration', 'dynamics_pacing', 'form'];
export const CALLS = ['setup', 'plan', 'theme_draft', 'theme_judge', 'phrase_direction', 'voice_leading', 'phrase_judge', 'orchestration', 'hold', 'ending'];
export const BOOKS = ['rimsky-orchestration', 'goetschius-melody', 'tchaikovsky-harmony', 'prout-form'];
export const MAX_WORDS = 35;
export const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/** returns a list of error strings for one rule (empty = valid) */
export function ruleErrors(r, seen = new Set()) {
  const e = [];
  const id = typeof r?.id === 'string' ? r.id : '(no id)';
  if (typeof r?.id !== 'string' || !/^[a-z_]+\.[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id)) e.push(`${id}: id must look like topic.slug`);
  else if (seen.has(r.id)) e.push(`${id}: duplicate id`);
  seen.add(r?.id);
  if (!TOPICS.includes(r?.topic)) e.push(`${id}: invalid topic ${JSON.stringify(r?.topic)}`);
  else if (typeof r.id === 'string' && r.id.split('.')[0] !== r.topic) e.push(`${id}: id prefix does not match topic ${r.topic}`);
  if (typeof r?.text !== 'string' || !r.text.trim()) e.push(`${id}: missing text`);
  else if (wordCount(r.text) > MAX_WORDS) e.push(`${id}: text has ${wordCount(r.text)} words (max ${MAX_WORDS})`);
  if (!Array.isArray(r?.calls) || r.calls.length === 0) e.push(`${id}: calls must be a non-empty array`);
  else {
    for (const c of r.calls) if (!CALLS.includes(c)) e.push(`${id}: invalid call ${JSON.stringify(c)}`);
    if (new Set(r.calls).size !== r.calls.length) e.push(`${id}: duplicate call`);
  }
  if (!('source' in (r ?? {}))) e.push(`${id}: missing source (use null with "own": true for own rules)`);
  else if (r.source === null) { if (r.own !== true) e.push(`${id}: null source requires "own": true`); }
  else {
    if (r.own) e.push(`${id}: "own" rule must have null source`);
    if (!BOOKS.includes(r.source?.book)) e.push(`${id}: unknown source.book ${JSON.stringify(r.source?.book)}`);
    if (typeof r.source?.ref !== 'string' || !r.source.ref.trim()) e.push(`${id}: missing source.ref`);
  }
  return e;
}

function checkEvidence(rules, errors) {
  const evPath = join(PACK, 'digest.evidence.json');
  if (!existsSync(evPath)) { console.log('  (no digest.evidence.json — skipping quote verification)'); return; }
  const ev = JSON.parse(readFileSync(evPath, 'utf8')).evidence;
  const texts = {};
  let ok = 0;
  for (const r of rules) {
    if (!r.source) continue;
    const x = ev[r.id];
    if (!x) { errors.push(`${r.id}: no evidence quote`); continue; }
    if (x.book !== r.source.book || x.ref !== r.source.ref) { errors.push(`${r.id}: evidence book/ref differs from rule source`); continue; }
    texts[x.book] ??= readFileSync(join(PACK, 'books', x.book, 'text.txt'), 'utf8');
    const t = texts[x.book];
    const i = t.indexOf(x.quote);
    if (i < 0) { errors.push(`${r.id}: evidence quote not found in ${x.book}/text.txt`); continue; }
    const marker = (t.slice(0, i).match(/\[p\. (\w+)\]/g) || []).pop();
    const want = (r.source.ref.match(/\bpp?\. ?(\d+)/) || [])[1];
    if (!want) { errors.push(`${r.id}: ref has no page number`); continue; }
    if (marker !== `[p. ${want}]`) { errors.push(`${r.id}: quote is under ${marker}, ref says p. ${want}`); continue; }
    ok++;
  }
  console.log(`  evidence: ${ok} sourced rules verified against the book text (quote present, on the cited page)`);
}

function main() {
  const arg = process.argv[2];
  const file = arg ? resolve(arg) : join(PACK, 'digest.json');
  const isCurated = file === join(PACK, 'digest.json');
  const errors = [];
  const warnings = [];

  let digest;
  try { digest = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { console.error(`cannot parse ${file}: ${err.message}`); process.exit(1); }
  console.log(`checking ${file}`);
  if (digest.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(digest.rules)) { console.error('rules must be an array'); process.exit(1); }

  const seen = new Set();
  for (const r of digest.rules) errors.push(...ruleErrors(r, seen));

  const perTopic = Object.fromEntries(TOPICS.map((t) => [t, 0]));
  const perCall = Object.fromEntries(CALLS.map((c) => [c, 0]));
  const perBook = {};
  let own = 0, words = 0;
  for (const r of digest.rules) {
    if (r.topic in perTopic) perTopic[r.topic]++;
    for (const c of r.calls ?? []) if (c in perCall) perCall[c]++;
    if (r.source === null) own++; else perBook[r.source?.book] = (perBook[r.source?.book] ?? 0) + 1;
    words += wordCount(r.text ?? '');
  }
  const n = digest.rules.length;
  console.log(`\n  ${n} rules, ${own} own (${((100 * own) / Math.max(n, 1)).toFixed(1)}%), average ${(words / Math.max(n, 1)).toFixed(1)} words`);
  console.log('\n  per topic');
  for (const t of TOPICS) console.log(`    ${t.padEnd(22)} ${perTopic[t]}`);
  console.log('\n  per call type            rules   words');
  for (const c of CALLS) {
    const w = digest.rules.filter((r) => r.calls?.includes(c)).reduce((a, r) => a + wordCount(r.text ?? ''), 0);
    console.log(`    ${c.padEnd(22)} ${String(perCall[c]).padStart(3)}   ${String(w).padStart(5)}`);
  }
  console.log('\n  per source');
  for (const [b, k] of Object.entries(perBook)) console.log(`    ${String(b).padEnd(22)} ${k}`);
  console.log(`    ${'(own)'.padEnd(22)} ${own}\n`);

  // a partial NDI run (one book) legitimately lacks topics; the curated digest must cover all
  for (const t of TOPICS) if (perTopic[t] === 0) (isCurated ? errors : warnings).push(`topic ${t} has no rules`);
  for (const c of CALLS) if (perCall[c] < 10 || perCall[c] > 25) warnings.push(`call ${c} has ${perCall[c]} rules (target 10-25)`);
  if (n < 120 || n > 180) warnings.push(`${n} rules (target roughly 120-180)`);
  if (own / Math.max(n, 1) >= 0.25) errors.push(`own rules are ${((100 * own) / n).toFixed(1)}% (must stay under 25%)`);

  if (isCurated) {
    checkEvidence(digest.rules, errors);
    for (const f of ['style-sheets.json', 'books/sources.json', 'digest.evidence.json']) {
      const p = join(PACK, f);
      if (!existsSync(p)) { warnings.push(`${f} is missing`); continue; }
      try { JSON.parse(readFileSync(p, 'utf8')); console.log(`  ${f}: parses`); } catch (err) { errors.push(`${f}: ${err.message}`); }
    }
    const ssPath = join(PACK, 'style-sheets.json');
    if (existsSync(ssPath)) {
      try {
        const ss = JSON.parse(readFileSync(ssPath, 'utf8'));
        const sheets = Array.isArray(ss) ? ss : ss.sheets;
        const INSTR = ['piano', 'violins', 'violins2', 'violas', 'celli', 'basses', 'solo_violin', 'flute', 'oboe', 'clarinet', 'horn', 'harp', 'timpani', 'bass_drum', 'cymbal', 'drumkit', 'celesta', 'glockenspiel', 'vibraphone', 'sub', 'pad', 'pluck', 'kick808', 'noise', 'keys', 'lead', 'supersaw', 'synth_bass', 'bell', 'brass'];
        for (const id of ['bittersweet_orchestral', 'beat_driven', 'playful']) if (!sheets.some((s) => s.id === id)) errors.push(`style sheet ${id} missing`);
        for (const s of sheets) {
          if (wordCount(s.summary ?? '') > 40) errors.push(`style ${s.id}: summary over 40 words`);
          if (!Array.isArray(s.traits) || s.traits.length > 14) errors.push(`style ${s.id}: traits must be an array of at most 14`);
          const d = s.defaults ?? {};
          if (!(Array.isArray(d.tempoRange) && d.tempoRange.length === 2 && d.tempoRange[0] <= d.tempoRange[1])) errors.push(`style ${s.id}: bad tempoRange`);
          for (const k of ['meters', 'modes', 'harmonicLanguage', 'typicalInstruments']) if (!Array.isArray(d[k]) || !d[k].length) errors.push(`style ${s.id}: defaults.${k} missing`);
          if (typeof d.soundWorld !== 'string') errors.push(`style ${s.id}: defaults.soundWorld missing`);
          for (const i of d.typicalInstruments ?? []) if (!INSTR.includes(i)) errors.push(`style ${s.id}: unknown instrument id ${i}`);
          if (!Array.isArray(s.avoid)) errors.push(`style ${s.id}: avoid missing`);
        }
        console.log(`  style-sheets.json: ${sheets.length} sheets checked`);
      } catch { /* parse error already reported */ }
    }
  }

  for (const w of warnings) console.log(`  warning: ${w}`);
  if (errors.length) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('\nOK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
