// Pure sample-selection and performance-shaping logic (no Web Audio, no Tone): articulation
// fallbacks, nearest key + rate, velocity-layer crossfade, round robin, envelopes, voice stealing.

import type { Articulation, InstrumentId } from '../../../shared/types.ts';
import type { ArticulationDef, InstrumentDef } from './manifest.ts';

// ───────────────────────────── Articulation fallbacks ─────────────────────────────

/** How a resolved articulation is to be performed. */
export type ArtMode =
  /** Play the articulation's own samples as recorded. */
  | 'direct'
  /** A sustain sample cut short to stand in for a missing short articulation. */
  | 'gated'
  /** A sustain sample with a 12 Hz amplitude LFO standing in for a missing tremolo / roll. */
  | 'tremoloLfo';

export interface ResolvedArticulation {
  name: string;
  def: ArticulationDef;
  mode: ArtMode;
}

type Step = [name: Articulation, mode: ArtMode];

const FALLBACKS: Record<Articulation, Step[]> = {
  sustain: [['sustain', 'direct']],
  staccato: [['staccato', 'direct'], ['spiccato', 'direct'], ['sustain', 'gated'], ['pizzicato', 'direct']],
  spiccato: [['spiccato', 'direct'], ['staccato', 'direct'], ['sustain', 'gated'], ['pizzicato', 'direct']],
  pizzicato: [['pizzicato', 'direct'], ['staccato', 'direct'], ['spiccato', 'direct'], ['sustain', 'gated']],
  tremolo: [['tremolo', 'direct'], ['sustain', 'tremoloLfo'], ['roll', 'direct']],
  hit: [['hit', 'direct'], ['staccato', 'direct'], ['spiccato', 'direct'], ['pizzicato', 'direct'], ['sustain', 'direct']],
  roll: [['roll', 'direct'], ['tremolo', 'direct'], ['sustain', 'tremoloLfo'], ['hit', 'direct']],
};

const LAST_RESORT: Articulation[] = ['sustain', 'hit', 'staccato', 'spiccato', 'pizzicato', 'tremolo', 'roll'];

/**
 * Find something playable for `art` on this instrument. `usable` lets the caller exclude
 * articulations whose samples failed to load. Returns null only if nothing at all is usable.
 */
export function resolveArticulation(
  inst: Pick<InstrumentDef, 'articulations'>,
  art: Articulation,
  usable: (name: string, def: ArticulationDef) => boolean = () => true,
): ResolvedArticulation | null {
  const chain = FALLBACKS[art] ?? FALLBACKS.sustain;
  for (const [name, mode] of chain) {
    const def = inst.articulations[name];
    if (def && usable(name, def)) return { name, def, mode };
  }
  for (const name of LAST_RESORT) {
    const def = inst.articulations[name];
    if (def && usable(name, def)) return { name, def, mode: 'direct' };
  }
  for (const [name, def] of Object.entries(inst.articulations)) {
    if (def && usable(name, def)) return { name, def, mode: 'direct' };
  }
  return null;
}

// ───────────────────────────── Key + playback rate ─────────────────────────────

export interface KeyPick {
  /** Sampled key used. */
  key: number;
  /** Playback rate that brings it to the requested pitch. */
  rate: number;
  /** Semitones shifted (midi - key). */
  semis: number;
}

export interface PickKeyOptions {
  /** Pseudo-note instruments (drum kit, cymbals): nearest key, never pitch-shifted. */
  unpitched?: boolean;
  /**
   * Prefer the *other* nearest key (used by violins2 when there is a single take, so two
   * sections in unison never play the identical buffer). Only if within `maxAlternateSemis`.
   */
  preferAlternate?: boolean;
  maxAlternateSemis?: number;
}

/**
 * Nearest sampled key. When two keys are equally near, `counter` alternates between them
 * (pitch-shifted neighbours as pseudo round robin). `keys` must be sorted ascending.
 */
