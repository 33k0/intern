// Small, honest music generator for the mock feed: a motif, real transformations of it, and
// PhraseScores the audio engine can actually play. The lineage strings describe what the code
// did to the notes, so the mock panel shows true derivations rather than decoration.

import type {
  DraftView, InstrumentId, LayerRole, LayerSummary, MixState, ModeId, NoteEvent, PhraseRole,
  PhraseScore, PlanView, RulesView, Step7, ThemeView,
} from '../../../shared/types';

const MODE_STEPS: Record<ModeId, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  natural_minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** One melody note: scale degree relative to the tonic (0 = tonic, 7 = octave above), in beats. */
export interface MotifNote { deg: number; t: number; dur: number }
export type Motif = MotifNote[];

export interface Preset {
  id: 'bittersweet' | 'beat' | 'playful';
  rules: RulesView;
  /** MIDI of the tonic in the melody octave. */
  tonic: number;
  bars: number;
  inst: Record<LayerRole, InstrumentId | null>;
  backdropMood: string;
  backdropHues: [number, number, number];
  planKeys: { home: string; away: string };
}

export const PRESETS: Record<Preset['id'], Preset> = {
  bittersweet: {
    id: 'bittersweet',
    rules: {
      style: 'bittersweet_orchestral', styleName: 'Bittersweet orchestral', bpm: 66, meter: '4/4',
      keyName: 'D', mode: 'dorian', harmonicLanguage: 'sevenths',
      palette: ['piano', 'violins', 'violas', 'celli', 'basses', 'harp', 'flute', 'horn'],
      soundWorld: 'large_hall', lengthSec: 88, form: 'arch', ending: 'suspended', keyPlan: 'relative',
    },
    tonic: 62, bars: 2,
    inst: {
      melody: 'piano', counter: 'flute', inner: 'violas', bass: 'celli', pedal: 'basses',
      figuration: 'harp', texture: 'violins', pulse: null, accents: 'horn',
    },
    backdropMood: 'rain on glass, sodium streetlight',
    backdropHues: [212, 28, 248],
    planKeys: { home: 'D dorian', away: 'F major' },
  },
  beat: {
    id: 'beat',
    rules: {
      style: 'beat_driven', styleName: 'Beat driven', bpm: 118, meter: '4/4',
      keyName: 'F#', mode: 'phrygian', harmonicLanguage: 'suspended',
      palette: ['pluck', 'pad', 'sub', 'kick808', 'noise', 'vibraphone'],
      soundWorld: 'electronic_hybrid', lengthSec: 98, form: 'slow_build', ending: 'sudden_stop', keyPlan: 'step_up_at_climax',
    },
    tonic: 66, bars: 4,
    inst: {
      melody: 'pluck', counter: 'vibraphone', inner: 'pad', bass: 'sub', pedal: 'sub',
      figuration: 'pluck', texture: 'pad', pulse: 'kick808', accents: 'noise',
    },
    backdropMood: 'neon arcade, magenta haze',
    backdropHues: [318, 190, 268],
    planKeys: { home: 'F# phrygian', away: 'G# phrygian' },
  },
  playful: {
    id: 'playful',
    rules: {
      style: 'playful', styleName: 'Playful', bpm: 132, meter: '4/4',
      keyName: 'G', mode: 'lydian', harmonicLanguage: 'triads',
      palette: ['celesta', 'clarinet', 'violins', 'celli', 'glockenspiel', 'harp', 'oboe'],
      soundWorld: 'close_dry', lengthSec: 88, form: 'theme_development_return', ending: 'resolved', keyPlan: 'none',
    },
    tonic: 67, bars: 4,
    inst: {
      melody: 'celesta', counter: 'clarinet', inner: 'violins', bass: 'celli', pedal: 'celli',
      figuration: 'harp', texture: 'glockenspiel', pulse: null, accents: 'oboe',
    },
    backdropMood: 'morning light, paper lanterns',
    backdropHues: [42, 160, 12],
    planKeys: { home: 'G lydian', away: 'G lydian' },
  },
};

