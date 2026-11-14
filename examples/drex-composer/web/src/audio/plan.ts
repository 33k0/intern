// Turns a PhraseScore into a time-ordered performance plan (pure; no Web Audio, no Tone):
// beat → seconds with ritardando, humanisation, piano pedal deferral, legato detection,
// sidechain kick times, fade and cut points.

import { beatToSec, phraseSeconds } from '../../../shared/types.ts';
import type { InstrumentId, LayerRole, NoteEvent, PhraseScore } from '../../../shared/types.ts';
import { isSynthId } from './manifest.ts';
import { bipolar, hashSeed, mulberry32 } from './prng.ts';
import { DEFAULT_SWELL_PEAKS, pickSwell } from './selection.ts';

export interface PlannedNote {
  /** Index into score.notes. */
  i: number;
  note: NoteEvent;
  /** Seconds from phrase start, humanised (may be a few ms negative). */
  onSec: number;
  /** Seconds from phrase start at which the note is released; null = the pedal carries it past the phrase end. */
  offSec: number | null;
  /** Written length in seconds (before any pedal deferral). */
  durSec: number;
  /** Humanised velocity, 0..1. */
  vel: number;
  detuneCents: number;
  /** Slurred into from the previous note of the same line (shorter attack, bow change skipped). */
  legato: boolean;
  /** Piano only: the sustain pedal is down when the note is struck. */
  pedalAtOnset: boolean;
  /** Triggers the sidechain duck. */
  kick: boolean;
  /**
   * Cymbal roll: a swell recording that must PEAK at the written note end. `onSec` is already
   * moved to where the recording has to start (often before the written note, even before the
   * phrase); `peakSec` is the note end, seconds from phrase start.
   */
  swell?: { variant: number; leadSec: number; peakSec: number };
}

export interface PhrasePlan {
  score: PhraseScore;
  /** Phrase length in seconds. */
  seconds: number;
  /** Sorted by onSec. */
  notes: PlannedNote[];
  /** Kick times in seconds from phrase start, sorted. */
  kickSecs: number[];
  /** Actual pedal state changes (redundant marks removed), for the pedal noises. */
  pedal: { sec: number; down: boolean }[];
  pedalEndsDown: boolean;
  /** First pedal lift in the phrase, seconds; null if none. */
  firstPedalUpSec: number | null;
  cutSec: number | null;
  fade: { fromSec: number; toSec: number } | null;
  /** Bus each instrument last used in this phrase (hold notes carry no layer of their own). */
  layerOfInst: Map<InstrumentId, LayerRole>;
}

export interface PlanOptions {
  /** Pedal state inherited from the previous phrase. */
  pedalInitiallyDown?: boolean;
  /** Changes the humanisation; the same seed always gives the same performance. */
  seed?: number;
  /** Set false for exact timing (tests). */
  humanize?: boolean;
  /** Time-to-peak of the available cymbal swell recordings, seconds, ascending. */
  swellPeaks?: readonly number[];
}

// ───────────────────────────── Humanise ─────────────────────────────

/** Timing jitter half-width in milliseconds: ±4–10 ms, less on drums and pulse, none on kick808 / sub. */
export function jitterMs(note: Pick<NoteEvent, 'inst' | 'layer' | 'midi'>): number {
  switch (note.inst) {
    case 'sub':
    case 'kick808':
    case 'noise':
      return 0;
    case 'drumkit':
      return note.midi === 36 ? 2 : 3;
    default:
      break;
  }
  if (note.layer === 'pulse') return 4;
  switch (note.inst) {
    case 'violins':
    case 'violins2':
    case 'violas':
    case 'celli':
    case 'basses':
      return 10;
    case 'horn':
      return 9;
    case 'solo_violin':
    case 'flute':
    case 'oboe':
    case 'clarinet':
      return 8;
    case 'piano':
    case 'harp':
      return 7;
    case 'pad':
      return 6;
    case 'timpani':
    case 'bass_drum':
    case 'cymbal':
    case 'tam_tam':
    case 'pluck':
      return 5;
    default:
      return 6;
  }
}

export interface Humanised {
  dtSec: number;
  vel: number;
  detuneCents: number;
}

/** Deterministic per (seed, phrase, note index): independent of scheduling order. */
export function humanize(note: NoteEvent, phraseIndex: number, noteIndex: number, seed = 0): Humanised {
  const rng = mulberry32(hashSeed(seed, phraseIndex, noteIndex));
  const dtSec = bipolar(rng, jitterMs(note)) / 1000;
  const vel = Math.min(1, Math.max(0.02, note.vel * (1 + bipolar(rng, 0.06))));
  const detuneCents = isSynthId(note.inst) ? 0 : bipolar(rng, 3);
  return { dtSec, vel, detuneCents };
}

// ───────────────────────────── Pedal ─────────────────────────────

const EPS = 1e-9;

/**
 * Sustain-pedal deferral, in beats. A note whose written end falls while the pedal is down is
 * released at the next pedal lift; if the pedal is still down at the end of the marks the
 * result is null (carried into whatever comes next). Marks at the same beat apply in order.
 */
