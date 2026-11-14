#!/usr/bin/env node
// render-digest-md.mjs — write context-pack/digest.md from context-pack/digest.json
// (the same rules, grouped by topic, with their references, for people to read).
//
//   node tools/ndi/render-digest-md.mjs [digest.json] [out.md]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PACK } from './books.mjs';
import { TOPICS, CALLS } from './check-digest.mjs';

const inPath = process.argv[2] ? resolve(process.argv[2]) : join(PACK, 'digest.json');
const outPath = process.argv[3] ? resolve(process.argv[3]) : join(PACK, 'digest.md');
const digest = JSON.parse(readFileSync(inPath, 'utf8'));
const sources = JSON.parse(readFileSync(join(PACK, 'books', 'sources.json'), 'utf8')).books;
const short = {
  'rimsky-orchestration': 'Rimsky-Korsakov, *Principles of Orchestration*',
  'goetschius-melody': 'Goetschius, *Exercises in Melody-Writing*',
  'tchaikovsky-harmony': 'Tchaikovsky, *Guide to the Practical Study of Harmony*',
  'prout-form': 'Prout, *Musical Form*',
};
const TITLES = {
  melody: 'Melody', phrase_structure: 'Phrase structure', cadences: 'Cadences', tension_release: 'Tension and release',
  developing_variation: 'Developing variation', departure_return: 'Departure and return', voice_leading: 'Voice leading', harmony: 'Harmony',
  orchestration: 'Orchestration', dynamics_pacing: 'Dynamics and pacing', form: 'Form',
};

const rules = digest.rules;
const own = rules.filter((r) => r.source === null).length;
const lines = [];
lines.push('# Theory digest', '');
lines.push(`${rules.length} rules for the composer engine, each at most 35 words. ${rules.length - own} come from four public-domain books and carry the page or section where the idea is stated; ${own} (${((100 * own) / rules.length).toFixed(0)}%) are marked **own**: general practice the 1890s–1920s books do not cover, with no book reference.`, '');
lines.push('Generated from `digest.json` by `tools/ndi/render-digest-md.mjs`; edit the JSON, not this file. Page numbers are printed page numbers, as marked by `[p. N]` lines in `books/<slug>/text.txt`. The exact sentence each sourced rule rests on is in `digest.evidence.json`.', '');
lines.push('## Sources', '');
for (const b of sources) lines.push(`- \`${b.slug}\`: ${b.author}, *${b.title.split(':')[0].split(',')[0]}* (${b.year}). ${b.sourceUrl}`);
lines.push('', '## Rules per call type', '', '| Call | Rules |', '| --- | ---: |');
for (const c of CALLS) lines.push(`| \`${c}\` | ${rules.filter((r) => r.calls.includes(c)).length} |`);
lines.push('');
for (const t of TOPICS) {
  const rs = rules.filter((r) => r.topic === t);
  lines.push(`## ${TITLES[t]} (${rs.length})`, '');
  for (const r of rs) {
    const src = r.source ? `${short[r.source.book] ?? r.source.book}, ${r.source.ref}` : '**own** (no book source)';
    lines.push(`- **\`${r.id}\`**: ${r.text}  `, `  ${src} · calls: ${r.calls.map((c) => `\`${c}\``).join(', ')}`);
  }
  lines.push('');
}
writeFileSync(outPath, lines.join('\n'));
console.log(`${outPath}: ${rules.length} rules, ${TOPICS.length} topics`);