export function presetForPrompt(prompt: string): Preset {
  const p = prompt.toLowerCase();
  if (/(boss|fight|neon|arcade|robot|danc|club|chase|city|engine|laser)/.test(p)) return PRESETS.beat;
  if (/(play|kitten|child|toy|bounce|joy|sun|morning|spring|picnic|sunrise)/.test(p)) return PRESETS.playful;
  if (/(rain|miss|3am|night|grief|alone|frozen|winter|goodbye|quiet|sea)/.test(p)) return PRESETS.bittersweet;
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
  return [PRESETS.bittersweet, PRESETS.beat, PRESETS.playful][h % 3];
}

// ───────────────────────────── Motifs and transformations ─────────────────────────────

/** Six theme drafts; index 2 is the one the mock judge accepts as theme A. */
export const THEME_DRAFTS: { motif: Motif; contour: string }[] = [
  { contour: 'rising line', motif: [
    { deg: 0, t: 0, dur: 1 }, { deg: 1, t: 1, dur: 1 }, { deg: 2, t: 2, dur: 1 }, { deg: 3, t: 3, dur: 1 },
    { deg: 4, t: 4, dur: 2 }, { deg: 5, t: 6, dur: 1 }, { deg: 4, t: 7, dur: 1 }] },
  { contour: 'falling sigh', motif: [
    { deg: 7, t: 0, dur: 1.5 }, { deg: 6, t: 1.5, dur: 0.5 }, { deg: 4, t: 2, dur: 2 },
    { deg: 5, t: 4, dur: 1.5 }, { deg: 4, t: 5.5, dur: 0.5 }, { deg: 2, t: 6, dur: 2 }] },
  { contour: 'arch with a falling fourth', motif: [
    { deg: 0, t: 0, dur: 1 }, { deg: 2, t: 1, dur: 0.5 }, { deg: 4, t: 1.5, dur: 0.5 }, { deg: 3, t: 2, dur: 1 },
    { deg: 1, t: 3, dur: 1 }, { deg: 2, t: 4, dur: 1.5 }, { deg: 4, t: 5.5, dur: 0.5 }, { deg: 5, t: 6, dur: 1 },
    { deg: 4, t: 7, dur: 1 }] },
  { contour: 'repeated note, then leap', motif: [
    { deg: 2, t: 0, dur: 0.5 }, { deg: 2, t: 0.5, dur: 0.5 }, { deg: 2, t: 1, dur: 1 }, { deg: 6, t: 2, dur: 2 },
    { deg: 5, t: 4, dur: 1 }, { deg: 4, t: 5, dur: 1 }, { deg: 2, t: 6, dur: 2 }] },
  { contour: 'wave', motif: [
    { deg: 4, t: 0, dur: 1 }, { deg: 2, t: 1, dur: 1 }, { deg: 3, t: 2, dur: 1 }, { deg: 1, t: 3, dur: 1 },
    { deg: 2, t: 4, dur: 1 }, { deg: 0, t: 5, dur: 1 }, { deg: 1, t: 6, dur: 2 }] },
  { contour: 'wide leaps', motif: [
    { deg: 0, t: 0, dur: 1 }, { deg: 7, t: 1, dur: 1 }, { deg: 3, t: 2, dur: 2 },
    { deg: 8, t: 4, dur: 1 }, { deg: 2, t: 5, dur: 1 }, { deg: 4, t: 6, dur: 2 }] },
];

export const THEME_A: Motif = THEME_DRAFTS[2].motif;

/** The contrast theme used in the departure. */
export const THEME_B: Motif = [
  { deg: 4, t: 0, dur: 2 }, { deg: 3, t: 2, dur: 1 }, { deg: 2, t: 3, dur: 1 },
  { deg: 5, t: 4, dur: 1.5 }, { deg: 4, t: 5.5, dur: 0.5 }, { deg: 2, t: 6, dur: 2 },
];

