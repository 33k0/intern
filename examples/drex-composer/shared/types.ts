// Shared contract between the composer server and the browser (audio engine + live panel).
// Everything the browser plays or shows arrives as one of these shapes over the /ws socket.

// ───────────────────────────── Music basics ─────────────────────────────

export type StyleId = 'bittersweet_orchestral' | 'beat_driven' | 'playful';
/** Groove family of a beat-driven piece: Drex picks one at setup. */
export type GrooveId = 'lofi' | 'boom_bap' | 'trap' | 'funk' | 'house';
export type MeterId = '4/4' | '3/4' | '6/8' | '12/8' | '5/4' | '7/8';
export type ModeId =
  | 'major' | 'natural_minor' | 'harmonic_minor' | 'melodic_minor'
  | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian';
export type HarmonicLanguage = 'triads' | 'sevenths' | 'extended' | 'suspended' | 'chromatic';
export type SoundWorld = 'close_dry' | 'large_hall' | 'submerged' | 'electronic_hybrid';
export type FormId = 'arch' | 'slow_build' | 'theme_development_return' | 'through_composed' | 'verse_like';
export type EndingId = 'resolved' | 'suspended' | 'fade' | 'sudden_stop';
export type KeyPlanId = 'none' | 'relative' | 'step_up_at_climax' | 'distant_dark_turn';
/** How the climax arrives: Drex picks one in the plan call. */
export type ArrivalId = 'swell' | 'hit' | 'open_wall' | 'broaden' | 'bloom' | 'drop';
/** Song parts of a beat-driven piece (verse and chorus form). */
export type PartId = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro';
export type PhraseRole = 'statement' | 'development' | 'departure' | 'return' | 'climax' | 'coda';

export type LayerRole =
  | 'melody' | 'counter' | 'inner' | 'bass' | 'pedal'
  | 'figuration' | 'texture' | 'pulse' | 'accents';

/** Sampled instruments come from assets/samples/manifest.json; the last two rows are Tone.js synths. */
export type InstrumentId =
  | 'piano' | 'violins' | 'violins2' | 'violas' | 'celli' | 'basses' | 'solo_violin'
  | 'flute' | 'oboe' | 'clarinet' | 'horn' | 'harp'
  | 'timpani' | 'bass_drum' | 'cymbal' | 'drumkit'
  | 'celesta' | 'glockenspiel' | 'vibraphone' | 'tam_tam'
  | 'sub' | 'pad' | 'pluck' | 'kick808' | 'noise'
  | 'keys' | 'lead' | 'supersaw' | 'synth_bass' | 'bell' | 'brass';

export type Articulation =
  | 'sustain' | 'staccato' | 'spiccato' | 'tremolo' | 'pizzicato' | 'hit' | 'roll';

/** Seven-step scale used for dynamics and effect amounts: 0 (least) … 6 (most). */
export type Step7 = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const DYNAMIC_NAMES = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'] as const;

// ───────────────────────────── What the audio engine plays ─────────────────────────────

export interface NoteEvent {
  /** Start, in beats from the start of the phrase. */
  t: number;
  /** Length in beats (ignored for one-shot articulations). */
  dur: number;
  /** MIDI note (60 = middle C). Unpitched instruments use the pseudo-notes in the sample manifest. */
  midi: number;
  /** 0..1 */
  vel: number;
  inst: InstrumentId;
  art: Articulation;
  layer: LayerRole;
}

export interface MixState {
  /** Overall dynamics, pp..fff. */
  dynamics: Step7;
  /** 0 = submerged (heavily low-passed), 6 = fully open. */
  lowpass: Step7;
  /** 0 = dry, 6 = vast. */
  reverb: Step7;
  delay: Step7;
  /** Water / air noise texture level. */
  noise: Step7;
  /** 0 = narrow and intimate, 6 = wide. */
  width: Step7;
  saturation: Step7;
  chorus: boolean;
  sidechain: boolean;
}

