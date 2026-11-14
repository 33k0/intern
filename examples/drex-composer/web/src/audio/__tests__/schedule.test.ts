// Headless checks for the engine's pure logic (no Web Audio, no Tone):
//   npx tsx --test web/src/audio/__tests__/schedule.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { beatToSec, phraseSeconds } from '../../../../shared/types.ts';
import type { Articulation, MixState, NoteEvent, PhraseScore } from '../../../../shared/types.ts';
import { demoPalette, demoScores } from '../demoScore.ts';
import { instrumentFiles, isSynthId, joinUrl, normalizeManifest, sampleSourceId } from '../manifest.ts';
import type { InstrumentDef } from '../manifest.ts';
import { DEFAULT_MIX, DUCK_GAIN, curveLevel, delayTimeSec, mergeMix, mixToParams } from '../mixmap.ts';
import { humanize, jitterMs, pedalOffBeats, planPhrase } from '../plan.ts';
import { hashSeed, mulberry32 } from '../prng.ts';
import {
  RoundRobin, decayRelease, equalPower, grainOffset, grainTiming, keyCompDb, layerGains, layerMakeupDb, legatoOffsetSec, panFor, pianoRelease,
  pickKey, pickKeyInRange, pickLayer, pickSwell, resolveArticulation, stealIndex, sustainEnvelope, velocityCutoffHz, velocityGain, voiceMode,
} from '../selection.ts';
import { chainStarts, firstAtOrAfter, holdResumeTime, secToBeat } from '../timeline.ts';

const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

function score(partial: Partial<PhraseScore> = {}): PhraseScore {
  return {
    index: 0, section: 0, role: 'statement', bars: 2, beatsPerBar: 4, beats: 8, bpm: 70,
    notes: [], pedal: [], mix: { ...DEFAULT_MIX }, holdChord: [],
    display: { key: 'D minor', notation: '', lineage: '', chords: [], layers: [], tension: 3 },
    ...partial,
  };
}
function note(partial: Partial<NoteEvent> = {}): NoteEvent {
  return { t: 0, dur: 1, midi: 60, vel: 0.6, inst: 'violins', art: 'sustain', layer: 'melody', ...partial };
}

// ───────────────────────────── Scheduling arithmetic ─────────────────────────────

test('phrases chain back to back: start(n+1) = start(n) + phraseSeconds(n)', () => {
  const a = score({ beats: 8, bpm: 70 });
  const b = score({ beats: 8, bpm: 70, ritardando: { fromBeat: 5, toBpm: 48 } });
  const c = score({ beats: 6, bpm: 96 });
  const starts = chainStarts(10.12, [a, b, c]);
  near(starts[0], 10.12);
  near(starts[1], 10.12 + (8 * 60) / 70);
  near(starts[2], starts[1] + phraseSeconds(b));
  // the ritardando makes the second phrase longer than its strict-tempo length
  assert.ok(phraseSeconds(b) > (8 * 60) / 70);
  near(starts[2] + (6 * 60) / 96, chainStarts(starts[2], [c, c])[1]);
});

test('hold resume lands on the next whole beat of a grid that started at the phrase end', () => {
  const spb = 60 / 70;
  const origin = 100;
  // a phrase arriving 2.3 beats into the hold starts on beat 3
  let r = holdResumeTime(origin, spb, origin + 2.3 * spb);
  assert.equal(r.beats, 3);
  near(r.time, origin + 3 * spb);
  // exactly on a beat stays on that beat
  r = holdResumeTime(origin, spb, origin + 4 * spb);
  assert.equal(r.beats, 4);
  near(r.time, origin + 4 * spb);
  // just past a beat goes to the next
  r = holdResumeTime(origin, spb, origin + 4 * spb + 0.001);
  assert.equal(r.beats, 5);
  // arrived before the phrase even ended: the downbeat itself, no hold
  r = holdResumeTime(origin, spb, origin - 0.05);
  assert.equal(r.beats, 0);
  near(r.time, origin);
  // minutes later the grid is still aligned
  r = holdResumeTime(origin, spb, origin + 183.21);
  near((r.time - origin) / spb, Math.round((r.time - origin) / spb), 1e-9);
  assert.ok(r.time >= origin + 183.21 && r.time < origin + 183.21 + spb);
});

test('secToBeat inverts beatToSec, with and without a ritardando (and an accelerando)', () => {
  const cases = [score(), score({ ritardando: { fromBeat: 5, toBpm: 48 } }), score({ ritardando: { fromBeat: 0, toBpm: 30 } }), score({ ritardando: { fromBeat: 2, toBpm: 120 } })];
  for (const s of cases) {
    for (const beat of [0, 0.5, 3, 5, 5.01, 6.5, 7.99, 8, 9.5]) near(secToBeat(s, beatToSec(s, beat)), beat, 1e-6);
  }
});

