// The piece as it stands: the rules Drex set, its plan, the themes, every accepted phrase.
// Also the state builder: the text every request carries.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArrivalId, Articulation, EndingId, FormId, GrooveId, HarmonicLanguage, InstrumentId, KeyPlanId, LayerRole, LayerSummary,
  MixState, PartId, PhraseRole, PhraseScore, SoundWorld, StyleId,
} from '../shared/types.ts';
import { DYNAMIC_NAMES } from '../shared/types.ts';
import { notation, type Line } from './core/line.ts';
import type { Mood } from './core/mood.ts';
import { HARMONIC_LANGUAGE_TEXT, keyName, type Chord, type Key, type Meter } from './core/theory.ts';
import { pack, ROOT } from './pack.ts';

// ───────────────────────────── Instruments ─────────────────────────────

export interface InstrumentInfo {
  id: InstrumentId;
  name: string;
  /** Playable MIDI range. Notes are folded into it by octaves. */
  range: [number, number];
  character: string;
  synth?: boolean;
  arts: Articulation[];
}

const I = (id: InstrumentId, name: string, range: [number, number], character: string, arts: Articulation[], synth = false): InstrumentInfo =>
  ({ id, name, range, character, arts, synth });

export const INSTRUMENTS: Record<string, InstrumentInfo> = Object.fromEntries(
  [
    I('piano', 'Grand piano', [21, 108], 'clear, intimate, percussive attack that decays; carries melody or arpeggios', ['sustain']),
    I('violins', 'First violins', [55, 98], 'singing, bright on top, the natural melody section', ['sustain', 'staccato', 'tremolo', 'pizzicato']),
    I('violins2', 'Second violins', [55, 91], 'warm inner support below the firsts', ['sustain', 'staccato', 'tremolo', 'pizzicato']),
    I('violas', 'Violas', [48, 84], 'dusky, veiled middle voice', ['sustain', 'staccato', 'tremolo', 'pizzicato']),
    I('celli', 'Celli', [36, 74], 'rich tenor voice, ardent when it sings high', ['sustain', 'staccato', 'tremolo', 'pizzicato']),
    I('basses', 'Double basses', [28, 55], 'deep foundation, weight', ['sustain', 'staccato', 'tremolo', 'pizzicato']),
    I('solo_violin', 'Solo violin', [55, 98], 'a single fragile, personal voice', ['sustain', 'staccato', 'tremolo', 'pizzicato']),
    I('flute', 'Flute', [60, 96], 'pure and airy, cool low, brilliant high', ['sustain', 'staccato']),
    I('oboe', 'Oboe', [58, 88], 'plaintive, reedy, penetrating', ['sustain', 'staccato']),
    I('clarinet', 'Clarinet', [50, 89], 'smooth and mellow, playful when staccato', ['sustain', 'staccato']),
    I('horn', 'French horn', [41, 74], 'noble, round, distant warmth', ['sustain', 'staccato']),
    I('harp', 'Harp', [31, 100], 'plucked shimmer, arpeggios and glints', ['sustain']),
    I('timpani', 'Timpani', [40, 57], 'pitched thunder, rolls and strokes', ['hit', 'roll']),
    I('bass_drum', 'Orchestral bass drum', [36, 36], 'a deep impact', ['hit']),
    I('cymbal', 'Cymbals', [49, 49], 'crash or swelling roll', ['hit', 'roll']),
    I('tam_tam', 'Tam-tam', [52, 52], 'dark metallic wash', ['hit']),
    I('drumkit', 'Drum kit', [36, 51], 'kick, snare, hi-hats, toms and cymbals: the beat itself in pop, hip-hop, funk and dance music', ['hit']),
    I('celesta', 'Celesta', [60, 108], 'small bells, childlike sparkle', ['sustain']),
    I('glockenspiel', 'Glockenspiel', [72, 108], 'bright metal sparkle on top', ['sustain']),
    I('vibraphone', 'Vibraphone', [53, 89], 'soft glowing metal, cool', ['sustain']),
    I('sub', 'Sub bass (sine)', [24, 48], 'pure low weight, felt more than heard', ['sustain'], true),
    I('pad', 'Synth pad', [36, 84], 'slow, smooth electronic bed', ['sustain'], true),
    I('pluck', 'Pluck synth', [36, 96], 'short bright electronic pluck', ['staccato'], true),
    I('kick808', 'Electronic kick (808)', [36, 36], 'round low electronic thump; with a drum kit in the palette, the kit plays snare and hats around it', ['hit'], true),
    I('noise', 'Water and wave texture', [60, 60], 'filtered noise with a slow swell: water, air', ['sustain'], true),
    // The sounds of pop, dance and hip-hop production. Offered to beat-driven pieces only.
    I('keys', 'Electric piano', [36, 96], 'warm, glassy electric piano: the chords and fills of pop, R&B and neo-soul', ['sustain', 'staccato'], true),
    I('lead', 'Synth lead', [48, 96], 'a bright, cutting synth lead: the voice that carries a hook in pop and dance music', ['sustain', 'staccato'], true),
    I('supersaw', 'Supersaw stack', [36, 91], 'a wide wall of detuned saw waves: the huge chords of a dance-pop chorus', ['sustain', 'staccato'], true),
    I('synth_bass', 'Synth bass', [24, 60], 'a punchy, buzzy synth bass with bite: funk, electro and pop bass lines that move', ['sustain', 'staccato'], true),
    I('bell', 'Bell synth', [60, 108], 'a glassy digital bell: sparkling hooks and answers on top, as in trap and pop', ['sustain'], true),
    I('brass', 'Synth brass', [43, 86], 'punchy synth brass: stabs and riffs, the horn section of funk and eighties pop', ['sustain', 'staccato'], true),
  ].map((i) => [i.id, i]),
);