type Transform = (m: Motif) => Motif;

const shift = (n: number): Transform => (m) => m.map((x) => ({ ...x, deg: x.deg + n }));
const invert: Transform = (m) => m.map((x) => ({ ...x, deg: 2 * m[0].deg - x.deg }));
/** The last note takes over the time of the one before it. */
const tailExtended: Transform = (m) => {
  if (m.length < 3) return m;
  const head = m.slice(0, -2);
  const before = m[m.length - 2];
  const last = m[m.length - 1];
  return [...head, { deg: last.deg, t: before.t, dur: before.dur + last.dur }];
};
/** First half of the motif at double length. */
const headAugmented: Transform = (m) => m.filter((x) => x.t < 4).map((x) => ({ ...x, t: x.t * 2, dur: x.dur * 2 }));
/** The opening two beats, four times, each a step higher. */
const headRising: Transform = (m) => {
  const head = m.filter((x) => x.t < 2).map((x) => ({ ...x, dur: Math.min(x.dur, 2 - x.t) }));
  const out: Motif = [];
  for (let rep = 0; rep < 4; rep++) for (const x of head) out.push({ deg: x.deg + rep, t: x.t + rep * 2, dur: x.dur });
  return out;
};
const retrograde: Transform = (m) => {
  const end = 8;
  return [...m].reverse().map((x) => ({ deg: x.deg, t: end - (x.t + x.dur), dur: x.dur }));
};
const compose = (...fs: Transform[]): Transform => (m) => fs.reduce((acc, f) => f(acc), m);

export interface Recipe {
  lineage: string;
  source: 'A' | 'B';
  apply: Transform;
}

/** What the mock run accepts for each of its twelve phrases. */
export const RECIPES: Recipe[] = [
  { lineage: 'A', source: 'A', apply: (m) => m },
  { lineage: 'A, answered a step lower', source: 'A', apply: shift(-1) },
  { lineage: 'A, sequenced up a third', source: 'A', apply: shift(2) },
  { lineage: 'head of A, repeated and rising', source: 'A', apply: headRising },
  { lineage: 'A, inverted', source: 'A', apply: invert },
  { lineage: 'B (contrast theme)', source: 'B', apply: (m) => m },
  { lineage: 'B, sequenced down a step', source: 'B', apply: shift(-1) },
  { lineage: 'A, head augmented to double length', source: 'A', apply: headAugmented },
  { lineage: 'A, lifted a fifth, tail extended', source: 'A', apply: compose(shift(4), tailExtended) },
  { lineage: 'A, sequenced up a third, tail extended', source: 'A', apply: compose(shift(2), tailExtended) },
  { lineage: 'A, returned an octave lower', source: 'A', apply: shift(-7) },
  { lineage: 'A, tail drawn out into the cadence', source: 'A', apply: tailExtended },
];

/** Alternatives the judge sees next to the accepted recipe (and turns down). */
export const ALTERNATIVES: Recipe[] = [
  { lineage: 'A, backwards', source: 'A', apply: retrograde },
  { lineage: 'A, inverted and lifted a fourth', source: 'A', apply: compose(invert, shift(3)) },
  { lineage: 'B, inverted', source: 'B', apply: invert },
  { lineage: 'A, sequenced down a third', source: 'A', apply: shift(-2) },
  { lineage: 'head of A, rising, an octave up', source: 'A', apply: compose(headRising, shift(7)) },
  { lineage: 'B, tail extended', source: 'B', apply: tailExtended },
  { lineage: 'A, lifted a sixth', source: 'A', apply: shift(5) },
  { lineage: 'A backwards, tail extended', source: 'A', apply: compose(retrograde, tailExtended) },
];

// ───────────────────────────── Pitch helpers ─────────────────────────────

export function degreeToMidi(preset: Preset, deg: number): number {
  const steps = MODE_STEPS[preset.rules.mode];
  const octave = Math.floor(deg / 7);
  const idx = ((deg % 7) + 7) % 7;
  return preset.tonic + 12 * octave + steps[idx];
}