test('firstAtOrAfter finds the resume cursor after a seek', () => {
  const xs = [0, 0.5, 0.5, 1.2, 3];
  assert.equal(firstAtOrAfter(xs, (x) => x, -1), 0);
  assert.equal(firstAtOrAfter(xs, (x) => x, 0.5), 1);
  assert.equal(firstAtOrAfter(xs, (x) => x, 0.51), 3);
  assert.equal(firstAtOrAfter(xs, (x) => x, 9), 5);
});

// ───────────────────────────── Phrase plan ─────────────────────────────

test('plan: beats become seconds, ritardando included, events sorted', () => {
  const s = score({
    ritardando: { fromBeat: 4, toBpm: 35 },
    notes: [note({ t: 6, dur: 2 }), note({ t: 0, dur: 1 }), note({ t: 3, dur: 1, inst: 'sub', layer: 'bass' })],
  });
  const p = planPhrase(s, { humanize: false });
  near(p.seconds, phraseSeconds(s));
  assert.deepEqual(p.notes.map((x) => x.note.t), [0, 3, 6]);
  near(p.notes[2].onSec, beatToSec(s, 6));
  near(p.notes[2].offSec as number, beatToSec(s, 8));
  near(p.notes[2].durSec, beatToSec(s, 8) - beatToSec(s, 6));
  assert.ok(p.notes[2].durSec > (2 * 60) / 70, 'a note inside the ritardando lasts longer');
});

test('humanise: deterministic, within range, none on sub / kick808, less on drums and pulse', () => {
  const kinds: NoteEvent[] = [
    note({ inst: 'violins' }), note({ inst: 'piano' }), note({ inst: 'drumkit', midi: 38, art: 'hit', layer: 'pulse' }),
    note({ inst: 'harp', layer: 'pulse' }), note({ inst: 'sub', layer: 'bass' }), note({ inst: 'kick808', layer: 'pulse' }),
  ];
  assert.equal(jitterMs(kinds[4]), 0);
  assert.equal(jitterMs(kinds[5]), 0);
  assert.ok(jitterMs(kinds[2]) < 4 && jitterMs(kinds[3]) <= 4);
  for (const k of kinds) {
    const r = jitterMs(k);
    assert.ok(r <= 10);
    if (!isSynthId(k.inst) && k.inst !== 'drumkit' && k.layer !== 'pulse') assert.ok(r >= 4);
    let maxDt = 0;
    for (let i = 0; i < 400; i++) {
      const h = humanize(k, 3, i, 1);
      assert.deepEqual(h, humanize(k, 3, i, 1), 'same seed, same result');
      assert.ok(Math.abs(h.dtSec) <= r / 1000 + 1e-12);
      assert.ok(h.vel >= k.vel * 0.94 - 1e-9 && h.vel <= k.vel * 1.06 + 1e-9);
      assert.ok(Math.abs(h.detuneCents) <= 3);
      maxDt = Math.max(maxDt, Math.abs(h.dtSec));
    }
    if (r > 0) assert.ok(maxDt > (r / 1000) * 0.8, 'the jitter range is actually used');
    else assert.equal(maxDt, 0);
  }
  // a different seed gives a different performance
  assert.notDeepEqual(humanize(kinds[0], 3, 7, 1), humanize(kinds[0], 3, 7, 2));
  // whole plans repeat exactly
  const a = planPhrase(demoScores[0], { seed: 5 });
  const b = planPhrase(demoScores[0], { seed: 5 });
  assert.deepEqual(a.notes.map((x) => [x.onSec, x.vel, x.detuneCents]), b.notes.map((x) => [x.onSec, x.vel, x.detuneCents]));
});

test('pedal: note-offs are deferred to the next pedal lift', () => {
  const marks = [{ t: 0, down: true }, { t: 4, down: false }, { t: 4.1, down: true }, { t: 7.5, down: false }];
  const r = pedalOffBeats(
    [{ t: 0, dur: 1 }, { t: 3.5, dur: 1 }, { t: 4.05, dur: 0.02 }, { t: 5, dur: 1 }, { t: 7.6, dur: 0.3 }, { t: 3, dur: 1 }],
    marks,
  );
  assert.deepEqual(r.off.map((x) => (x === null ? null : +x.toFixed(9))), [
    4, // ends at 1 with the pedal down → held to the lift at 4
    7.5, // ends at 4.5, after the re-pedal at 4.1 → held to 7.5
    4.07, // ends in the gap while the pedal is up → released by the key
    7.5,
    7.9, // after the last lift: plain note-off
    4, // ends exactly at the lift: released there
  ]);
  assert.equal(r.endsDown, false);
});