/** Production sounds that belong to beat-driven music, and the orchestral ones that do not. */
export const MODERN_SOUNDS: InstrumentId[] = ['keys', 'lead', 'supersaw', 'synth_bass', 'bell', 'brass'];
const BEAT_SOUNDS: InstrumentId[] = [...MODERN_SOUNDS, 'sub', 'pad', 'pluck', 'kick808', 'noise', 'drumkit', 'piano'];
/** The instruments a style may draw on: a pop song is not scored for clarinet, nor a string elegy for supersaws. */
export const offeredTo = (style: StyleId, id: string): boolean => (style === 'beat_driven' ? BEAT_SOUNDS.includes(id as InstrumentId) : !MODERN_SOUNDS.includes(id as InstrumentId));

/** Which instruments can take each layer role (the layering table). */
export const ROLE_INSTRUMENTS: Record<LayerRole, InstrumentId[]> = {
  melody: ['piano', 'solo_violin', 'violins', 'flute', 'oboe', 'clarinet', 'pluck', 'celesta', 'glockenspiel', 'vibraphone', 'lead', 'keys', 'bell', 'brass'],
  counter: ['celli', 'violas', 'horn', 'clarinet', 'violins2', 'oboe', 'flute', 'vibraphone', 'keys', 'brass', 'bell', 'lead'],
  inner: ['violas', 'violins2', 'pad', 'piano', 'horn', 'keys', 'supersaw', 'brass'],
  bass: ['basses', 'celli', 'piano', 'sub', 'synth_bass'],
  pedal: ['basses', 'celli', 'piano', 'horn', 'sub', 'synth_bass'],
  figuration: ['piano', 'harp', 'violins2', 'violas', 'pluck', 'celesta', 'keys', 'bell'],
  texture: ['noise', 'violins', 'pad', 'cymbal', 'supersaw'],
  pulse: ['drumkit', 'kick808', 'timpani'],
  accents: ['bass_drum', 'cymbal', 'timpani', 'piano', 'tam_tam', 'drumkit'],
};

let availableCache: Set<string> | null = null;