function chordName(preset: Preset, deg: number): string {
  const root = degreeToMidi(preset, deg);
  const third = degreeToMidi(preset, deg + 2) - root;
  const fifth = degreeToMidi(preset, deg + 4) - root;
  const seventh = degreeToMidi(preset, deg + 6) - root;
  const name = NOTE_NAMES[((root % 12) + 12) % 12];
  const lang = preset.rules.harmonicLanguage;
  if (lang === 'suspended') return `${name}sus4`;
  const minor = third === 3;
  const dim = minor && fifth === 6;
  if (lang === 'sevenths' || lang === 'extended') {
    if (dim) return `${name}m7b5`;
    if (minor) return seventh === 11 ? `${name}m(maj7)` : `${name}m7`;
    return seventh === 11 ? `${name}maj7` : `${name}7`;
  }
  return dim ? `${name}dim` : minor ? `${name}m` : name;
}

const DUR_CODE: [number, string][] = [[0.25, 's'], [0.5, 'e'], [0.75, 'e.'], [1, 'q'], [1.5, 'q.'], [2, 'h'], [3, 'h.'], [4, 'w']];

function durCode(dur: number): string {
  let best = DUR_CODE[0];
  for (const c of DUR_CODE) if (Math.abs(c[0] - dur) < Math.abs(best[0] - dur)) best = c;
  return best[1];
}

export function notationOf(preset: Preset, motif: Motif, beatsPerBar = 4): string {
  const parts: string[] = [];
  let bar = 0;
  for (const n of motif) {
    const b = Math.floor(n.t / beatsPerBar);
    if (b !== bar) {
      parts.push('|');
      bar = b;
    }
    parts.push(`${noteName(degreeToMidi(preset, n.deg))}${durCode(n.dur)}`);
  }
  return parts.join(' ');
}

function drawNotes(preset: Preset, motif: Motif): { midi: number; t: number; dur: number }[] {
  return motif.map((n) => ({ midi: degreeToMidi(preset, n.deg), t: n.t, dur: n.dur }));
}

// ───────────────────────────── Views for the panel ─────────────────────────────

export function themeDraftViews(preset: Preset): DraftView[] {
  return THEME_DRAFTS.map((d, i) => ({
    id: `t${i + 1}`,
    notation: notationOf(preset, d.motif),
    lineage: d.contour,
    notes: drawNotes(preset, d.motif),
    facts: factsOf(preset, d.motif),
  }));
}

export function themeView(preset: Preset, kind: 'main' | 'contrast'): ThemeView {
  const motif = kind === 'main' ? THEME_A : THEME_B;
  return {
    id: kind === 'main' ? 'A' : 'B',
    kind,
    notation: notationOf(preset, motif),
    contour: kind === 'main' ? THEME_DRAFTS[2].contour : 'long fall, late lift',
    notes: drawNotes(preset, motif),
  };
}

function factsOf(preset: Preset, motif: Motif): { label: string; value: string }[] {
  const midis = motif.map((n) => degreeToMidi(preset, n.deg));
  let leap = 0;
  for (let i = 1; i < midis.length; i++) leap = Math.max(leap, Math.abs(midis[i] - midis[i - 1]));
  return [
    { label: 'range', value: `${noteName(Math.min(...midis))} to ${noteName(Math.max(...midis))}` },
    { label: 'widest leap', value: `${leap} semitones` },
    { label: 'ends on', value: noteName(midis[midis.length - 1]) },
  ];
}

/** Chord degrees per bar pair, by phrase. */
const CHORD_PATH: [number, number][] = [
  [0, 3], [5, 4], [0, 5], [3, 4], [2, 5], [5, 3], [1, 4], [0, 3], [5, 6], [3, 4], [0, 3], [4, 0],
];

function sourceMotif(r: Recipe): Motif {
  return r.source === 'A' ? THEME_A : THEME_B;
}