test('pedal: still down at the end of the phrase carries (null); inherited pedal state is honoured', () => {
  const carry = pedalOffBeats([{ t: 6, dur: 1 }, { t: 1, dur: 1 }], [{ t: 0, down: true }, { t: 2, down: false }, { t: 5, down: true }]);
  assert.deepEqual(carry.off, [null, 2]);
  assert.equal(carry.endsDown, true);
  // pedal already down from the previous phrase, lifted at beat 1
  const inherited = pedalOffBeats([{ t: 0, dur: 0.5 }, { t: 2, dur: 0.5 }], [{ t: 1, down: false }], true);
  assert.deepEqual(inherited.off, [1, 2.5]);
  // no marks at all
  assert.deepEqual(pedalOffBeats([{ t: 0, dur: 1 }], []).off, [1]);
  assert.deepEqual(pedalOffBeats([{ t: 0, dur: 1 }], [], true), { off: [null], endsDown: true });
});

test('plan: only the piano is pedalled; pedal state changes and the first lift are reported', () => {
  const s = score({
    notes: [note({ inst: 'piano', t: 0, dur: 1 }), note({ inst: 'celli', t: 0, dur: 1 }), note({ inst: 'piano', t: 7, dur: 0.5 })],
    pedal: [{ t: 0, down: true }, { t: 0.5, down: true }, { t: 4, down: false }, { t: 4.1, down: true }],
  });
  const p = planPhrase(s, { humanize: false });
  const [piano0, celli, piano1] = [p.notes.find((x) => x.i === 0), p.notes.find((x) => x.i === 1), p.notes.find((x) => x.i === 2)];
  near(piano0?.offSec as number, beatToSec(s, 4));
  near(celli?.offSec as number, beatToSec(s, 1));
  assert.equal(piano1?.offSec, null, 'held past the phrase end by the pedal');
  assert.equal(piano0?.pedalAtOnset, true);
  assert.equal(p.pedalEndsDown, true);
  near(p.firstPedalUpSec as number, beatToSec(s, 4));
  assert.deepEqual(p.pedal.map((m) => m.down), [true, false, true], 'the redundant second "down" makes no noise');
});

test('plan: kicks for the sidechain, cutAtBeat drops later notes, fade range, hold bus lookup', () => {
  const s = score({
    cutAtBeat: 6,
    fadeOut: { fromBeat: 2, toBeat: 6 },
    notes: [
      note({ inst: 'drumkit', midi: 36, art: 'hit', layer: 'pulse', t: 0 }), note({ inst: 'drumkit', midi: 38, art: 'hit', layer: 'pulse', t: 1 }),
      note({ inst: 'kick808', midi: 36, layer: 'pulse', t: 2 }), note({ inst: 'celli', layer: 'bass', t: 5.5, dur: 2 }), note({ inst: 'celli', layer: 'inner', t: 6, dur: 1 }),
    ],
  });
  const p = planPhrase(s, { humanize: false });
  assert.deepEqual(p.kickSecs.map((x) => +x.toFixed(6)), [0, +beatToSec(s, 2).toFixed(6)]);
  assert.equal(p.notes.length, 4, 'the note at the cut beat is not played');
  near(p.cutSec as number, beatToSec(s, 6));
  assert.deepEqual(p.fade, { fromSec: beatToSec(s, 2), toSec: beatToSec(s, 6) });
  assert.equal(p.layerOfInst.get('celli'), 'bass');
});

test('plan: legato is detected for a slurred line, not for the first note, repeats or the piano', () => {
  const s = score({
    notes: [
      note({ inst: 'celli', t: 0, dur: 2, midi: 57 }), note({ inst: 'celli', t: 2, dur: 2, midi: 58 }), note({ inst: 'celli', t: 4, dur: 1, midi: 58 }),
      note({ inst: 'celli', t: 6, dur: 1, midi: 55 }), note({ inst: 'piano', t: 0, dur: 2, midi: 60 }), note({ inst: 'piano', t: 2, dur: 2, midi: 62 }),
    ],
  });
  const p = planPhrase(s, { humanize: false });
  const legato = (i: number): boolean => p.notes.find((x) => x.i === i)?.legato as boolean;
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(legato), [false, true, false, false, false, false]);
});

// ───────────────────────────── Sample selection ─────────────────────────────

test('pickKey: nearest sampled key and the rate that reaches the pitch', () => {
  const keys = [48, 51, 54, 57, 60];
  assert.deepEqual(pickKey(keys, 54), { key: 54, semis: 0, rate: 1 });
  let k = pickKey(keys, 55);
  assert.equal(k?.key, 54);
  near(k?.rate as number, Math.pow(2, 1 / 12));
  k = pickKey(keys, 59);
  assert.equal(k?.key, 60);
  near(k?.rate as number, Math.pow(2, -1 / 12));
  // outside the sampled range: the end key, shifted as far as needed
  assert.equal(pickKey(keys, 30)?.key, 48);
  near(pickKey(keys, 72)?.rate as number, 2);
  assert.equal(pickKey([], 60), null);
  // pseudo-note instruments are never pitch-shifted
  assert.deepEqual(pickKey([36, 38, 42], 40, 0, { unpitched: true }), { key: 38, semis: 2, rate: 1 });
});