/** Instruments that can actually sound: sampled ones present in the manifest, plus the synths. */
export function availableInstruments(): Set<string> {
  if (availableCache) return availableCache;
  const out = new Set<string>(Object.values(INSTRUMENTS).filter((i) => i.synth).map((i) => i.id));
  const file = join(ROOT, 'assets/samples/manifest.json');
  if (existsSync(file)) {
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      for (const id of Object.keys(manifest.instruments ?? {})) {
        if (INSTRUMENTS[id]) out.add(id);
        const inst = INSTRUMENTS[id];
        // Keep lines inside what was actually sampled (a couple of semitones of pitch-shift either side is fine).
        const sampled = manifest.instruments[id].range;
        if (inst && Array.isArray(sampled) && sampled.length === 2 && sampled[1] > sampled[0]) {
          const lo = Math.max(inst.range[0], sampled[0] - 2);
          const hi = Math.min(inst.range[1], sampled[1] + 3);
          if (hi - lo >= 12) inst.range = [lo, hi];
        }
        const arts = Object.keys(manifest.instruments[id].articulations ?? {});
        if (inst && arts.length) {
          // Keep only articulations that exist, plus the ones the audio engine can fake from them.
          const has = (a: string) => arts.includes(a);
          inst.arts = inst.arts.filter((a) => has(a) || (a === 'staccato' && has('spiccato')) || (a === 'tremolo' && has('sustain')) || (a === 'pizzicato' && (has('staccato') || has('spiccato'))) || (a === 'sustain' && arts.length > 0));
          if (id === 'violins' && INSTRUMENTS.violins2) {
            INSTRUMENTS.violins2.arts = inst.arts.slice();
            INSTRUMENTS.violins2.range = [inst.range[0], Math.min(INSTRUMENTS.violins2.range[1], inst.range[1])];
          }
          if (!inst.arts.length) inst.arts = arts as Articulation[];
        }
      }
      if (out.has('violins')) out.add('violins2');
      availableCache = out;
      return out;
    } catch {
      /* fall through */
    }
  }
  // No manifest yet: assume the standard set.
  for (const i of Object.values(INSTRUMENTS)) if (!['celesta', 'glockenspiel', 'vibraphone', 'tam_tam'].includes(i.id)) out.add(i.id);
  return out;
}

// ───────────────────────────── Rules, plan, themes ─────────────────────────────

/** The groove families of the beat-driven sheet, as Drex reads them. */
export const GROOVES: Record<GrooveId, { label: string; text: string; bpm: number; patterns: string[] }> = {
  house: { label: 'house', bpm: 124, patterns: ['four_on_floor', 'half_time', 'syncopated'],
    text: 'house and dance: a four-on-the-floor kick at 118 to 128 BPM, open hats off the beat, long filter builds and drops' },
  boom_bap: { label: 'boom-bap', bpm: 90, patterns: ['boom_bap', 'half_time', 'backbeat'],
    text: 'boom-bap hip-hop: 82 to 96 BPM, heavy swung drums, kick and snare trading blows with space between, a short looped motif' },
  trap: { label: 'trap', bpm: 140, patterns: ['trap', 'half_time', 'syncopated'],
    text: 'trap and modern rap: 130 to 150 BPM felt in half time, the snare on beat three, fast hi-hats with rolls, long 808 bass notes that hit with the kick' },
  funk: { label: 'funk', bpm: 104, patterns: ['funk', 'backbeat', 'syncopated'],
    text: 'funk: 95 to 115 BPM, sixteenth-note hats, kick and bass locked in a syncopated figure, ghost notes on the snare, everything pointing at beat one' },
  // Smooth beats are the centre of this style. Chart pop was tried and dropped: its sound needs vocals and production we do not have.
  lofi: { label: 'lo-fi', bpm: 80, patterns: ['boom_bap', 'half_time', 'backbeat'],
    text: 'lo-fi and chill beats: 70 to 90 BPM, soft swung drums that sit back, mellow electric-piano chords with sevenths and ninths, a warm round bass, a short unhurried motif, everything gentle and a little hazy' },
};

export interface Rules {
  style: StyleId;
  /** Beat-driven pieces only. */
  groove?: GrooveId;
  bpm: number;
  meter: Meter;
  key: Key;
  harmonicLanguage: HarmonicLanguage;
  palette: InstrumentId[];
  soundWorld: SoundWorld;
  lengthSec: number;
  form: FormId;
  ending: EndingId;
  keyPlan: KeyPlanId;
}

export interface Section {
  index: number;
  role: PhraseRole;
  /** Beat-driven pieces: the song part (verse, chorus…) Drex gave this section. */
  part?: PartId;
  /** 1..7 */
  tension: number;
  departure: boolean;
  first: number;
  last: number;
  key: Key;
  /** Set when sections come from a video. */
  startSec?: number;
  endSec?: number;
}

export interface Plan {
  sections: Section[];
  totalPhrases: number;
  climaxPhrase: number;
  /** How the climax arrives; Drex's choice in the plan call. */
  climaxArrival: ArrivalId;
  /** What the melody is at the climax: the theme back whole, the theme broadened, or development carrying on. Drex's choice. */
  climaxTheme: ClimaxTheme;
  /** The theme is stated a second time, in a new light, straight after the first. Drex's choice. */
  restate: boolean;
  needsCounter: boolean;
  needsContrast: boolean;
  /** Song form: how loud each kind of part is (0 pp … 6 fff). Drex's choice in the plan, so every chorus is a peak and every verse drops back. */
  partLevels?: Partial<Record<PartId, number>>;
}

