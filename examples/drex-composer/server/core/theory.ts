// Pitch, scale, meter and chord arithmetic. No decisions are made here: this only builds
// option lists and turns Drex's choices into notes.

import type { HarmonicLanguage, MeterId, ModeId } from '../../shared/types.ts';
import { mod } from './rng.ts';

// ───────────────────────────── Scales and keys ─────────────────────────────

export const MODES: Record<ModeId, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  natural_minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export const MODE_NAMES: Record<ModeId, string> = {
  major: 'major',
  natural_minor: 'minor',
  harmonic_minor: 'harmonic minor',
  melodic_minor: 'melodic minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
};

export const MODE_FEEL: Record<ModeId, string> = {
  major: 'bright, settled, open',
  natural_minor: 'sad, grounded, plain',
  harmonic_minor: 'dramatic minor with a pulling leading tone',
  melodic_minor: 'minor that lifts and yearns upward',
  dorian: 'minor with a hopeful raised sixth; cool, bittersweet',
  phrygian: 'dark, tense, lowered second; ominous',
  lydian: 'floating, wondrous, raised fourth; bright and dreamy',
  mixolydian: 'major with a relaxed lowered seventh; playful, folk-like',
};

export const isMinorish = (mode: ModeId) => MODES[mode][2] === 3;
export const parallelMode = (mode: ModeId): ModeId => (isMinorish(mode) ? 'major' : 'natural_minor');

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export interface Key {
  /** Tonic pitch class, 0 = C. */
  tonic: number;
  mode: ModeId;
  /** Force the spelling, so a phrase recast in the parallel mode keeps its tonic's letter name. */
  spell?: 'sharp' | 'flat';
}

/** Whether a key is conventionally spelled with flats. */
export function usesFlats(key: Key): boolean {
  if (key.spell) return key.spell === 'flat';
  // Relative-major tonic decides the spelling.
  const offsetToMajor: Record<ModeId, number> = {
    major: 0, natural_minor: 3, harmonic_minor: 3, melodic_minor: 3,
    dorian: 10, phrygian: 8, lydian: 7, mixolydian: 5,
  };
  const rel = mod(key.tonic + offsetToMajor[key.mode], 12);
  return [5, 10, 3, 8, 1].includes(rel);
}

export function pcName(pc: number, key?: Key): string {
  const names = key && usesFlats(key) ? FLAT_NAMES : SHARP_NAMES;
  return names[mod(pc, 12)];
}

export function keyName(key: Key): string {
  return `${pcName(key.tonic, key)} ${MODE_NAMES[key.mode]}`;
}

export function midiName(midi: number, key?: Key): string {
  return `${pcName(midi, key)}${Math.floor(midi / 12) - 1}`;
}

/** MIDI note of the tonic in the central octave: C4..F♯4, or G3..B3 for higher tonics. */
export function tonicMidi(key: Key): number {
  return key.tonic <= 6 ? 60 + key.tonic : 48 + key.tonic;
}

/**
 * Diatonic degree index → MIDI. Degree 0 is the tonic in the central octave, 7 the tonic above,
 * -1 the leading note below. `alt` shifts by semitones.
 */
export function degreeToMidi(key: Key, deg: number, alt = 0): number {
  const scale = MODES[key.mode];
  const octave = Math.floor(deg / 7);
  return tonicMidi(key) + 12 * octave + scale[mod(deg, 7)] + alt;
}

/** Nearest diatonic degree index for a MIDI note (ties resolve downward). */
export function midiToDegree(key: Key, midi: number): { deg: number; alt: number } {
  let best = { deg: 0, alt: 99 };
  const approx = Math.round(((midi - tonicMidi(key)) * 7) / 12);
  for (let d = approx - 2; d <= approx + 2; d++) {
    const alt = midi - degreeToMidi(key, d);
    if (Math.abs(alt) < Math.abs(best.alt)) best = { deg: d, alt };
  }
  return best;
}

/** Semitone transposition of a key, keeping the mode. */
export function transposeKey(key: Key, semitones: number): Key {
  return { tonic: mod(key.tonic + semitones, 12), mode: key.mode };
}

