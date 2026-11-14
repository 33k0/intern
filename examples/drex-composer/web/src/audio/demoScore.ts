// A small hand-written score for smoke-testing the engine without the server:
// two 2-bar phrases in 12/8 at 70 BPM (beat = dotted quarter), D minor.
// Piano melody, celli sustain, basses, harp figuration; the mix opens up in the second phrase,
// which ends with a ritardando. Neither phrase is final, so letting the queue run dry after
// the second one demonstrates the hold (see `demoHoldUpdate`). Use `asFinal` for an ending.

import type { HoldUpdate, InstrumentId, LayerRole, MixState, NoteEvent, PhraseScore, Articulation } from '../../../shared/types.ts';

const E = 1 / 3; // one eighth note, in dotted-quarter beats

function n(t: number, dur: number, midi: number, vel: number, inst: InstrumentId, layer: LayerRole, art: Articulation = 'sustain'): NoteEvent {
  return { t, dur, midi, vel, inst, art, layer };
}

/** Harp: three eighths per beat rolling up a chord. `chords` gives the pitches for each beat. */
function harp(chords: number[][], vel: number, startBeat = 0): NoteEvent[] {
  const out: NoteEvent[] = [];
  chords.forEach((c, beat) => {
    for (let k = 0; k < 3; k++) {
      // the first eighth of each beat leans a little
      out.push(n(startBeat + beat + k * E, E * 2.5, c[k % c.length], vel * (k === 0 ? 1 : 0.82), 'harp', 'figuration'));
    }
  });
  return out;
}

const G1 = 31, A1 = 33, Bb1 = 34, C2 = 36, D2 = 38, F2 = 41;
const D3 = 50, F3 = 53, G3 = 55, A3 = 57, Bb3 = 58, C4 = 60, Cs4 = 61, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69;
const C5 = 72, Cs5 = 73, D5 = 74, E5 = 76, F5 = 77;

const mixA: MixState = { dynamics: 2, lowpass: 4, reverb: 3, delay: 0, noise: 0, width: 3, saturation: 0, chorus: false, sidechain: false };
const mixB: MixState = { dynamics: 4, lowpass: 6, reverb: 4, delay: 1, noise: 1, width: 4, saturation: 1, chorus: false, sidechain: false };

// Phrase 0 — statement. Dm | Bb | F | C  (two beats each)
const phrase0: PhraseScore = {
  index: 0,
  section: 0,
  role: 'statement',
  bars: 2,
  beatsPerBar: 4,
  beats: 8,
  bpm: 70,
  notes: [
    // piano melody
    n(0, 1.5, F4, 0.5, 'piano', 'melody'),
    n(1.5, 0.5, A4, 0.46, 'piano', 'melody'),
    n(2, 2, D5, 0.58, 'piano', 'melody'),
    n(4, 1, C5, 0.52, 'piano', 'melody'),
    n(5, 1, A4, 0.48, 'piano', 'melody'),
    n(6, 1 + E, G4, 0.5, 'piano', 'melody'),
    n(7 + E, 2 * E, E4, 0.42, 'piano', 'melody'),
    // celli: one long line, slurred
    n(0, 2, A3, 0.42, 'celli', 'inner'),
    n(2, 2, Bb3, 0.45, 'celli', 'inner'),
    n(4, 2, A3, 0.45, 'celli', 'inner'),
    n(6, 2, G3, 0.4, 'celli', 'inner'),
    // basses
    n(0, 2, D2, 0.5, 'basses', 'bass'),
    n(2, 2, Bb1, 0.5, 'basses', 'bass'),
    n(4, 2, F2, 0.5, 'basses', 'bass'),
    n(6, 2, C2, 0.48, 'basses', 'bass'),
    // harp figuration
    ...harp([[D3, A3, F4], [F3, A3, D4], [D3, Bb3, F4], [F3, Bb3, D4], [F3, C4, A4], [A3, C4, F4], [G3, C4, E4], [E4, C4, G3]], 0.4),
  ],
  pedal: [
    { t: 0.05, down: true },
    { t: 2, down: false }, { t: 2.08, down: true },
    { t: 4, down: false }, { t: 4.08, down: true },
    { t: 6, down: false }, { t: 6.08, down: true },
    { t: 7.9, down: false },
  ],
  mix: mixA,
  holdChord: [
    { midi: C2, vel: 0.4, inst: 'basses', art: 'sustain' },
    { midi: G3, vel: 0.36, inst: 'celli', art: 'sustain' },
    { midi: E4, vel: 0.3, inst: 'piano', art: 'sustain' },
  ],
  display: {
    key: 'D minor',
    notation: 'F4. A4 | D5 | C5 A4 | G4 E4',
    lineage: 'demo theme',
    chords: ['Dm', 'B♭', 'F', 'C'],
    layers: [
      { role: 'melody', inst: 'piano', dynamics: 2, art: 'sustain', entry: 'immediate' },
      { role: 'inner', inst: 'celli', dynamics: 2, art: 'sustain', entry: 'immediate' },
      { role: 'bass', inst: 'basses', dynamics: 2, art: 'sustain', entry: 'immediate' },
      { role: 'figuration', inst: 'harp', dynamics: 2, art: 'sustain', entry: 'immediate' },
    ],
    tension: 3,
  },
};