export interface HoldNote {
  midi: number;
  vel: number;
  inst: InstrumentId;
  art: Articulation;
}

export interface LayerSummary {
  role: LayerRole;
  inst: InstrumentId | null;
  dynamics: Step7;
  art: Articulation | null;
  /** How the layer came in this phrase. */
  entry: 'continues' | 'immediate' | 'fade_in' | 'delayed';
  detail?: string;
}

export interface PhraseScore {
  index: number;
  section: number;
  role: PhraseRole;
  bars: number;
  beatsPerBar: number;
  /** Total length in beats. */
  beats: number;
  /** Beats per minute, of the meter's beat unit (dotted quarter in 6/8 and 12/8). */
  bpm: number;
  /** Optional slow-down: tempo ramps linearly from `bpm` at `fromBeat` to `toBpm` at the end. */
  ritardando?: { fromBeat: number; toBpm: number };
  notes: NoteEvent[];
  /** Sustain-pedal marks for the piano, in beats. */
  pedal: { t: number; down: boolean }[];
  mix: MixState;
  /**
   * Overall dynamics moving inside the phrase (crescendo, diminuendo, swell): the level, in the same
   * pp..fff steps as `mix.dynamics` (fractions allowed), at beat positions. Absent = steady at `mix.dynamics`.
   */
  dynCurve?: { beat: number; step: number }[];
  /** The chord left sounding if the buffer runs dry after this phrase. */
  holdChord: HoldNote[];
  /** Last phrase of the piece. */
  final?: boolean;
  /** Master fade for a fade ending, in beats. */
  fadeOut?: { fromBeat: number; toBeat: number };
  /** Hard stop for a sudden-stop ending, in beats (reverb tail still rings). */
  cutAtBeat?: number;
  /** Choreomusic only: where this phrase starts on the video clock, in seconds. */
  startSec?: number;
  /** For the panel. */
  display: {
    key: string;
    notation: string;
    lineage: string;
    chords: string[];
    layers: LayerSummary[];
    tension: number;
  };
}

/** How a held sustain evolves while Drex keeps redrafting. The server sends the complete new note set. */
export interface HoldUpdate {
  action: string;
  label: string;
  notes: HoldNote[];
  mix?: Partial<MixState>;
  /** Crossfade time into the new state, seconds. */
  overSec: number;
}

/** Seconds from phrase start to a beat position, honouring the ritardando. */
export function beatToSec(score: Pick<PhraseScore, 'bpm' | 'beats' | 'ritardando'>, beat: number): number {
  const spb = 60 / score.bpm;
  const r = score.ritardando;
  if (!r || beat <= r.fromBeat) return beat * spb;
  const span = Math.max(1e-6, score.beats - r.fromBeat);
  const x = Math.min(beat, score.beats) - r.fromBeat;
  // seconds-per-beat ramps linearly from spb to spbEnd across the span
  const spbEnd = 60 / r.toBpm;
  const sec = spb * x + ((spbEnd - spb) * x * x) / (2 * span);
  const over = Math.max(0, beat - score.beats) * spbEnd;
  return r.fromBeat * spb + sec + over;
}

export function phraseSeconds(score: Pick<PhraseScore, 'bpm' | 'beats' | 'ritardando'>): number {
  return beatToSec(score, score.beats);
}

// ───────────────────────────── What the panel shows ─────────────────────────────

export type QuestionType = 'choice' | 'noul' | 'score';

export interface QuestionView {
  id: string;
  type: QuestionType;
  /** Short human label for the question. */
  label: string;
  /** choice: option key → short label; score: level labels in order. */
  options?: { key: string; label: string }[];
  /** choice / score: probability per option key (score keys are "0".."n-1"). noul: { yes: p }. */
  probabilities: Record<string, number>;
  /** What the engine went with. For sampled draft calls there is one entry per draft. */
  picked: string[];
  picking: 'top' | 'sampled';
}