export interface Theme {
  id: string;
  kind: 'main' | 'counter' | 'contrast';
  line: Line;
  contour: string;
  /** How a derived theme came about. */
  derivation?: string;
}

export interface SegmentChoice {
  source: string;
  ops: string[];
}

export interface Direction {
  seg1: SegmentChoice;
  seg2: SegmentChoice;
  counter: string;
  flags: Record<string, boolean>;
  harmonicRhythm: string;
  ending: string;
  modulation?: string;
}

export interface Slot {
  /** Start beat and length within the phrase. */
  t: number;
  dur: number;
  chord: Chord;
  bass: string;
  /** Inner voices sounding during the slot (MIDI). */
  voices: number[];
}

export interface PhraseRecord {
  index: number;
  section: number;
  role: PhraseRole;
  key: Key;
  direction: Direction;
  /** Melody in scale degrees across the whole phrase. */
  line: Line;
  lineage: string;
  /** Number of derivation steps away from a stated theme. */
  depth: number;
  slots: Slot[];
  themeIntact: boolean;
  /** Share of the main theme kept, 0..1. */
  related: number;
  layers: LayerSummary[];
  mix: MixState;
  score: PhraseScore;
  /** How the phrase closed, how its melody began and how it was joined to the phrase before: Drex's choices, kept as facts for later phrases. */
  close?: string;
  start?: string;
  join?: string;
  /** Notes to sound before this phrase's first bar line (t is negative, in beats). They are written into the end of the phrase before. */
  leadIn?: PhraseScore['notes'];
}

export const PHRASE_BARS = 4;

/** The ways a climax can arrive, as Drex reads them. */
export const ARRIVAL_TEXT: Record<ArrivalId, string> = {
  swell: 'no break: the peak simply arrives at the top of a long crescendo, with the pulse carrying straight through. Continuous and gentle; for pieces that should never shock',
  hit: 'a hit: one accented blow lands on top of the same texture, which then carries on as before. A landmark, not a change of state',
  open_wall: 'a held breath, then the wall: everything stops for an instant, then the pulse and figuration fall away and the whole ensemble opens into one sustained wall of sound, at full volume with the filter fully open. Overwhelming force: for pieces that are vast, triumphant or tragic',
  broaden: 'the same held breath and wall of sound, and the tempo also broadens at the arrival, so the peak feels vast and slowed, time stretching',
  bloom: 'a held breath, then a clearing: the motion stops and the music opens out, bright and still. Pulse, figuration and counter-lines fall away; the melody sings slow and high on one or two instruments over long held chords, the filter fully open, only a little louder than before. Awe through stillness and light, not through force: gentle, serene, the feeling of the piece settling in',
  drop: 'the drop: the beat thins to almost nothing for a bar, a breath of silence, then kick, bass and every layer slam back in together at full weight with the filter wide open',
};
/** Which arrivals each style offers: an orchestral wall loses the pulse, which is the opposite of what a beat wants at its peak. */
// A smooth lo-fi beat never slams: it is not offered the drop.
export const arrivalsFor = (style: StyleId, groove?: GrooveId): ArrivalId[] => (groove === 'lofi' ? ['swell', 'hit'] : style === 'beat_driven' ? ['swell', 'hit', 'drop'] : ['swell', 'hit', 'bloom', 'open_wall', 'broaden']);
/** The climax arrives after everything stops for a moment. */
export const arrivesAfterBreath = (a: ArrivalId | undefined): boolean => a === 'open_wall' || a === 'broaden' || a === 'drop' || a === 'bloom';
export type ClimaxTheme = 'returns' | 'broadened' | 'continues';
export const CLIMAX_THEME_TEXT: Record<ClimaxTheme, string> = {
  returns: 'the main theme returns whole and plainly recognisable: the moment everything before was leading to, a homecoming',
  broadened: 'the main theme returns at half speed, in long notes over the whole phrase: the same tune made vast and grave',
  continues: 'no return: the climax is the furthest point of the development, the theme still in pieces',
};
export const ARRIVAL_LABEL: Record<ArrivalId, string> = {
  swell: 'swell, no break', hit: 'a hit', open_wall: 'held breath, then the wall', broaden: 'held breath, wall, tempo broadens', bloom: 'held breath, then a still, bright clearing', drop: 'the drop',
};
/** The climax arrives as a wall of sound (with or without broadening). */
export const isWall = (a: ArrivalId | undefined): boolean => a === 'open_wall' || a === 'broaden';