test('pickKey: equally near neighbours alternate (pseudo round robin); aliases take the other key', () => {
  const keys = [48, 52, 56];
  const seq = [0, 1, 2, 3].map((c) => pickKey(keys, 50, c)?.key);
  assert.deepEqual(seq, [48, 52, 48, 52]);
  near(pickKey(keys, 50, 0)?.rate as number, Math.pow(2, 2 / 12));
  near(pickKey(keys, 50, 1)?.rate as number, Math.pow(2, -2 / 12));
  // not a tie: no alternation
  assert.deepEqual([0, 1].map((c) => pickKey(keys, 49, c)?.key), [48, 48]);
  // violins2 with a single take prefers the second-nearest key, if it is close enough
  assert.equal(pickKey([55, 58, 61], 58, 0, { preferAlternate: true })?.key, 55);
  assert.equal(pickKey([40, 58, 70], 58, 0, { preferAlternate: true })?.key, 58);
});

test('velocity layers: equal-power dynamic crossfade for sustains, one layer for one-shots', () => {
  const velMaxes = [0.4, 1];
  // centres are 0.2 and 0.7
  assert.deepEqual(layerGains(velMaxes, 0.1, true), [{ layer: 0, gain: 1 }]);
  assert.deepEqual(layerGains(velMaxes, 0.9, true), [{ layer: 1, gain: 1 }]);
  const mid = layerGains(velMaxes, 0.45, true);
  assert.equal(mid.length, 2);
  near(mid[0].gain, Math.SQRT1_2, 1e-9);
  near(mid[1].gain, Math.SQRT1_2, 1e-9);
  for (const v of [0.21, 0.3, 0.5, 0.69]) {
    const g = layerGains(velMaxes, v, true);
    near(g.reduce((s, x) => s + x.gain * x.gain, 0), 1, 0.002); // constant power (tiny layers are dropped)
  }
  const lo = layerGains(velMaxes, 0.3, true);
  assert.ok(lo[0].gain > lo[1].gain, 'nearer the soft layer, the soft layer dominates');
  // one-shots pick: first layer whose velMax covers the velocity
  assert.deepEqual(layerGains(velMaxes, 0.45, false), [{ layer: 1, gain: 1 }]);
  assert.equal(pickLayer([0.2, 0.45, 0.75, 1], 0.45), 1);
  assert.equal(pickLayer([0.2, 0.45, 0.75, 1], 0.46), 2);
  assert.equal(pickLayer([0.5, 0.9], 0.99), 1);
  // three layers: only the two neighbours sound
  const three = layerGains([0.35, 0.7, 1], 0.6, true);
  assert.deepEqual(three.map((x) => x.layer), [1, 2]);
  assert.deepEqual(layerGains([1], 0.3, true), [{ layer: 0, gain: 1 }]);
  assert.deepEqual(equalPower(0), [1, 0]);
});

test('velocity → gain is monotonic (~vel^1.6) and soft is darker', () => {
  near(velocityGain(1), 1);
  assert.ok(velocityGain(0.5) > 0.3 && velocityGain(0.5) < 0.45);
  for (let v = 0.05; v < 1; v += 0.05) assert.ok(velocityGain(v + 0.05) > velocityGain(v));
  assert.ok(velocityCutoffHz(0.2) < velocityCutoffHz(0.6) && velocityCutoffHz(0.6) < velocityCutoffHz(1));
  assert.ok(velocityCutoffHz(1) >= 16000, 'fully open at ff');
});

test('round robin rotates and never repeats a take when alternates exist', () => {
  const rr = new RoundRobin();
  const seq = Array.from({ length: 9 }, () => rr.next('violins|spiccato|0|60', 3));
  assert.deepEqual(seq, [0, 1, 2, 0, 1, 2, 0, 1, 2]);
  const two = Array.from({ length: 6 }, () => rr.next('a', 2));
  for (let i = 1; i < two.length; i++) assert.notEqual(two[i], two[i - 1]);
  assert.deepEqual(Array.from({ length: 3 }, () => rr.next('single', 1)), [0, 0, 0]);
  // keys are independent
  assert.equal(rr.next('b', 3), 0);
  // violins and violins2 share a rotation, so a unison never lands on the same take
  assert.equal(sampleSourceId('violins2'), 'violins');
  const shared = new RoundRobin();
  assert.notEqual(shared.next('violins|sustain|0|60', 2), shared.next('violins|sustain|0|60', 2));
  assert.deepEqual([rr.count('k'), rr.count('k'), rr.count('k')], [0, 1, 2]);
});

function inst(arts: string[], oneShot: string[] = []): InstrumentDef {
  const articulations: InstrumentDef['articulations'] = {};
  for (const a of arts) articulations[a] = { gainDb: 0, oneShot: oneShot.includes(a), layers: [{ velMax: 1, samples: { '60': ['x.mp3'] } }] };
  return { articulations };
}