export type CallType =
  | 'setup' | 'plan' | 'backdrop' | 'theme_shape' | 'theme_note' | 'theme_judge' | 'theme_derive'
  | 'phrase_direction' | 'chord_path' | 'voice_leading' | 'phrase_judge' | 'orchestration'
  | 'hold' | 'ending' | 'plan_revision'
  // Choreomusic
  | 'frame_reading' | 'section_boundary' | 'tempo' | 'fit' | 'live_read';

export interface CallView {
  id: number;
  callType: CallType;
  title: string;
  /** Milliseconds since session start. */
  at: number;
  model: string;
  /** True when the local stand-in answered because no NACE_API_KEY is set. */
  standin: boolean;
  ms: number;
  questions: QuestionView[];
}

export interface RulesView {
  style: StyleId;
  styleName: string;
  /** Beat-driven pieces only. */
  groove?: GrooveId;
  bpm: number;
  meter: MeterId;
  keyName: string;
  mode: ModeId;
  harmonicLanguage: HarmonicLanguage;
  palette: InstrumentId[];
  soundWorld: SoundWorld;
  lengthSec: number;
  form: FormId;
  ending: EndingId;
  keyPlan: KeyPlanId;
}

export interface SectionView {
  index: number;
  role: PhraseRole;
  /** Beat-driven pieces: the song part this section is. */
  part?: PartId;
  /** 1..7 */
  tension: number;
  departure: boolean;
  /** Inclusive phrase index range. */
  phrases: [number, number];
  keyName: string;
  /** Choreomusic only: where the section sits on the video clock. */
  startSec?: number;
  endSec?: number;
}

export interface PlanView {
  sections: SectionView[];
  totalPhrases: number;
  climaxPhrase: number;
  /** How the climax arrives (see ArrivalId). */
  climaxArrival?: ArrivalId;
  /** Seconds per phrase at the base tempo. */
  phraseSec: number;
  revised: boolean;
}

export interface ThemeView {
  id: string;
  kind: 'main' | 'counter' | 'contrast';
  notation: string;
  contour: string;
  /** Pitches for drawing: MIDI + start/duration in beats. */
  notes: { midi: number; t: number; dur: number }[];
}

export interface DraftView {
  id: string;
  notation: string;
  lineage: string;
  chords?: string[];
  notes: { midi: number; t: number; dur: number }[];
  facts?: { label: string; value: string }[];
}

export interface VerdictView {
  /** Draft id, or null when the judge rejected all of them. */
  picked: string | null;
  reason: string;
  probabilities: Record<string, number>;
}

export type Stage =
  | 'idle' | 'loading' | 'prescan' | 'setup' | 'plan' | 'themes' | 'composing' | 'buffering'
  | 'playing' | 'holding' | 'ending' | 'done' | 'error';

export type ServerEvent =
  | { type: 'session'; id: string; prompt: string; standin: boolean; model: string; seed: number }
  | { type: 'status'; stage: Stage; message: string }
  | { type: 'call'; call: CallView }
  | { type: 'rules'; rules: RulesView }
  | { type: 'plan'; plan: PlanView }
  | { type: 'backdrop'; id: string; file: string; mood: string }
  | { type: 'theme_drafts'; themeId: string; round: number; drafts: DraftView[]; verdict: VerdictView }
  | { type: 'theme'; theme: ThemeView }
  | { type: 'phrase_drafts'; phrase: number; round: number; drafts: DraftView[]; verdict: VerdictView }
  | { type: 'phrase'; score: PhraseScore }
  | { type: 'hold_update'; update: HoldUpdate }
  | { type: 'stats'; calls: number; callsLastMinute: number; rejects: number; holds: number; composed: number }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type ClientEvent =
  | { type: 'start'; prompt: string; seed?: number }
  | { type: 'phrase_started'; index: number }
  | { type: 'hold_started'; afterIndex: number }
  | { type: 'hold_ended' }
  | { type: 'stop' };