export function pedalOffBeats(
  notes: readonly { t: number; dur: number }[],
  marks: readonly { t: number; down: boolean }[],
  initiallyDown = false,
): { off: (number | null)[]; endsDown: boolean } {
  const sorted = marks.map((m, i) => ({ ...m, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const off = notes.map((n) => {
    const end = n.t + Math.max(0, n.dur);
    let down = initiallyDown;
    let k = 0;
    for (; k < sorted.length && sorted[k].t <= end + EPS; k++) down = sorted[k].down;
    if (!down) return end;
    for (; k < sorted.length; k++) if (!sorted[k].down) return sorted[k].t;
    return null;
  });
  const endsDown = sorted.length ? sorted[sorted.length - 1].down : initiallyDown;
  return { off, endsDown };
}

// ───────────────────────────── Plan ─────────────────────────────

function isKick(n: NoteEvent): boolean {
  return n.inst === 'kick808' || (n.inst === 'drumkit' && n.midi === 36);
}

const LEGATO_WINDOW_BEATS = 0.12;

/** Marks sustain notes that begin where another note of the same line ends (different pitch). */
function findLegato(notes: readonly NoteEvent[]): boolean[] {
  const out = new Array<boolean>(notes.length).fill(false);
  const groups = new Map<string, number[]>();
  notes.forEach((n, i) => {
    if (n.art !== 'sustain' || isSynthId(n.inst) || n.inst === 'piano' || n.inst === 'harp') return;
    const key = n.inst + '|' + n.layer;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  for (const g of groups.values()) {
    for (const i of g) {
      const a = notes[i];
      for (const j of g) {
        if (j === i) continue;
        const b = notes[j];
        if (b.midi === a.midi || b.t >= a.t - 0.05) continue;
        if (Math.abs(b.t + b.dur - a.t) <= LEGATO_WINDOW_BEATS) {
          out[i] = true;
          break;
        }
      }
    }
  }
  return out;
}

export function planPhrase(score: PhraseScore, opts: PlanOptions = {}): PhrasePlan {
  const seed = opts.seed ?? 0;
  const doHumanize = opts.humanize !== false;
  const seconds = phraseSeconds(score);
  const cutBeat = typeof score.cutAtBeat === 'number' ? score.cutAtBeat : null;
  const marks = [...(score.pedal ?? [])].map((m, i) => ({ ...m, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const legato = findLegato(score.notes);

  const pianoIdx: number[] = [];
  score.notes.forEach((n, i) => {
    if (n.inst === 'piano') pianoIdx.push(i);
  });
  const pedalRes = pedalOffBeats(pianoIdx.map((i) => score.notes[i]), marks, !!opts.pedalInitiallyDown);
  const pianoOff = new Map<number, number | null>();
  pianoIdx.forEach((i, k) => pianoOff.set(i, pedalRes.off[k]));

  const pedalDownAt = (beat: number): boolean => {
    let down = !!opts.pedalInitiallyDown;
    for (const m of marks) {
      if (m.t <= beat + EPS) down = m.down;
      else break;
    }
    return down;
  };

  const notes: PlannedNote[] = [];
  const kickSecs: number[] = [];
  const layerOfInst = new Map<InstrumentId, LayerRole>();
  score.notes.forEach((n, i) => {
    if (cutBeat !== null && n.t >= cutBeat - EPS) return;
    if (!(n.vel > 0) || !Number.isFinite(n.t) || !Number.isFinite(n.midi)) return;
    const h: Humanised = doHumanize ? humanize(n, score.index, i, seed) : { dtSec: 0, vel: n.vel, detuneCents: 0 };
    const baseOn = beatToSec(score, n.t);
    const onSec = Math.max(-0.01, baseOn + h.dtSec);
    const dur = Math.max(0, n.dur || 0);
    const durSec = Math.max(0.02, beatToSec(score, n.t + dur) - baseOn);
    let offSec: number | null = baseOn + durSec;
    if (n.inst === 'piano') {
      const ob = pianoOff.get(i);
      offSec = ob === null || ob === undefined ? null : Math.max(baseOn + 0.02, beatToSec(score, ob));
    }
    const kick = isKick(n);
    if (kick) kickSecs.push(onSec);
    layerOfInst.set(n.inst, n.layer);
    if (n.inst === 'cymbal' && n.art === 'roll') {
      const sw = pickSwell(durSec, opts.swellPeaks ?? DEFAULT_SWELL_PEAKS);
      if (sw) {
        const peakSec = baseOn + durSec;
        notes.push({
          i, note: n, onSec: peakSec - sw.leadSec, offSec: null, durSec, vel: h.vel, detuneCents: 0,
          legato: false, pedalAtOnset: false, kick: false, swell: { ...sw, peakSec },
        });
        return;
      }
    }
    notes.push({
      i,
      note: n,
      onSec,
      offSec,
      durSec,
      vel: h.vel,
      detuneCents: h.detuneCents,
      legato: legato[i],
      pedalAtOnset: n.inst === 'piano' && pedalDownAt(n.t),
      kick,
    });
  });
  notes.sort((a, b) => a.onSec - b.onSec || a.i - b.i);
  kickSecs.sort((a, b) => a - b);

  const pedal: { sec: number; down: boolean }[] = [];
  let state = !!opts.pedalInitiallyDown;
  let firstPedalUpSec: number | null = null;
  for (const m of marks) {
    if (cutBeat !== null && m.t >= cutBeat) break;
    if (!m.down && firstPedalUpSec === null) firstPedalUpSec = beatToSec(score, m.t);
    if (m.down !== state) {
      state = m.down;
      pedal.push({ sec: beatToSec(score, m.t), down: m.down });
    }
  }

  const fade = score.fadeOut
    ? { fromSec: beatToSec(score, score.fadeOut.fromBeat), toSec: Math.max(beatToSec(score, score.fadeOut.toBeat), beatToSec(score, score.fadeOut.fromBeat) + 0.05) }
    : null;

  return {
    score,
    seconds,
    notes,
    kickSecs,
    pedal,
    pedalEndsDown: pedalRes.endsDown,
    firstPedalUpSec,
    cutSec: cutBeat !== null ? beatToSec(score, cutBeat) : null,
    fade,
    layerOfInst,
  };
}