test('articulation fallbacks', () => {
  const pick = (def: InstrumentDef, art: Articulation): string => {
    const r = resolveArticulation(def, art);
    return r ? `${r.name}:${r.mode}` : 'none';
  };
  const strings = inst(['sustain', 'spiccato', 'tremolo', 'pizzicato']);
  assert.equal(pick(strings, 'staccato'), 'spiccato:direct'); // staccato ↔ spiccato
  assert.equal(pick(inst(['sustain', 'staccato']), 'spiccato'), 'staccato:direct');
  assert.equal(pick(inst(['sustain', 'staccato']), 'pizzicato'), 'staccato:direct'); // pizzicato → staccato
  assert.equal(pick(inst(['sustain']), 'pizzicato'), 'sustain:gated'); // … → short gated sustain
  assert.equal(pick(inst(['sustain']), 'staccato'), 'sustain:gated');
  assert.equal(pick(inst(['sustain']), 'tremolo'), 'sustain:tremoloLfo'); // tremolo → sustain + 12 Hz LFO
  assert.equal(pick(strings, 'tremolo'), 'tremolo:direct');
  assert.equal(pick(inst(['hit']), 'roll'), 'hit:direct');
  assert.equal(pick(inst(['hit']), 'sustain'), 'hit:direct'); // glockenspiel / vibraphone sent as sustain
  assert.equal(pick(inst(['hit', 'roll']), 'tremolo'), 'roll:direct');
  assert.equal(pick(inst([]), 'sustain'), 'none');
  // an articulation whose samples failed to load is skipped
  const r = resolveArticulation(strings, 'spiccato', (name) => name !== 'spiccato');
  assert.equal(r?.name, 'sustain');
  assert.equal(r?.mode, 'gated');
});

test('voice modes: piano is damped, one-shots ring, gated and LFO stand-ins', () => {
  const direct = { name: 'sustain', mode: 'direct' as const };
  assert.equal(voiceMode('piano', direct, false), 'decay');
  assert.equal(voiceMode('piano', direct, true), 'decay');
  assert.equal(voiceMode('harp', direct, true), 'oneshot');
  assert.equal(voiceMode('harp', direct, false), 'decay');
  assert.equal(voiceMode('celli', direct, false), 'sustain');
  assert.equal(voiceMode('celli', { name: 'spiccato', mode: 'direct' }, true), 'oneshot');
  assert.equal(voiceMode('celli', { name: 'sustain', mode: 'gated' }, false), 'gated');
  assert.equal(voiceMode('flute', { name: 'sustain', mode: 'tremoloLfo' }, false), 'sustain');
  assert.equal(voiceMode('timpani', { name: 'roll', mode: 'direct' }, false), 'sustain');
});

test('envelopes: strings get a 20–40 ms fade-in, winds / brass 40–90 ms; release 250–600 ms; piano dampers', () => {
  for (const i of ['violins', 'violins2', 'violas', 'celli', 'basses', 'solo_violin', 'flute', 'horn'] as const) {
    const bowed = i !== 'flute' && i !== 'horn';
    for (const v of [0.05, 0.3, 0.6, 1]) {
      for (const m of [28, 48, 60, 84]) {
        const e = sustainEnvelope(i, v, m);
        if (bowed) assert.ok(e.attack >= 0.02 && e.attack <= 0.04, `${i} attack ${e.attack}`);
        else assert.ok(e.attack >= 0.04 && e.attack <= 0.09, `${i} attack ${e.attack}`);
        assert.ok(e.release >= 0.25 && e.release <= 0.6, `${i} release ${e.release}`);
      }
    }
  }
  assert.ok(sustainEnvelope('violins', 0.2, 67).attack > sustainEnvelope('violins', 0.9, 67).attack, 'softer is slower');
  assert.ok(sustainEnvelope('basses', 0.6, 30).release > sustainEnvelope('violins', 0.6, 72).release, 'low strings let go more slowly');
  assert.ok(legatoOffsetSec('celli') > legatoOffsetSec('flute'), 'a slur skips more of the slow string attack');
  assert.equal(pianoRelease(100).damped, false, 'no dampers above C7');
  assert.equal(pianoRelease(96).damped, true);
  assert.ok(pianoRelease(30).release > pianoRelease(47).release && pianoRelease(47).release > pianoRelease(60).release);
  assert.ok(decayRelease('harp', 60).release > 1);
});