export function pickKey(keys: readonly number[], midi: number, counter = 0, opts: PickKeyOptions = {}): KeyPick | null {
  if (keys.length === 0) return null;
  // binary search for the first key >= midi
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < midi) lo = mid + 1;
    else hi = mid;
  }
  // the two nearest keys are among the neighbours of the insertion point
  const cand: number[] = [];
  for (let i = Math.max(0, lo - 2); i <= Math.min(keys.length - 1, lo + 1); i++) cand.push(keys[i]);
  const odd = (counter & 1) === 1;
  cand.sort((a, b) => {
    const d = Math.abs(a - midi) - Math.abs(b - midi);
    if (d !== 0) return d;
    return odd ? b - a : a - b; // equally near: lower neighbour on even counts, upper on odd
  });
  let key = cand[0];
  const other = cand.length > 1 ? cand[1] : null;
  if (opts.preferAlternate && other !== null && Math.abs(other - midi) <= (opts.maxAlternateSemis ?? 4)) key = other;
  const semis = midi - key;
  return { key, semis, rate: opts.unpitched ? 1 : Math.pow(2, semis / 12) };
}

/** Never shift a sample further than this from its recorded pitch. */
export const MAX_SHIFT_SEMIS = 7;

/**
 * pickKey with a sanity limit: a note more than 7 semitones outside the sampled range is moved
 * by octaves towards the range until the shift is within the limit (so it stays in key rather
 * than being played at a clamped, wrong pitch). `octaves` reports the transposition (0 normally).
 */
export function pickKeyInRange(keys: readonly number[], midi: number, counter = 0, opts: PickKeyOptions = {}): (KeyPick & { octaves: number }) | null {
  let pk = pickKey(keys, midi, counter, opts);
  if (!pk || opts.unpitched) return pk ? { ...pk, octaves: 0 } : null;
  let m = midi;
  let octaves = 0;
  for (let guard = 0; guard < 8 && Math.abs(pk.semis) > MAX_SHIFT_SEMIS; guard++) {
    const dir = pk.semis > 0 ? -1 : 1;
    m += 12 * dir;
    octaves += dir;
    const next = pickKey(keys, m, counter, opts);
    if (!next) break;
    pk = next;
  }
  return { ...pk, octaves };
}

// ───────────────────────────── Recorded levels ─────────────────────────────

/** Most make-up a quiet layer or key may receive, and the most a hot one is pulled down (dB). */
export const LAYER_MAKEUP_MAX_DB = 26;
export const LAYER_MAKEUP_MIN_DB = -6;
export const KEY_COMP_MAX_DB = 12;
/** How much of a key's deviation from its layer's median level is evened out. */
export const KEY_COMP_AMOUNT = 0.6;

/**
 * Make-up gain per dynamic layer (dB) from the layers' median recorded levels (ascending by
 * velocity). The library keeps raw recorded dynamics: a soft layer can sit 30 dB under the
 * loud one, and by how much differs per instrument. Make-up brings every layer to the loudest
 * layer's level, so a layer contributes its timbre and one velocity curve sets the loudness —
 * the same for every instrument, with no double attenuation of soft notes.
 */
export function layerMakeupDb(medianLevelsDb: readonly number[]): number[] {
  if (medianLevelsDb.length === 0) return [];
  const ref = medianLevelsDb[medianLevelsDb.length - 1];
  return medianLevelsDb.map((l) => (Number.isFinite(l) && Number.isFinite(ref) ? Math.min(LAYER_MAKEUP_MAX_DB, Math.max(LAYER_MAKEUP_MIN_DB, ref - l)) : 0));
}

/**
 * Per-sample trim (dB) towards the layer's median level. Nothing was normalised per sample,
 * so neighbouring keys differ arbitrarily and some instruments tilt hard (flute and horn top
 * notes ~20 dB hotter than their bottom notes). Partial on purpose: registers keep some of
 * their natural difference.
 */