export function draftFromRecipe(preset: Preset, id: string, recipe: Recipe, phrase: number): DraftView {
  const motif = recipe.apply(sourceMotif(recipe));
  const path = CHORD_PATH[phrase % CHORD_PATH.length];
  return {
    id,
    notation: notationOf(preset, motif),
    lineage: recipe.lineage,
    chords: path.map((d) => chordName(preset, d)),
    notes: drawNotes(preset, motif),
    facts: factsOf(preset, motif),
  };
}

// ───────────────────────────── Plan ─────────────────────────────

export const TOTAL_PHRASES = RECIPES.length;

export function planView(preset: Preset, revised: boolean): PlanView {
  const { home, away } = preset.planKeys;
  const phraseSec = (preset.bars * 4 * 60) / preset.rules.bpm;
  const sections: PlanView['sections'] = revised
    ? [
      { index: 0, role: 'statement', tension: 2, departure: false, phrases: [0, 2], keyName: home },
      { index: 1, role: 'development', tension: 4, departure: false, phrases: [3, 4], keyName: home },
      { index: 2, role: 'departure', tension: 3, departure: true, phrases: [5, 6], keyName: away },
      { index: 3, role: 'climax', tension: 7, departure: false, phrases: [7, 9], keyName: home },
      { index: 4, role: 'coda', tension: 1, departure: false, phrases: [10, 11], keyName: home },
    ]
    : [
      { index: 0, role: 'statement', tension: 2, departure: false, phrases: [0, 2], keyName: home },
      { index: 1, role: 'development', tension: 4, departure: false, phrases: [3, 4], keyName: home },
      { index: 2, role: 'departure', tension: 5, departure: true, phrases: [5, 6], keyName: away },
      { index: 3, role: 'climax', tension: 6, departure: false, phrases: [7, 9], keyName: home },
      { index: 4, role: 'return', tension: 3, departure: false, phrases: [10, 11], keyName: home },
    ];
  return { sections, totalPhrases: TOTAL_PHRASES, climaxPhrase: revised ? 9 : 8, phraseSec, revised };
}

// ───────────────────────────── Scores ─────────────────────────────

function clampStep(n: number): Step7 {
  return Math.max(0, Math.min(6, Math.round(n))) as Step7;
}

function mixFor(preset: Preset, tension: number): MixState {
  const world = preset.rules.soundWorld;
  return {
    dynamics: clampStep(tension - 1),
    lowpass: clampStep(world === 'submerged' ? 2 : 3 + tension / 2),
    reverb: clampStep(world === 'large_hall' ? 5 : world === 'close_dry' ? 1 : 3),
    delay: clampStep(world === 'electronic_hybrid' ? 3 : 1),
    noise: clampStep(world === 'submerged' ? 4 : 0),
    width: clampStep(2 + tension / 2),
    saturation: clampStep(world === 'electronic_hybrid' ? 3 : 1),
    chorus: world === 'electronic_hybrid',
    sidechain: preset.id === 'beat',
  };
}