test('range sanity: never more than 7 semitones of shift; far-out notes move by octaves and stay in key', () => {
  const keys = [55, 58, 62, 65, 69, 72, 76, 79, 83, 86, 91];
  assert.deepEqual(pickKeyInRange(keys, 96), { key: 91, semis: 5, rate: Math.pow(2, 5 / 12), octaves: 0 });
  const high = pickKeyInRange(keys, 103); // an octave above the top sampled key
  assert.equal(high?.octaves, -1);
  assert.equal(high?.key, 91);
  assert.equal(high?.semis, 0);
  const low = pickKeyInRange(keys, 40);
  assert.equal(low?.octaves, 1);
  assert.ok(Math.abs(low?.semis as number) <= 7);
  assert.equal(((40 + 12 - (low?.key as number) - (low?.semis as number)) % 12 + 12) % 12, 0, 'same pitch class');
  for (let m = 20; m <= 120; m++) assert.ok(Math.abs(pickKeyInRange(keys, m)?.semis as number) <= 7, `midi ${m}`);
  // pseudo-notes are left alone
  assert.deepEqual(pickKeyInRange([36, 38], 60, 0, { unpitched: true }), { key: 38, semis: 22, rate: 1, octaves: 0 });
});

test('recorded levels: soft layers are made up to the loud layer; hot and weak keys are evened out part-way', () => {
  // cello tremolo: soft layer ~30 dB under the loud one
  assert.deepEqual(layerMakeupDb([-51, -21]), [26, 0], 'capped at +26 dB');
  assert.deepEqual(layerMakeupDb([-40, -32, -24]), [16, 8, 0]);
  assert.deepEqual(layerMakeupDb([-30.5, -30.6, -30.5]).map((x) => +x.toFixed(1)), [0, 0.1, 0], 'a kit with level layers is untouched');
  assert.deepEqual(layerMakeupDb([-10, -20]), [-6, 0], 'a hot soft layer is only pulled down a little');
  assert.deepEqual(layerMakeupDb([-25]), [0]);
  // flute: bottom note 12 dB under the median, top note 12 dB over → 24 dB of tilt becomes about 10
  const lowTrim = keyCompDb(-36, -24);
  const highTrim = keyCompDb(-12, -24);
  assert.ok(lowTrim > 6 && lowTrim <= 12 && highTrim < -6 && highTrim >= -12);
  const tiltAfter = -12 + highTrim - (-36 + lowTrim);
  assert.ok(tiltAfter > 6 && tiltAfter < 12, `tilt after ${tiltAfter}`);
  assert.equal(keyCompDb(-80, -24), 12, 'clamped');
  assert.equal(keyCompDb(NaN, -24), 0);
  // with layers level, the one velocity curve is the whole dynamic: pp stays clearly audible
  const ppDb = 20 * Math.log10(velocityGain(0.15));
  assert.ok(ppDb > -21 && ppDb < -15, `pp sits ${ppDb.toFixed(1)} dB under fff`);
});

test('cymbal swells: the recording whose time-to-peak matches the note is started early so it peaks on the note end', () => {
  assert.deepEqual(pickSwell(1.2), { variant: 0, leadSec: 1.6 });
  assert.deepEqual(pickSwell(3.5), { variant: 1, leadSec: 3.8 });
  assert.deepEqual(pickSwell(20), { variant: 2, leadSec: 7.2 });
  assert.equal(pickSwell(2, []), null);
  const s = score({ bpm: 60, notes: [note({ inst: 'cymbal', art: 'roll', layer: 'accents', t: 4, dur: 3.5 }), note({ inst: 'cymbal', art: 'roll', layer: 'accents', t: 0, dur: 1 }), note({ inst: 'cymbal', art: 'hit', layer: 'accents', t: 2 })] });
  const p = planPhrase(s, { humanize: false, swellPeaks: [1.59, 3.81, 7.2] });
  const long = p.notes.find((x) => x.i === 0);
  const short = p.notes.find((x) => x.i === 1);
  near(long?.swell?.peakSec as number, 7.5);
  near(long?.onSec as number, 7.5 - 3.81);
  near(short?.swell?.peakSec as number, 1);
  near(short?.onSec as number, 1 - 1.59, 1e-9); // starts before the phrase: the engine enters the recording part-way
  assert.equal(p.notes[0].i, 1, 'sorted by when the recording must start');
  assert.equal(p.notes.find((x) => x.i === 2)?.swell, undefined, 'a plain hit is not a swell');
});

test('seating: violins left … basses right, piano centre, violins2 between violins and centre', () => {
  assert.ok(panFor('violins') < panFor('violins2') && panFor('violins2') < 0);
  assert.ok(0 < panFor('violas') && panFor('violas') < panFor('celli') && panFor('celli') < panFor('basses'));
  assert.equal(panFor('piano'), 0);
  assert.equal(panFor('timpani'), 0);
  assert.ok(panFor('horn') < 0 && panFor('harp') < 0);
  assert.ok(Math.abs(panFor('basses')) <= 0.5, 'subtle');
});