export function relativeKey(key: Key): Key {
  return isMinorish(key.mode)
    ? { tonic: mod(key.tonic + 3, 12), mode: 'major' }
    : { tonic: mod(key.tonic + 9, 12), mode: 'natural_minor' };
}

// ───────────────────────────── Meter ─────────────────────────────

export interface Meter {
  id: MeterId;
  /** Beats per bar, in the meter's beat unit. */
  beatsPerBar: number;
  /** How the beat divides: 2 (simple) or 3 (compound). */
  sub: 2 | 3;
  feel: string;
  /** Strong beat positions inside a bar. */
  strong: number[];
}

export const METERS: Record<MeterId, Meter> = {
  '4/4': { id: '4/4', beatsPerBar: 4, sub: 2, feel: 'even, walking or driving; the default pulse', strong: [0, 2] },
  '3/4': { id: '3/4', beatsPerBar: 3, sub: 2, feel: 'waltz-like, turning, graceful', strong: [0] },
  '6/8': { id: '6/8', beatsPerBar: 2, sub: 3, feel: 'lilting two-in-a-bar, rocking', strong: [0] },
  '12/8': { id: '12/8', beatsPerBar: 4, sub: 3, feel: 'slow compound pulse, rolling and wave-like', strong: [0, 2] },
  '5/4': { id: '5/4', beatsPerBar: 5, sub: 2, feel: 'uneven and restless, limping forward', strong: [0, 3] },
  '7/8': { id: '7/8', beatsPerBar: 3.5, sub: 2, feel: 'asymmetric, nimble, off-balance', strong: [0, 2] },
};

// ───────────────────────────── Chords ─────────────────────────────

export type ChordFamily =
  | 'diatonic' | 'diatonic_extended' | 'suspended' | 'borrowed' | 'chromatic_mediant' | 'late_romantic';

export const FAMILY_EFFECT: Record<ChordFamily, string> = {
  diatonic: 'plain and stable; belongs to the key',
  diatonic_extended: 'warm, open, tender',
  suspended: 'unresolved, floating',
  borrowed: 'sudden shadow (or sudden light) from the parallel key',
  chromatic_mediant: 'cold, cinematic shift; a third away with one shared tone',
  late_romantic: 'a chill under the sweetness',
};

export type ChordFunction = 'tonic' | 'predominant' | 'dominant' | 'colour';

export interface Chord {
  /** Stable option key, e.g. "d5_maj7" or "bVI". */
  id: string;
  /** Roman-numeral style label relative to the key. */
  roman: string;
  /** Root, semitones above the tonic (0..11). */
  root: number;
  /** Chord tones, semitones above the root. intervals[0] is 0. */
  intervals: number[];
  family: ChordFamily;
  fn: ChordFunction;
  effect: string;
}

const QUALITY_SUFFIX: Record<string, string> = {
  '0,4,7': '', '0,3,7': 'm', '0,3,6': 'dim', '0,4,8': 'aug',
  '0,4,7,11': 'maj7', '0,4,7,10': '7', '0,3,7,10': 'm7', '0,3,6,10': 'm7♭5', '0,3,6,9': 'dim7',
  '0,3,7,11': 'm(maj7)', '0,4,8,11': 'maj7♯5',
  '0,4,7,11,14': 'maj9', '0,4,7,10,14': '9', '0,3,7,10,14': 'm9', '0,4,7,14': 'add9', '0,3,7,14': 'm(add9)',
  '0,3,7,11,14': 'm(maj9)', '0,4,6': '(♭5)', '0,4,6,10': '7♭5', '0,4,6,11': 'maj7♭5', '0,4,8,10': '7♯5', '0,3,8': 'm♯5',
  '0,2,7': 'sus2', '0,5,7': 'sus4', '0,2,7,9': '6sus2', '0,5,7,10': '7sus4',
};

export function chordSuffix(intervals: number[]): string {
  return QUALITY_SUFFIX[intervals.join(',')] ?? `(${intervals.join(' ')})`;
}

export function chordName(chord: Chord, key: Key): string {
  return pcName(key.tonic + chord.root, key) + chordSuffix(chord.intervals);
}