// Phrase 1 — development, fuller and brighter. Dm | Gm | A | Dm, slowing over the last three beats.
const phrase1: PhraseScore = {
  index: 1,
  section: 0,
  role: 'development',
  bars: 2,
  beatsPerBar: 4,
  beats: 8,
  bpm: 70,
  ritardando: { fromBeat: 5, toBpm: 48 },
  notes: [
    // piano melody, an octave figure answered in thirds
    n(0, 1, A4, 0.62, 'piano', 'melody'),
    n(1, 1, D5, 0.66, 'piano', 'melody'),
    n(2, 1.5, F5, 0.74, 'piano', 'melody'),
    n(2, 1.5, D5, 0.56, 'piano', 'melody'),
    n(3.5, 0.5, E5, 0.6, 'piano', 'melody'),
    n(4, 2, E5, 0.7, 'piano', 'melody'),
    n(4, 2, Cs5, 0.54, 'piano', 'melody'),
    n(6, 2, D5, 0.6, 'piano', 'melody'),
    n(6, 2, A4, 0.46, 'piano', 'melody'),
    // celli
    n(0, 2, F3, 0.55, 'celli', 'inner'),
    n(2, 2, G3, 0.6, 'celli', 'inner'),
    n(4, 2, A3, 0.62, 'celli', 'inner'),
    n(6, 2, F3, 0.5, 'celli', 'inner'),
    // basses
    n(0, 2, D2, 0.58, 'basses', 'bass'),
    n(2, 2, G1, 0.6, 'basses', 'bass'),
    n(4, 2, A1, 0.62, 'basses', 'bass'),
    n(6, 2, D2, 0.52, 'basses', 'bass'),
    // harp
    ...harp([[D3, A3, F4], [F3, A3, D4], [G3, Bb3, D4], [Bb3, D4, G4], [A3, Cs4, E4], [Cs4, E4, A4], [D3, A3, F4]], 0.5),
    n(7, 1, D3, 0.42, 'harp', 'figuration'),
    n(7 + E, 1, A3, 0.38, 'harp', 'figuration'),
    n(7 + 2 * E, 1, D4, 0.36, 'harp', 'figuration'),
  ],
  pedal: [
    { t: 0.05, down: true },
    { t: 2, down: false }, { t: 2.08, down: true },
    { t: 4, down: false }, { t: 4.08, down: true },
    { t: 6, down: false }, { t: 6.08, down: true },
  ],
  mix: mixB,
  holdChord: [
    { midi: D2, vel: 0.42, inst: 'basses', art: 'sustain' },
    { midi: A3, vel: 0.4, inst: 'celli', art: 'sustain' },
    { midi: F3, vel: 0.36, inst: 'celli', art: 'sustain' },
    { midi: D4, vel: 0.28, inst: 'piano', art: 'sustain' },
  ],
  display: {
    key: 'D minor',
    notation: 'A4 D5 | F5. E5 | E5 | D5',
    lineage: 'demo theme, answered a third higher',
    chords: ['Dm', 'Gm', 'A', 'Dm'],
    layers: [
      { role: 'melody', inst: 'piano', dynamics: 4, art: 'sustain', entry: 'continues' },
      { role: 'inner', inst: 'celli', dynamics: 3, art: 'sustain', entry: 'continues' },
      { role: 'bass', inst: 'basses', dynamics: 3, art: 'sustain', entry: 'continues' },
      { role: 'figuration', inst: 'harp', dynamics: 3, art: 'sustain', entry: 'continues' },
    ],
    tension: 5,
  },
};

export const demoScores: PhraseScore[] = [phrase0, phrase1];

/** Instruments the demo needs loaded. */
export const demoPalette: InstrumentId[] = ['piano', 'celli', 'basses', 'harp'];

/** A hold update to try while the engine is holding after phrase 1: the chord darkens and the room grows. */
export const demoHoldUpdate: HoldUpdate = {
  action: 'darken',
  label: 'Third drops out, low fifth added',
  notes: [
    { midi: D2, vel: 0.42, inst: 'basses', art: 'sustain' },
    { midi: A3, vel: 0.34, inst: 'celli', art: 'sustain' },
    { midi: D3, vel: 0.38, inst: 'celli', art: 'sustain' },
  ],
  mix: { lowpass: 3, reverb: 5 },
  overSec: 3,
};

/** The same scores with the last one marked final (tails ring, then `ended`). */
export function asFinal(scores: PhraseScore[]): PhraseScore[] {
  return scores.map((s, i) => (i === scores.length - 1 ? { ...s, final: true } : s));
}