test('grains: 5–6 s hops with a 1.5 s crossfade on long samples, proportionate on short ones', () => {
  for (const r of [0, 0.5, 0.999]) {
    const g = grainTiming(9, r);
    assert.ok(g.hop >= 5 && g.hop <= 6);
    near(g.xfade, 1.5);
    assert.ok(g.hop + g.xfade <= 9 - 0.5, 'the crossfade is over before the recorded tail');
  }
  const short = grainTiming(2, 0.5);
  assert.ok(short.hop > short.xfade && short.hop + short.xfade < 2);
  const a = grainOffset(9, 0.1);
  const b = grainOffset(9, 0.9);
  assert.ok(a >= 0.3 && b > a && b < 2, 'restarts skip the attack at varied offsets');
});

test('voice stealing takes the oldest-quietest, spares held and not-yet-started voices', () => {
  const now = 100;
  assert.equal(stealIndex([{ start: 99, level: 0.5 }, { start: 90, level: 0.5 }, { start: 95, level: 0.5 }], now), 1, 'oldest of equals');
  assert.equal(stealIndex([{ start: 90, level: 0.8 }, { start: 99, level: 0.01 }], now), 1, 'a much quieter voice goes first');
  assert.equal(stealIndex([{ start: 60, level: 0.2, held: true }, { start: 99.5, level: 0.6 }], now), 1, 'hold voices are protected');
  assert.equal(stealIndex([{ start: 100.1, level: 0.9 }, { start: 99, level: 0.9 }], now), 1, 'future notes are not stolen');
  assert.equal(stealIndex([], now), -1);
});

// ───────────────────────────── Mix mapping ─────────────────────────────

test('MixState mapping endpoints', () => {
  const mix = (patch: Partial<MixState>): MixState => ({ ...DEFAULT_MIX, ...patch });
  near(mixToParams(mix({ lowpass: 0 })).lowpassHz, 350, 1e-6);
  near(mixToParams(mix({ lowpass: 6 })).lowpassHz, 18000, 1e-6);
  near(mixToParams(mix({ lowpass: 3 })).lowpassHz, Math.sqrt(350 * 18000), 1e-6); // exponential
  near(mixToParams(mix({ reverb: 0 })).reverbWet, 0.05);
  near(mixToParams(mix({ reverb: 6 })).reverbWet, 0.6);
  near(mixToParams(mix({ delay: 0 })).delayWet, 0);
  near(mixToParams(mix({ delay: 6 })).delayWet, 0.35);
  assert.equal(mixToParams(mix({ noise: 0 })).noiseGain, 0);
  near(20 * Math.log10(mixToParams(mix({ noise: 6 })).noiseGain), -14);
  near(mixToParams(mix({ width: 3 })).width, 0.5);
  assert.ok(mixToParams(mix({ width: 0 })).width < 0.2 && mixToParams(mix({ width: 6 })).width > 0.65 && mixToParams(mix({ width: 6 })).width < 1);
  near(20 * Math.log10(mixToParams(mix({ dynamics: 0 })).master), -18);
  near(mixToParams(mix({ dynamics: 6 })).master, 1);
  // dynamics moving inside a phrase: linear between the curve's points, held outside them
  const crescendo = [{ beat: 0, step: 2 }, { beat: 16, step: 4 }];
  near(curveLevel(crescendo, 0), 2);
  near(curveLevel(crescendo, 8), 3);
  near(curveLevel(crescendo, 20), 4);
  near(curveLevel([{ beat: 0, step: 3 }, { beat: 8, step: 4 }, { beat: 16, step: 3 }], 12), 3.5);
  const s0 = mixToParams(mix({ saturation: 0 }));
  const s6 = mixToParams(mix({ saturation: 6 }));
  near(s0.satPre * s0.satPost, 1, 1e-9); // clean and unity at 0
  assert.ok(s6.satPre > s0.satPre * 4 && s6.satPost < s0.satPost);
  assert.equal(mixToParams(mix({ chorus: false })).chorusWet, 0);
  assert.ok(mixToParams(mix({ chorus: true })).chorusWet > 0);
  near(20 * Math.log10(DUCK_GAIN), -9);
});

test('sound worlds scale the mapping', () => {
  const m: MixState = { ...DEFAULT_MIX, reverb: 6, lowpass: 6, noise: 0 };
  near(mixToParams(m, 'close_dry').reverbWet, 0.6 * 0.4);
  near(mixToParams(m, 'large_hall').reverbWet, 0.6);
  near(mixToParams(m, 'submerged').reverbWet, 0.66);
  near(mixToParams(m, 'electronic_hybrid').reverbWet, 0.6 * 0.7);
  near(Math.log2(18000 / mixToParams(m, 'submerged').lowpassHz), 1.5, 1e-9); // ceiling down 1.5 octaves
  assert.ok(mixToParams(m, 'submerged').noiseGain > 0, 'a little water even at noise 0');
  assert.equal(mixToParams(m, 'large_hall').noiseGain, 0);
  assert.ok(mixToParams(m, 'electronic_hybrid').lowpassHz > mixToParams(m, 'large_hall').lowpassHz);
  assert.ok(mixToParams({ ...m, lowpass: 0 }, 'submerged').lowpassHz >= 350 - 1e-9, 'the floor is not dragged down');
});