export function chordPcs(chord: Chord, key: Key): number[] {
  return chord.intervals.map((iv) => mod(key.tonic + chord.root + iv, 12));
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const ROOT_ROMAN: Record<number, string> = {
  0: 'I', 1: '♭II', 2: 'II', 3: '♭III', 4: 'III', 5: 'IV', 6: '♯IV', 7: 'V', 8: '♭VI', 9: 'VI', 10: '♭VII', 11: 'VII',
};

function romanFor(root: number, intervals: number[], scaleDegree?: number): string {
  const base = scaleDegree !== undefined ? ROMAN[scaleDegree] : ROOT_ROMAN[root];
  const minor = intervals[1] === 3;
  const body = minor ? base.toLowerCase() : base;
  const suffix = chordSuffix(intervals).replace(/^m(?!aj)/, '');
  return body + suffix;
}

function functionOf(root: number): ChordFunction {
  // Root relative to tonic, in semitones.
  if (root === 0 || root === 9 || root === 8 || root === 4 || root === 3) return 'tonic';
  if (root === 5 || root === 2 || root === 1) return 'predominant';
  if (root === 7 || root === 11 || root === 10) return 'dominant';
  return 'colour';
}

function make(
  id: string, root: number, intervals: number[], family: ChordFamily, effect?: string, scaleDegree?: number,
): Chord {
  const r = mod(root, 12);
  return {
    id, root: r, intervals, family,
    roman: romanFor(r, intervals, scaleDegree),
    fn: functionOf(r),
    effect: effect ?? FAMILY_EFFECT[family],
  };
}

/**
 * Every chord option for a key. All families are always offered; the harmonic language Drex chose
 * in setup is described to it in the state, not enforced by removing options here.
 * `previous` adds the chromatic mediants of the chord just left.
 */
export function chordCandidates(key: Key, previous?: Chord): Chord[] {
  const scale = MODES[key.mode];
  const out: Chord[] = [];
  const seen = new Set<string>();
  const push = (c: Chord) => {
    const sig = `${c.root}:${c.intervals.join(',')}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push(c);
  };

  // Diatonic triads, sevenths and ninths on every scale degree.
  for (let d = 0; d < 7; d++) {
    const root = scale[d];
    const at = (steps: number) => {
      const idx = d + steps;
      return mod(scale[mod(idx, 7)] + 12 * Math.floor(idx / 7) - root, 12);
    };
    const third = at(2);
    const fifth = at(4);
    const seventh = at(6);
    const ninth = at(1) + 12;
    const dim = fifth === 6 ? 'tense and unstable: a diminished chord that wants to resolve' : undefined;
    push(make(`d${d + 1}`, root, [0, third, fifth], 'diatonic', dim, d));
    push(make(`d${d + 1}_7`, root, [0, third, fifth, seventh], 'diatonic_extended', dim, d));
    if (ninth === 14 && fifth === 7) {
      push(make(`d${d + 1}_9`, root, [0, third, fifth, seventh, 14], 'diatonic_extended', undefined, d));
      push(make(`d${d + 1}_add9`, root, [0, third, fifth, 14], 'diatonic_extended', 'warm and open, a triad with a glow on top', d));
    }
  }

  // Suspended chords on I, IV and V.
  for (const d of [0, 3, 4]) {
    const root = scale[d];
    push(make(`d${d + 1}_sus2`, root, [0, 2, 7], 'suspended', undefined, d));
    push(make(`d${d + 1}_sus4`, root, [0, 5, 7], 'suspended', undefined, d));
  }
  push(make('d1_6sus2', scale[0], [0, 2, 7, 9], 'suspended', 'floating and hazy, neither major nor minor', 0));
  push(make('d5_7sus4', scale[4], [0, 5, 7, 10], 'suspended', 'a dominant that refuses to lean; unresolved, floating', 4));

  // Borrowed from the parallel key.
  if (isMinorish(key.mode)) {
    push(make('bor_IV', 5, [0, 4, 7], 'borrowed', 'sudden light: the major IV in a minor key'));
    push(make('bor_I', 0, [0, 4, 7], 'borrowed', 'sudden light: the tonic turned major'));
    push(make('bor_V', 7, [0, 4, 7], 'borrowed', 'a strong pull home: the major dominant'));
    push(make('bor_V7', 7, [0, 4, 7, 10], 'borrowed', 'the strongest pull home: dominant seventh'));
  } else {
    push(make('bor_iv', 5, [0, 3, 7], 'borrowed', 'sudden shadow: the minor iv in a major key'));
    push(make('bor_bVI', 8, [0, 4, 7], 'borrowed', 'sudden shadow, broad and grave: flat VI'));
    push(make('bor_bVII', 10, [0, 4, 7], 'borrowed', 'sudden shadow with lift: flat VII'));
    push(make('bor_i', 0, [0, 3, 7], 'borrowed', 'sudden shadow: the tonic turned minor'));
  }

  // Chromatic mediants of the chord being left (or of the tonic chord).
  const fromRoot = previous ? previous.root : 0;
  const fromMinor = previous ? previous.intervals[1] === 3 : isMinorish(key.mode);
  for (const step of [3, 4, 8, 9]) {
    const q = fromMinor ? [0, 3, 7] : [0, 4, 7];
    push(make(`med_${step}`, fromRoot + step, q, 'chromatic_mediant',
      `cold, cinematic shift: a ${step === 3 || step === 9 ? 'minor' : 'major'} third ${step <= 4 ? 'up' : 'down'} from the ${previous ? 'last' : 'tonic'} chord, one shared tone`));
  }

  // Late-Romantic colour.
  push(make('lr_aug', isMinorish(key.mode) ? 3 : 0, [0, 4, 8], 'late_romantic', 'a chill under the sweetness: augmented, unstable and glowing'));
  push(make('lr_dim7', 11, [0, 3, 6, 9], 'late_romantic', 'a chill: diminished seventh on the leading note, pulling hard to the tonic'));
  push(make('lr_mM7', isMinorish(key.mode) ? 0 : 5, [0, 3, 7, 11], 'late_romantic', 'a chill under the sweetness: minor with a major seventh, aching'));
  push(make('lr_neapolitan', 1, [0, 4, 7], 'late_romantic', 'Neapolitan flat II: grave, tragic, leans to the dominant'));

  return out;
}

export function findChord(key: Key, id: string, previous?: Chord): Chord | undefined {
  return chordCandidates(key, previous).find((c) => c.id === id);
}

export function tonicChord(key: Key): Chord {
  return chordCandidates(key)[0];
}

/** How a melody pitch class sits against a chord. */
export function fitOf(pc: number, chord: Chord, key: Key): 'chord_tone' | 'colour' | 'clash' {
  const pcs = chordPcs(chord, key);
  const p = mod(pc, 12);
  if (pcs.includes(p)) return 'chord_tone';
  // A semitone above a chord tone (a minor ninth against it) is the harsh one.
  if (pcs.some((c) => mod(p - c, 12) === 1)) return 'clash';
  return 'colour';
}

export function intervalName(semitones: number): string {
  const names = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', '4th', 'tritone', '5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th'];
  const s = Math.abs(semitones);
  if (s === 12) return 'octave';
  return s > 12 ? `${names[s % 12]} + octave` : names[s];
}

/** Name of a chord member, e.g. "root", "3rd". */
export function chordToneName(pc: number, chord: Chord, key: Key): string | null {
  const iv = mod(pc - key.tonic - chord.root, 12);
  const idx = chord.intervals.map((x) => mod(x, 12)).indexOf(iv);
  if (idx < 0) return null;
  if (idx === 0) return 'root';
  const x = chord.intervals[idx];
  if (x === 3 || x === 4) return '3rd';
  if (x === 2) return '2nd';
  if (x === 5) return '4th';
  if (x === 6 || x === 7 || x === 8) return '5th';
  if (x === 9) return chord.intervals.length === 4 && chord.intervals[2] === 6 ? '7th' : '6th';
  if (x === 10 || x === 11) return '7th';
  if (x === 14) return '9th';
  return 'tone';
}

export const HARMONIC_LANGUAGE_TEXT: Record<HarmonicLanguage, string> = {
  triads: 'plain triads; direct and simple',
  sevenths: 'seventh chords; fuller, a little jazzy or wistful',
  extended: 'ninths and extended chords; warm, open, tender',
  suspended: 'suspended chords; unresolved and floating',
  chromatic: 'chromatic late-Romantic harmony; dark turns and rich colour',
};
