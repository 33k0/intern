// Compose a whole piece headlessly and print what Drex chose. No audio: this is for checking the engine.
//   npm run compose -- "rain on a tin roof at 3am" [--seed 7] [--json out.json] [--midi out.mid] [--verbose]
// DREX_PICKER=random swaps Drex for a random picker (the control for the blind listening test).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServerEvent } from '../shared/types.ts';
import { phraseSeconds } from '../shared/types.ts';
import { Session } from '../server/session.ts';
import { scoresToMidi } from './midi.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const verbose = args.includes('--verbose') ? (args.splice(args.indexOf('--verbose'), 1), true) : false;
const seed = flag('seed');
const json = flag('json');
const midi = flag('midi');
const prompt = args.join(' ') || 'rain on a tin roof at 3am, missing someone';
process.env.STANDIN_LATENCY_MS ??= '0-0';

const events: ServerEvent[] = [];
const callTypes: Record<string, number> = {};
const t0 = Date.now();
const session = new Session({
  prompt, seed: seed ? Number(seed) : undefined, paced: false,
  send: (e) => {
    events.push(e);
    if (e.type === 'call') callTypes[e.call.callType] = (callTypes[e.call.callType] ?? 0) + 1;
    if (e.type === 'rules') console.log('RULES  ', JSON.stringify(e.rules));
    if (e.type === 'plan') console.log(e.plan.revised ? 'REVISED' : 'PLAN   ', e.plan.sections.map((s) => `${s.role}:${s.tension}${s.departure ? '*' : ''}[${s.phrases[0] + 1}-${s.phrases[1] + 1} ${s.keyName}]`).join('  '), `climax=${e.plan.climaxPhrase + 1}`);
    if (e.type === 'backdrop') console.log('BACKDROP', e.id);
    if (e.type === 'theme_drafts') console.log(`THEME ${e.themeId} round ${e.round}:`, e.verdict.picked ?? `REJECTED (${e.verdict.reason})`);
    if (e.type === 'theme') console.log(`THEME ${e.theme.id}`, e.theme.notation, `(${e.theme.contour}, ${e.theme.kind})`);
    if (e.type === 'phrase_drafts' && (verbose || !e.verdict.picked)) console.log(`  phrase ${e.phrase + 1} round ${e.round}:`, e.verdict.picked ?? `REJECTED: ${e.verdict.reason}`);
    if (e.type === 'phrase') {
      const s = e.score;
      const layers = s.display.layers.filter((l) => l.inst).map((l) => `${l.role}=${l.inst}`).join(' ');
      console.log(`P${String(s.index + 1).padStart(2)} ${s.role.padEnd(11)} t=${s.display.tension} ${s.display.key.padEnd(12)} ${s.display.chords.join(' ').padEnd(34)} ${s.notes.length} notes  ${layers}`);
      console.log(`      ${s.display.lineage}`);
      if (verbose) console.log(`      ${s.display.notation}`);
    }
    if (e.type === 'error') console.error('ERROR', e.message);
  },
});
await session.run();
const scores = events.flatMap((e) => (e.type === 'phrase' ? [e.score] : []));
const seconds = scores.reduce((s, x) => s + phraseSeconds(x), 0);
console.log(`\n${scores.length} phrases, ${Math.round(seconds)} s of music, ${session.gw.calls} calls (${(session.gw.calls / Math.max(1, scores.length)).toFixed(1)} per phrase), ${session.rejects} rejected rounds, ${Date.now() - t0} ms, seed ${session.seed}`);
console.log('calls by type:', callTypes);
if (midi) {
  mkdirSync(dirname(midi), { recursive: true });
  writeFileSync(midi, scoresToMidi(scores));
  console.log('wrote', midi);
}
if (json) {
  mkdirSync(dirname(json), { recursive: true });
  writeFileSync(json, JSON.stringify(events));
  console.log('wrote', json);
}