export function keyCompDb(levelDb: number, layerMedianDb: number): number {
  if (!Number.isFinite(levelDb) || !Number.isFinite(layerMedianDb)) return 0;
  return Math.min(KEY_COMP_MAX_DB, Math.max(-KEY_COMP_MAX_DB, (layerMedianDb - levelDb) * KEY_COMP_AMOUNT));
}

export function median(xs: readonly number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

// ───────────────────────────── Cymbal swells ─────────────────────────────

/** Seconds from the start of each swell recording to its peak (short, medium, long), if the side-car is absent. */
export const DEFAULT_SWELL_PEAKS = [1.6, 3.8, 7.2];

/**
 * A cymbal `roll` note is a swell that peaks at the END of the note. Choose the recording whose
 * time-to-peak is closest to the note's length; it is started `leadSec` before the note end.
 */
export function pickSwell(durSec: number, peaks: readonly number[] = DEFAULT_SWELL_PEAKS): { variant: number; leadSec: number } | null {
  if (!peaks.length) return null;
  let best = 0;
  for (let i = 1; i < peaks.length; i++) if (Math.abs(peaks[i] - durSec) < Math.abs(peaks[best] - durSec)) best = i;
  return { variant: best, leadSec: peaks[best] };
}

// ───────────────────────────── Velocity layers ─────────────────────────────

export interface LayerGain {
  layer: number;
  gain: number;
}

/** Equal-power pair for a crossfade position x in 0..1: [gain of the outgoing, gain of the incoming]. */
export function equalPower(x: number): [number, number] {
  const c = Math.min(1, Math.max(0, x));
  return [Math.cos((c * Math.PI) / 2), Math.sin((c * Math.PI) / 2)];
}

/** One-shot rule: the first layer whose velMax covers the velocity (else the loudest). */
export function pickLayer(velMaxes: readonly number[], vel: number): number {
  for (let i = 0; i < velMaxes.length; i++) if (vel <= velMaxes[i]) return i;
  return Math.max(0, velMaxes.length - 1);
}

/**
 * Which layers sound and how loudly. With `crossfade`, a velocity between two layer centres
 * plays both with equal-power gains (the dynamic crossfade); otherwise one layer is picked.
 * A layer's centre is the middle of its velocity band.
 */
export function layerGains(velMaxes: readonly number[], vel: number, crossfade: boolean): LayerGain[] {
  const n = velMaxes.length;
  if (n === 0) return [];
  if (n === 1 || !crossfade) return [{ layer: pickLayer(velMaxes, vel), gain: 1 }];
  const centres: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = i === 0 ? 0 : velMaxes[i - 1];
    const hi = i === n - 1 ? Math.max(1, velMaxes[i]) : velMaxes[i];
    centres.push((lo + hi) / 2);
  }
  if (vel <= centres[0]) return [{ layer: 0, gain: 1 }];
  if (vel >= centres[n - 1]) return [{ layer: n - 1, gain: 1 }];
  let i = 0;
  while (i < n - 2 && vel > centres[i + 1]) i++;
  const span = Math.max(1e-6, centres[i + 1] - centres[i]);
  const [a, b] = equalPower((vel - centres[i]) / span);
  const out: LayerGain[] = [];
  // a layer under about -30 dB is not worth a voice
  if (a > 0.03) out.push({ layer: i, gain: a });
  if (b > 0.03) out.push({ layer: i + 1, gain: b });
  return out;
}

/** Velocity → linear gain, roughly vel^1.6 with a small floor so pp never vanishes. */
export function velocityGain(vel: number): number {
  const v = Math.min(1, Math.max(0, vel));
  return 0.06 + 0.94 * Math.pow(v, 1.6);
}

/** Per-voice low-pass for sustains: soft is darker. At full velocity the filter is out of the way. */
export function velocityCutoffHz(vel: number): number {
  const v = Math.min(1, Math.max(0, vel));
  return Math.min(20000, 2600 * Math.pow(2, 3 * v));
}