export function buildScore(preset: Preset, index: number, plan: PlanView): PhraseScore {
  const recipe = RECIPES[index];
  const section = plan.sections.find((s) => index >= s.phrases[0] && index <= s.phrases[1]) ?? plan.sections[0];
  const role: PhraseRole = index === plan.climaxPhrase ? 'climax' : section.role;
  const tension = Math.max(1, Math.min(7, section.tension + (index === plan.climaxPhrase ? 1 : 0)));
  const beatsPerBar = 4;
  const beats = preset.bars * beatsPerBar;
  const final = index === TOTAL_PHRASES - 1;
  const path = CHORD_PATH[index % CHORD_PATH.length];

  // Melody: the transformed motif; four-bar presets answer it a step lower in the second half.
  let motif = recipe.apply(sourceMotif(recipe));
  if (preset.bars === 4) {
    const answer = shift(-1)(motif).map((n) => ({ ...n, t: n.t + 8 }));
    motif = [...motif, ...answer];
  }
  const vel = 0.42 + tension * 0.07;
  const inst = preset.inst;
  const notes: NoteEvent[] = [];
  const active: Partial<Record<LayerRole, { dynamics: Step7; art: NoteEvent['art']; detail: string }>> = {};

  const add = (layer: LayerRole, n: Omit<NoteEvent, 'layer' | 'inst'>): void => {
    const id = inst[layer];
    if (!id) return;
    notes.push({ ...n, inst: id, layer });
  };

  for (const n of motif) {
    add('melody', { t: n.t, dur: n.dur, midi: degreeToMidi(preset, n.deg), vel: Math.min(1, vel + 0.1), art: 'sustain' });
  }
  active.melody = { dynamics: clampStep(tension - 1), art: 'sustain', detail: recipe.lineage };

  // Chords change every two bars' worth of the phrase halves.
  const span = beats / 2;
  const chordAt = (half: number): number => path[half % 2];

  if (index >= 1 || final) {
    for (let h = 0; h < 2; h++) {
      add('bass', { t: h * span, dur: span, midi: degreeToMidi(preset, chordAt(h)) - 24, vel: Math.min(1, vel), art: 'sustain' });
    }
    active.bass = { dynamics: clampStep(tension - 1), art: 'sustain', detail: 'chord roots' };
  }
  if (index >= 2) {
    for (let h = 0; h < 2; h++) {
      for (const up of [2, 4]) {
        add('inner', { t: h * span, dur: span, midi: degreeToMidi(preset, chordAt(h) + up) - 12, vel: vel * 0.7, art: 'sustain' });
      }
    }
    active.inner = { dynamics: clampStep(tension - 2), art: 'sustain', detail: 'thirds and fifths' };
  }
  if (tension >= 4 && !final) {
    const pattern = [0, 2, 4, 7, 4, 2, 4, 2];
    for (let b = 0; b < beats * 2; b++) {
      const half = Math.floor(b / 2 / span);
      add('figuration', {
        t: b / 2, dur: 0.5, midi: degreeToMidi(preset, chordAt(half) + pattern[b % pattern.length]),
        vel: vel * 0.55, art: preset.id === 'beat' ? 'staccato' : 'sustain',
      });
    }
    active.figuration = { dynamics: clampStep(tension - 3), art: preset.id === 'beat' ? 'staccato' : 'sustain', detail: 'broken chords in eighths' };
  }
  if (tension >= 5) {
    for (let h = 0; h < 2; h++) {
      add('counter', { t: h * span + 1, dur: span - 1, midi: degreeToMidi(preset, chordAt(h) + 9), vel: vel * 0.65, art: 'sustain' });
    }
    active.counter = { dynamics: clampStep(tension - 3), art: 'sustain', detail: 'long notes above the melody' };
  }
  if (section.departure) {
    add('pedal', { t: 0, dur: beats, midi: degreeToMidi(preset, 0) - 24, vel: vel * 0.6, art: 'sustain' });
    active.pedal = { dynamics: clampStep(tension - 3), art: 'sustain', detail: 'tonic held under the new key' };
  }
  if (tension >= 6) {
    add('texture', { t: 0, dur: beats, midi: degreeToMidi(preset, chordAt(0) + 11), vel: vel * 0.5, art: preset.id === 'bittersweet' ? 'tremolo' : 'sustain' });
    active.texture = { dynamics: clampStep(tension - 3), art: preset.id === 'bittersweet' ? 'tremolo' : 'sustain', detail: 'high shimmer' };
  }
  if (inst.pulse && index >= 2 && !final) {
    for (let b = 0; b < beats; b++) add('pulse', { t: b, dur: 0.25, midi: 36, vel: 0.9, art: 'hit' });
    active.pulse = { dynamics: clampStep(tension), art: 'hit', detail: 'four on the floor' };
  }
  if (index === plan.climaxPhrase && inst.accents) {
    const pitched = inst.accents !== 'noise';
    add('accents', { t: 0, dur: pitched ? 2 : 0.5, midi: pitched ? degreeToMidi(preset, chordAt(0)) - 12 : 60, vel: 0.9, art: pitched ? 'sustain' : 'hit' });
    active.accents = { dynamics: 5, art: pitched ? 'sustain' : 'hit', detail: 'marks the climax' };
  }

  const roles: LayerRole[] = ['melody', 'counter', 'inner', 'bass', 'pedal', 'figuration', 'texture', 'pulse', 'accents'];
  const layers: LayerSummary[] = roles.map((r) => {
    const a = active[r];
    if (!a) return { role: r, inst: null, dynamics: 0, art: null, entry: 'continues' };
    const wasActive = previouslyActive(preset, index, plan, r);
    return {
      role: r, inst: inst[r], dynamics: a.dynamics, art: a.art,
      entry: wasActive ? 'continues' : r === 'texture' || r === 'pedal' ? 'fade_in' : r === 'counter' ? 'delayed' : 'immediate',
      detail: a.detail,
    };
  });

  const chordTones = [0, 2, 4].map((up) => degreeToMidi(preset, chordAt(1) + up) - 12);
  const holdInst: InstrumentId = inst.inner ?? 'pad';
  const score: PhraseScore = {
    index,
    section: section.index,
    role,
    bars: preset.bars,
    beatsPerBar,
    beats,
    bpm: preset.rules.bpm,
    notes: notes.sort((a, b) => a.t - b.t),
    pedal: inst.melody === 'piano'
      ? Array.from({ length: preset.bars }, (_, b) => [{ t: b * beatsPerBar, down: true }, { t: (b + 1) * beatsPerBar - 0.15, down: false }]).flat()
      : [],
    mix: mixFor(preset, tension),
    holdChord: chordTones.map((midi) => ({ midi, vel: 0.5, inst: holdInst, art: 'sustain' as const })),
    display: {
      key: section.keyName,
      notation: notationOf(preset, motif),
      lineage: recipe.lineage,
      chords: path.map((d) => chordName(preset, d)),
      layers,
      tension,
    },
  };
  if (final) {
    score.final = true;
    if (preset.rules.ending === 'sudden_stop') {
      score.cutAtBeat = beats - 1;
    } else {
      score.ritardando = { fromBeat: beats / 2, toBpm: Math.round(preset.rules.bpm * 0.62) };
      if (preset.rules.ending === 'fade') score.fadeOut = { fromBeat: beats / 2, toBeat: beats };
    }
  }
  return score;
}

