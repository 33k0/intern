// Measured facts about a saved run, from its note data. No opinions: this is what an agent (or a person)
// may report about a piece without having heard it.
//   npm run audit -- <run name in eval/results>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhraseScore, ServerEvent } from '../shared/types.ts';

const name = process.argv[2];
if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
  console.error('usage: npm run audit -- <run name>   (a folder in eval/results)');
  process.exit(1);
}
const events = JSON.parse(readFileSync(join('eval/results', name, 'events.json'), 'utf8')) as ServerEvent[];
const scores = events.flatMap((e) => (e.type === 'phrase' ? [e.score] : []));
const rules = events.flatMap((e) => (e.type === 'rules' ? [e.rules] : []))[0];
const plan = events.flatMap((e) => (e.type === 'plan' ? [e.plan] : [])).pop();
const session = events.flatMap((e) => (e.type === 'session' ? [e] : []))[0];
if (!scores.length || !rules || !plan) {
  console.error(`run "${name}" has no finished piece in it`);
  process.exit(1);
}
const DYN = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitch = (m: number) => `${NOTE[m % 12]}${Math.floor(m / 12) - 1}`;
const secondsOf = (s: PhraseScore) => (s.beats * 60) / s.bpm;
const insts = (s: PhraseScore) => [...new Set(s.notes.map((n) => n.inst))].sort();
const top = (s: PhraseScore) => Math.max(0, ...s.notes.filter((n) => n.layer === 'melody').map((n) => n.midi));
const total = scores.reduce((t, s) => t + secondsOf(s), 0);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

console.log(`RUN      ${name}`);
console.log(`PROMPT   "${session?.prompt ?? ''}"${session?.standin ? '   (offline stand-in, not live Drex)' : ''}`);
console.log(`RULES    ${rules.styleName}${rules.groove ? ` (${rules.groove})` : ''}, ${rules.keyName}, ${rules.bpm} BPM, ${rules.meter}; ${clock(total)}, ${scores.length} phrases`);
console.log(`PALETTE  ${rules.palette.length} instruments: ${rules.palette.join(', ')}`);
console.log(`CLIMAX   phrase ${plan.climaxPhrase + 1} of ${plan.totalPhrases}${plan.climaxArrival ? `, arriving as ${plan.climaxArrival.replace(/_/g, ' ')}` : ''}`);
console.log('\nSECTIONS (start, part, phrases, loudness, instruments)');
let t = 0;
for (const s of plan.sections) {
  const ps = scores.filter((p) => p.index >= s.phrases[0] && p.index <= s.phrases[1]);
  if (!ps.length) continue;
  const all = [...new Set(ps.flatMap(insts))].sort();
  console.log(`  ${clock(t).padStart(5)}  ${(s.part ?? s.role).padEnd(11)} ${String(s.phrases[0] + 1).padStart(2)}-${String(s.phrases[1] + 1).padEnd(2)}  ${ps.map((p) => DYN[p.mix.dynamics]).join(' ').padEnd(14)} ${all.length}: ${all.join(', ')}`);
  t += ps.reduce((x, p) => x + secondsOf(p), 0);
}
const bars = scores.map((s) => s.bars);
const tops = scores.map(top);
const c = scores.findIndex((s) => s.index === plan.climaxPhrase);
const used = new Set(scores.flatMap(insts));
console.log('\nFACTS');
console.log(`  phrase lengths in bars: ${bars.join(' ')}`);
console.log(`  instruments per phrase: ${scores.map((s) => insts(s).length).join(' ')}`);
console.log(`  instruments used: ${used.size} of ${rules.palette.length} in the palette${rules.palette.filter((i) => !used.has(i)).length ? `; never used: ${rules.palette.filter((i) => !used.has(i)).join(', ')}` : ''}`);
if (c >= 0) {
  const before = c > 0 ? Math.max(...tops.slice(0, c)) : 0;
  console.log(`  highest melody note at the climax: ${pitch(tops[c])}; highest before it: ${before ? pitch(before) : 'none'} (${tops[c] > before ? 'the climax is the highest point so far' : 'an earlier phrase goes as high or higher'})`);
  console.log(`  at the climax: ${insts(scores[c]).length} instruments, ${DYN[scores[c].mix.dynamics]}; the phrase before: ${c > 0 ? `${insts(scores[c - 1]).length} instruments, ${DYN[scores[c - 1].mix.dynamics]}` : 'none'}`);
}
const marks = (word: string) => scores.filter((s) => s.display.lineage.includes(word)).length;
console.log(`  phrases that begin with a pickup: ${marks('pickup')}; that enter after the downbeat: ${marks('after the downbeat')}; dovetailed joins: ${marks('dovetailed')}`);
if (plan.sections.some((s) => s.part)) console.log(`  phrases where the chorus returns: ${marks('the chorus again')}`);
console.log(`  Drex calls: ${events.filter((e) => e.type === 'call').length}`);