// ───────────────────────────── Round robin ─────────────────────────────

/** Rotating take selection; with alternates available the same take never plays twice running. */
export class RoundRobin {
  private last = new Map<string, number>();

  /**
   * Next take index for `key` out of `count`. Aliases sharing a key (violins / violins2) advance
   * the same rotation, so simultaneous unisons land on different takes.
   */
  next(key: string, count: number): number {
    if (count <= 1) {
      this.last.set(key, 0);
      return 0;
    }
    const prev = this.last.get(key);
    const idx = prev === undefined ? 0 : (prev + 1) % count;
    this.last.set(key, idx);
    return idx;
  }

  /** Monotonic counter per key (for alternating equidistant neighbour keys). */
  private counters = new Map<string, number>();
  count(key: string): number {
    const c = this.counters.get(key) ?? 0;
    this.counters.set(key, c + 1);
    return c;
  }

  reset(): void {
    this.last.clear();
    this.counters.clear();
  }
}

// ───────────────────────────── Envelopes ─────────────────────────────

/** How a voice behaves over time. */
export type VoiceMode =
  /** Bowed / blown: shaped attack, legato release, re-grained if longer than the sample. */
  | 'sustain'
  /** Struck / plucked with a damper or hand: full level at once, released at note-off (piano, harp, mallets). */
  | 'decay'
  /** Rings for the whole sample; duration ignored. */
  | 'oneshot'
  /** Sustain sample gated short. */
  | 'gated';

const DECAY_INSTRUMENTS = new Set<string>(['piano', 'harp', 'celesta', 'glockenspiel', 'vibraphone']);

export function voiceMode(sourceInst: string, resolved: Pick<ResolvedArticulation, 'mode' | 'name'>, oneShot: boolean): VoiceMode {
  if (resolved.mode === 'gated') return 'gated';
  if (resolved.mode === 'tremoloLfo') return 'sustain';
  if (sourceInst === 'piano') return 'decay';
  if (oneShot) return 'oneshot';
  if (DECAY_INSTRUMENTS.has(sourceInst)) return 'decay';
  return 'sustain';
}

/** Bowed strings: the samples already speak slowly (≈180 ms to come within 20 dB of their peak). */
const BOWED = new Set<string>(['violins', 'violins2', 'violas', 'celli', 'basses', 'solo_violin']);

export function isBowed(inst: string): boolean {
  return BOWED.has(inst);
}

export interface SustainEnvelope {
  /** Seconds to reach ~95 % of the level. */
  attack: number;
  /** Seconds to fall to ~5 %; it overlaps the following note. */
  release: number;
}

/**
 * Fade-in laid over the sample's own attack, and the legato release.
 * Strings get only 20–40 ms (their recorded attack is slow enough already); winds and brass
 * 40–90 ms. Softer is slower. Release 250–600 ms, longer when soft and low, so consecutive
 * notes overlap.
 */
export function sustainEnvelope(inst: InstrumentId, vel: number, midi: number, legato = false): SustainEnvelope {
  const v = Math.min(1, Math.max(0, vel));
  const low = Math.min(1, Math.max(0, (60 - midi) / 30)); // 0 at middle C and above, 1 two and a half octaves down
  let attackMs = BOWED.has(inst) ? 20 + 20 * (1 - v) : 40 + 50 * (1 - v);
  if (legato) attackMs = 50; // joining mid-bow (the sample's attack is skipped), so only a short fade
  const releaseMs = Math.min(600, Math.max(250, 280 + 200 * (1 - v) + 130 * low));
  return { attack: attackMs / 1000, release: releaseMs / 1000 };
}

/** Slurred notes start this far into the sample, past the bow change / tonguing. */
export function legatoOffsetSec(inst: string): number {
  return BOWED.has(inst) ? 0.12 : 0.045;
}

export interface DecayRelease {
  /** False = no damper at all: the note is never released, it rings out. */
  damped: boolean;
  /** Seconds to fall to ~5 % after the damper lands. */
  release: number;
}