/** Song parts of a beat-driven piece, as Drex reads them, and the phrase role each one works as. */
export const PART_TEXT: Record<PartId, string> = {
  intro: 'intro: sets up the groove and teases the hook, thin, before the song proper begins',
  verse: 'verse: the groove settles and the texture stays lean; the hook is held back or only hinted at',
  prechorus: 'pre-chorus: a short lift that builds toward the chorus, energy rising, something held back',
  chorus: 'chorus: the hook, whole, in the fullest texture so far. The same music every time it comes back; what the listener waits for',
  bridge: 'bridge or breakdown: a contrast: the beat thins or drops away and new material appears, so the last chorus lands fresh',
  outro: 'outro: the groove winds down, layers leaving one by one',
};
export const PART_ROLE: Record<PartId, PhraseRole> = { intro: 'statement', verse: 'development', prechorus: 'development', chorus: 'return', bridge: 'departure', outro: 'coda' };

/** What the picture is doing under one phrase. Only set when the engine is scoring a video. */
export interface PictureCue {
  /** Lines added to the state (VIDEO, AHEAD). */
  lines: string[];
  /** 1 still … 7 frantic, averaged over the phrase's span. */
  movement: number;
  quality: string;
  bodyLevel: string;
  mood: string;
  change: string;
  /** A high point inside the phrase, as a beat position. */
  peak?: { beat: number; strength: number };
  /** A scene cut inside the phrase, as a beat position. */
  cut?: { beat: number };
}

export class Piece {
  rules!: Rules;
  plan!: Plan;
  themes: Theme[] = [];
  phrases: PhraseRecord[] = [];
  /** Inner voices at the end of the last accepted phrase. */
  voices: number[] = [];
  lastChord: Chord | null = null;
  lastReject = '';
  endingPlan: Record<string, string> | null = null;
  /** Per-phrase overrides: the broadened climax sets the tempo of one phrase; fitting music to picture sets all three. */
  phraseBars = new Map<number, number>();
  phraseBpm = new Map<number, number>();
  /** Seconds of held chord appended to a phrase so the music lands on a cut. */
  phraseHoldSec = new Map<number, number>();
  picture: ((phrase: number) => PictureCue | null) | null = null;
  /** Lines added to every state before any music exists (the clip timeline, when scoring a video). */
  preludeLines: string[] = [];
  /** How many bars the theme fills: Drex's choice when the theme is shaped. */
  themeBars = 2;

  constructor(public prompt: string, public mood: Mood) {}

  /** The beats one theme fills. */
  get unitBeats(): number {
    return this.themeBars * this.rules.meter.beatsPerBar;
  }
  /** Where the second half of a phrase's melody begins. A five-bar phrase is four bars with its close prolonged; a six-bar phrase says its first idea twice. */
  segStart(phrase: number): number {
    const bars = this.barsOf(phrase);
    return (bars === 6 ? 4 : bars === 5 ? 2 : Math.ceil(bars / 2)) * this.rules.meter.beatsPerBar;
  }
  /** The chorus this phrase belongs to (beat-driven pieces): which chorus it is, and the phrase of the first chorus it repeats. */
  chorusAt(phrase: number): { n: number; of: number; first: boolean; source: number | null; starts: boolean } | null {
    if (!this.plan || phrase < 0 || phrase >= this.plan.totalPhrases) return null;
    // Neighbouring chorus sections are one chorus.
    const runs: { first: number; last: number }[] = [];
    this.plan.sections.forEach((s, i, all) => {
      if (s.part !== 'chorus') return;
      if (i > 0 && all[i - 1].part === 'chorus') runs[runs.length - 1].last = s.last;
      else runs.push({ first: s.first, last: s.last });
    });
    const n = runs.findIndex((r) => phrase >= r.first && phrase <= r.last);
    if (n < 0) return null;
    const span = runs[0].last - runs[0].first + 1;
    return { n: n + 1, of: runs.length, first: n === 0, source: n === 0 ? null : runs[0].first + ((phrase - runs[n].first) % span), starts: phrase === runs[n].first };
  }
  /** Nominal phrase length in seconds at the base tempo. */
  get phraseSec(): number {
    return (PHRASE_BARS * this.rules.meter.beatsPerBar * 60) / this.rules.bpm;
  }
  barsOf(phrase: number): number {
    return this.phraseBars.get(phrase) ?? PHRASE_BARS;
  }
  bpmOf(phrase: number): number {
    return this.phraseBpm.get(phrase) ?? this.rules.bpm;
  }
  beatsOf(phrase: number): number {
    return this.barsOf(phrase) * this.rules.meter.beatsPerBar;
  }
  /** Half a phrase: where its second half begins. */
  halfOf(phrase: number): number {
    return Math.ceil(this.barsOf(phrase) / 2) * this.rules.meter.beatsPerBar;
  }
  get grid(): number {
    return this.rules.meter.sub === 3 ? 1 / 3 : 0.5;
  }
  theme(id: string): Theme | undefined {
    return this.themes.find((t) => t.id === id);
  }
  get mainTheme(): Theme {
    return this.themes[0];
  }
  sectionOf(phrase: number): Section {
    return this.plan.sections.find((s) => phrase >= s.first && phrase <= s.last) ?? this.plan.sections[this.plan.sections.length - 1];
  }