test('hold mix patches merge; delay is a dotted eighth of the beat', () => {
  const merged = mergeMix(DEFAULT_MIX, { reverb: 5, chorus: true });
  assert.equal(merged.reverb, 5);
  assert.equal(merged.chorus, true);
  assert.equal(merged.lowpass, DEFAULT_MIX.lowpass);
  assert.notEqual(merged, DEFAULT_MIX);
  near(delayTimeSec(120), 0.375);
  near(delayTimeSec(70), 0.75 * (60 / 70));
  assert.ok(delayTimeSec(40) <= 0.9);
});

// ───────────────────────────── Manifest ─────────────────────────────

test('manifest: normalised defensively, aliases resolved, files listed once', () => {
  const m = normalizeManifest({
    version: 1,
    baseUrl: '/assets/samples',
    instruments: {
      violins: {
        family: 'strings',
        range: [55, 96],
        articulations: {
          sustain: { gainDb: 0, oneShot: false, layers: [{ velMax: 1, samples: { '60': ['v/f.mp3', 'v/f2.mp3'] } }, { velMax: 0.4, samples: { '60': ['v/p.mp3'], bad: ['x'] } }] },
          broken: { layers: 'nope' },
        },
      },
      junk: null,
    },
    extras: { pianoPedalDown: ['piano/pedalD1.mp3'] },
  });
  assert.equal(m.baseUrl, '/assets/samples/');
  assert.deepEqual(m.instruments.violins.articulations.sustain.layers.map((l) => l.velMax), [0.4, 1], 'layers ascend');
  assert.deepEqual(Object.keys(m.instruments.violins.articulations), ['sustain']);
  assert.deepEqual(Object.keys(m.instruments.violins.articulations.sustain.layers[0].samples), ['60']);
  assert.deepEqual(instrumentFiles(m, 'violins2').sort(), ['v/f.mp3', 'v/f2.mp3', 'v/p.mp3']);
  assert.deepEqual(instrumentFiles(m, 'horn'), []);
  assert.equal(joinUrl(m.baseUrl, 'violins/sus C#4.mp3'), '/assets/samples/violins/sus%20C%234.mp3');
  assert.deepEqual(normalizeManifest(null).instruments, {});
});

test('prng is deterministic and roughly uniform', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 2000 }, () => a());
  assert.deepEqual(xs.slice(0, 50), Array.from({ length: 50 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03);
  assert.notEqual(hashSeed(1, 2), hashSeed(2, 1));
});

// ───────────────────────────── Demo score + the real manifest, if it has been built ─────────────────────────────

test('demo score: two 12/8 phrases at 70 BPM that plan cleanly', () => {
  assert.equal(demoScores.length, 2);
  for (const s of demoScores) {
    assert.equal(s.bpm, 70);
    assert.equal(s.beatsPerBar, 4);
    const p = planPhrase(s);
    assert.equal(p.notes.length, s.notes.length);
    for (const x of p.notes) {
      assert.ok(x.onSec >= -0.011 && x.onSec < p.seconds);
      assert.ok(x.note.t + x.note.dur <= s.beats + 1 + 1e-9);
      assert.ok(demoPalette.includes(x.note.inst));
    }
    assert.ok(s.holdChord.length > 0);
  }
  const p1 = planPhrase(demoScores[1]);
  assert.ok(p1.seconds > (8 * 60) / 70, 'the second phrase slows down');
  assert.ok(p1.pedalEndsDown, 'its last chord is left ringing on the pedal');
  assert.notDeepEqual(demoScores[0].mix, demoScores[1].mix);
});

test('real manifest (when present): every instrument resolves every articulation to something playable', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '../../../../assets/samples/manifest.json');
  if (!fs.existsSync(file)) {
    t.skip('assets/samples/manifest.json has not been built yet');
    return;
  }
  const m = normalizeManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
  const ids = Object.keys(m.instruments);
  assert.ok(ids.length > 0);
  const arts: Articulation[] = ['sustain', 'staccato', 'spiccato', 'tremolo', 'pizzicato', 'hit', 'roll'];
  for (const id of ids) {
    const def = m.instruments[id];
    for (const art of arts) assert.ok(resolveArticulation(def, art), `${id} has nothing for ${art}`);
    for (const a of Object.values(def.articulations)) {
      const velMaxes = a.layers.map((l) => l.velMax);
      assert.deepEqual([...velMaxes].sort((x, y) => x - y), velMaxes, `${id}: layers ascend`);
      for (const l of a.layers) {
        const keys = Object.keys(l.samples).map(Number).sort((x, y) => x - y);
        assert.ok(pickKey(keys, 60), `${id}: a key can be picked`);
      }
    }
    assert.ok(instrumentFiles(m, id as never).length > 0);
  }
});