/** Whether a layer was sounding in the phrase before, by the same rules buildScore uses. */
function previouslyActive(preset: Preset, index: number, plan: PlanView, role: LayerRole): boolean {
  if (index === 0) return false;
  const prev = index - 1;
  const section = plan.sections.find((s) => prev >= s.phrases[0] && prev <= s.phrases[1]) ?? plan.sections[0];
  const tension = section.tension + (prev === plan.climaxPhrase ? 1 : 0);
  switch (role) {
    case 'melody': return true;
    case 'bass': return prev >= 1;
    case 'inner': return prev >= 2;
    case 'figuration': return tension >= 4;
    case 'counter': return tension >= 5;
    case 'pedal': return section.departure;
    case 'texture': return tension >= 6;
    case 'pulse': return Boolean(preset.inst.pulse) && prev >= 2;
    case 'accents': return false;
    default: return false;
  }
}

/** Note names of a hold chord, for hold labels. */
export function holdNotes(preset: Preset, degrees: number[]): { midi: number; vel: number; inst: InstrumentId; art: 'sustain' }[] {
  const inst: InstrumentId = preset.inst.inner ?? 'pad';
  return degrees.map((d) => ({ midi: degreeToMidi(preset, d) - 12, vel: 0.5, inst, art: 'sustain' as const }));
}