  /** The role of one phrase: the section's role, refined by position. */
  roleOf(phrase: number): PhraseRole {
    const s = this.sectionOf(phrase);
    if (phrase === this.plan.climaxPhrase) return 'climax';
    // Every phrase of a chorus is the hook coming back.
    if (s.part === 'chorus') return 'return';
    // Drex chose to state the theme twice at the start: the second statement comes back in a new light.
    if (this.plan.restate && phrase === 1 && s.index === 0 && s.last >= 1) return 'return';
    if (phrase === this.plan.totalPhrases - 1 && s.role !== 'departure') return 'coda';
    if (s.role === 'statement' || s.role === 'return') return phrase === s.first ? s.role : 'development';
    if (s.role === 'climax') return 'development';
    return s.role;
  }

  /** Target tension for a phrase, easing toward the next section across the section. */
  tensionOf(phrase: number): number {
    const s = this.sectionOf(phrase);
    const cue = this.picture?.(phrase);
    // Scoring to picture: the frames drive the tension target inside the section's planned level.
    const lift = cue ? (cue.movement - 4) * 0.35 + (cue.peak ? (cue.peak.strength - 4) * 0.2 : 0) : 0;
    const bound = (t: number) => Math.round(Math.min(7, Math.max(1, t + lift)) * 10) / 10;
    // Without a picture the climax is always a peak; with one, a still picture keeps even its climax quiet.
    if (phrase === this.plan.climaxPhrase) return bound(cue ? s.tension + 0.5 : Math.max(s.tension, 6));
    const next = this.plan.sections[s.index + 1];
    const span = s.last - s.first + 1;
    if (!next || span <= 1) return bound(s.tension);
    const x = (phrase - s.first) / span;
    return bound(s.tension + (next.tension - s.tension) * x * 0.5);
  }

  phrasesSinceThemeIntact(): number {
    for (let i = this.phrases.length - 1; i >= 0; i--) {
      if (this.phrases[i].themeIntact) return this.phrases.length - i;
    }
    return this.phrases.length;
  }

  // ───────────────────────────── State text ─────────────────────────────

  private pieceLine(): string {
    const r = this.rules;
    const mins = Math.floor(r.lengthSec / 60);
    const secs = String(Math.round(r.lengthSec % 60)).padStart(2, '0');
    return `PIECE   style: ${pack.sheet(r.style).name}; ${r.meter.id}, ${r.bpm} BPM, ${keyName(r.key)}, ${r.soundWorld.replace(/_/g, ' ')}, ${mins}:${secs}; harmony: ${HARMONIC_LANGUAGE_TEXT[r.harmonicLanguage]}${r.groove ? `; groove: ${GROOVES[r.groove].text}` : ''}`;
  }