/** Piano dampers: low strings ring on longer after release; above ~C7 there are no dampers. */
export function pianoRelease(midi: number): DecayRelease {
  if (midi > 96) return { damped: false, release: 0 };
  if (midi < 48) {
    const depth = Math.min(1, (48 - midi) / 27); // A0 is the deepest
    return { damped: true, release: 0.45 + 0.55 * depth };
  }
  return { damped: true, release: 0.2 + 0.1 * Math.max(0, (72 - midi) / 24) };
}

/** Release for the other struck / plucked instruments when the manifest marks them as not one-shot. */
export function decayRelease(sourceInst: string, midi: number): DecayRelease {
  if (sourceInst === 'piano') return pianoRelease(midi);
  if (sourceInst === 'harp') return { damped: true, release: 1.4 };
  return { damped: true, release: 1.8 };
}

// ───────────────────────────── Seating ─────────────────────────────

const PAN: Partial<Record<InstrumentId, number>> = {
  violins: -0.36, violins2: -0.18, violas: 0.16, celli: 0.32, basses: 0.46, solo_violin: -0.12,
  flute: -0.05, oboe: 0.05, clarinet: 0.08, horn: -0.2, harp: -0.38,
  piano: 0, timpani: 0, bass_drum: 0.06, cymbal: 0.12, drumkit: 0, tam_tam: 0.2,
  celesta: -0.24, glockenspiel: 0.22, vibraphone: 0.16,
};

/** Subtle orchestral seating, -1 (left) … +1 (right). */
export function panFor(inst: InstrumentId): number {
  return PAN[inst] ?? 0;
}

// ───────────────────────────── Grains (long notes and holds) ─────────────────────────────

export interface GrainTiming {
  /** Seconds after the grain starts at which the crossfade into the next grain begins. */
  hop: number;
  /** Crossfade length, seconds. */
  xfade: number;
}

/**
 * When to hand over to a restarted grain. `audible` is the grain's remaining length in real
 * seconds (after start offset and playback rate); `r` in 0..1 varies the hop between 5 and 6 s.
 * Short samples hand over proportionally earlier with a shorter crossfade.
 */
export function grainTiming(audible: number, r: number): GrainTiming {
  const xfade = Math.min(1.5, audible * 0.3);
  const guard = Math.min(0.6, audible * 0.1); // keep clear of the recorded release at the very end
  const hop = Math.max(audible * 0.35, Math.min(5 + r, audible - xfade - guard));
  return { hop, xfade };
}

/** Where a restarted grain begins inside the sample: past the attack, varied each time. */
export function grainOffset(bufferSec: number, r: number): number {
  const lo = Math.min(0.3, bufferSec * 0.1);
  const span = Math.min(1.2, bufferSec * 0.25);
  return lo + span * r;
}

// ───────────────────────────── Voice stealing ─────────────────────────────

export interface StealCandidate {
  /** Audio time the voice started. */
  start: number;
  /** Rough current level, 0..1. */
  level: number;
  /** Held (hold-chord) voices are the last to go. */
  held?: boolean;
}

/** Oldest-quietest: age and quietness both raise the score; returns the index to steal, or -1. */
export function stealIndex(voices: readonly StealCandidate[], now: number): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    const age = Math.max(0, now - v.start);
    if (now < v.start) continue; // not sounding yet: never steal a note that has not begun
    let score = age / (age + 4) + (1 - Math.min(1, Math.max(0, v.level))) * 1.5;
    if (v.held) score -= 2;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 && voices.length) {
    // everything is in the future: take the latest-starting one
    let latest = -Infinity;
    for (let i = 0; i < voices.length; i++) if (voices[i].start > latest) { latest = voices[i].start; best = i; }
  }
  return best;
}

// ───────────────────────────── Small maths ─────────────────────────────

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function centsToRate(cents: number): number {
  return Math.pow(2, cents / 1200);
}