  private planLine(): string {
    const p = this.plan;
    const deps = p.sections.filter((s) => s.departure).map((s) => s.index + 1);
    return (
      `PLAN    ${p.sections.length} sections, ${p.sections.some((s) => s.part) ? `parts ${p.sections.map((s) => s.part ?? s.role).join(' / ')}` : `roles ${p.sections.map((s) => s.role).join(' / ')}`}; tension ${p.sections.map((s) => s.tension).join(' ')} (1 calm … 7 overwhelming); ` +
      `departure = ${deps.length ? deps.join(', ') : 'none'}; climax = phrase ${p.climaxPhrase + 1} (section ${this.sectionOf(p.climaxPhrase).index + 1}), arriving as ${ARRIVAL_LABEL[p.climaxArrival ?? 'hit']}${p.climaxTheme === 'returns' ? ', with the main theme returning whole' : p.climaxTheme === 'broadened' ? ', with the main theme returning at half speed' : ''}; ending: ${this.rules.ending.replace(/_/g, ' ')}`
    );
  }

  themeLines(): string {
    return this.themes
      .map((t) => `THEME ${t.id} ${notation(t.line)}   contour: ${t.contour}${t.kind !== 'main' ? `   (${t.kind}${t.derivation ? `: ${t.derivation}` : ''})` : ''}`)
      .join('\n');
  }

  private lastFour(): string {
    const last = this.phrases.slice(-4);
    if (!last.length) return 'LAST 4  (none yet: this is the first phrase)';
    return (
      'LAST 4  ' +
      last
        .map((p) => `phrase ${p.index + 1} [${p.role}] ${notation(p.line)} | chords ${p.score.display.chords.join(' ')} | = ${p.lineage}`)
        .join('\n        ')
    );
  }

  mixLine(): string {
    const last = this.phrases[this.phrases.length - 1];
    if (!last) return 'MIX     (silence: nothing has played yet)';
    const layers = last.layers.filter((l) => l.inst).map((l) => `${l.role}: ${INSTRUMENTS[l.inst!]?.name ?? l.inst} ${DYNAMIC_NAMES[l.dynamics]}${l.art && l.art !== 'sustain' ? ` ${l.art}` : ''}`);
    const pitches = last.score.notes.filter((n) => n.inst !== 'noise' && n.layer !== 'pulse' && n.layer !== 'accents').map((n) => n.midi);
    const lo = pitches.length ? Math.floor(Math.min(...pitches) / 12) - 1 : 0;
    const hi = pitches.length ? Math.floor(Math.max(...pitches) / 12) - 1 : 0;
    return `MIX     ${layers.join(', ') || 'nothing'}; registers ${lo}-${hi} occupied; overall ${DYNAMIC_NAMES[last.mix.dynamics]}`;
  }

  /** State for the setup and plan calls, before any music exists. */
  preludeState(callType: Parameters<typeof pack.theory>[0], extra: string[] = []): string {
    const lines = [`PROMPT  "${this.prompt}"`];
    if (this.rules) lines.push(this.pieceLine(), pack.styleText(this.rules.style));
    lines.push(...this.preludeLines, ...extra);
    const theory = pack.theory(callType, this.rules?.style);
    if (theory) lines.push(theory);
    return lines.join('\n');
  }

  /** The full state block for calls made while composing phrase `phrase`. */
  state(callType: Parameters<typeof pack.theory>[0], phrase: number, extra: string[] = []): string {
    const s = this.sectionOf(phrase);
    const lines = [
      `PROMPT  "${this.prompt}"`,
      this.pieceLine(),
      pack.styleText(this.rules.style),
      this.planLine(),
      `NOW     section ${s.index + 1}, phrase ${phrase + 1} of ${this.plan.totalPhrases}, role: ${this.roleOf(phrase)}${s.part ? `, song part: ${s.part}${this.chorusAt(phrase) ? ` ${this.chorusAt(phrase)!.n} of ${this.chorusAt(phrase)!.of}` : ''}` : ''}, target tension ${this.tensionOf(phrase)}, key ${keyName(s.key)}`,
      this.themeLines(),
      this.lastFour(),
    ];
    const last = this.phrases[this.phrases.length - 1];
    if (last) lines.push(`LINEAGE phrase ${last.index + 1} = ${last.lineage}`);
    lines.push(`SINCE   theme intact: ${this.phrases.length ? `${this.phrasesSinceThemeIntact()} phrases ago` : 'not yet stated'}`);
    lines.push(this.mixLine());
    if (this.lastReject) lines.push(`REJECTS last round: "${this.lastReject}"`);
    const cue = this.picture?.(phrase);
    if (cue) lines.push(...cue.lines);
    lines.push(...extra);
    const theory = pack.theory(callType, this.rules?.style);
    if (theory) lines.push(theory);
    return lines.filter(Boolean).join('\n');
  }
}
