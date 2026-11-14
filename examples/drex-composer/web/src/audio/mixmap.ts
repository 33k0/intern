// MixState (0..6 steps) + sound world → concrete effect parameters (pure).

import type { MixState, SoundWorld } from '../../../shared/types.ts';
import { dbToGain } from './selection.ts';

export interface MixParams {
  lowpassHz: number;
  /** Reverb send, linear. */
  reverbWet: number;
  /** Dry level, eased down a little as the reverb comes up. */
  dry: number;
  delayWet: number;
  /** Noise bed, linear gain (0 = off). */
  noiseGain: number;
  /** StereoWidener width, 0.5 = unchanged. */
  width: number;
  /** Gain into / out of the tanh shaper. */
  satPre: number;
  satPost: number;
  chorusWet: number;
  /** Master gain from the overall dynamic. */
  master: number;
  sidechain: boolean;
}

export interface WorldProfile {
  reverbScale: number;
  preDelaySec: number;
  /** Low-pass cutoff at lowpass step 0 and step 6. */
  lowpassFloorHz: number;
  lowpassCeilHz: number;
  /** Noise bed never drops below this (dB); -Infinity = no floor. */
  noiseFloorDb: number;
  noiseBoostDb: number;
}

export const WORLDS: Record<SoundWorld, WorldProfile> = {
  close_dry: { reverbScale: 0.4, preDelaySec: 0.004, lowpassFloorHz: 350, lowpassCeilHz: 18000, noiseFloorDb: -Infinity, noiseBoostDb: 0 },
  large_hall: { reverbScale: 1.0, preDelaySec: 0.024, lowpassFloorHz: 350, lowpassCeilHz: 18000, noiseFloorDb: -Infinity, noiseBoostDb: 0 },
  // ceiling pulled down ~1.5 octaves, a little water always present
  submerged: { reverbScale: 1.1, preDelaySec: 0.034, lowpassFloorHz: 350, lowpassCeilHz: 18000 / Math.pow(2, 1.5), noiseFloorDb: -34, noiseBoostDb: 3 },
  electronic_hybrid: { reverbScale: 0.7, preDelaySec: 0.012, lowpassFloorHz: 450, lowpassCeilHz: 20000, noiseFloorDb: -Infinity, noiseBoostDb: 0 },
};

export const DEFAULT_MIX: MixState = {
  dynamics: 3, lowpass: 6, reverb: 3, delay: 0, noise: 0, width: 3, saturation: 0, chorus: false, sidechain: false,
};

/** Width per step. Deliberately stops short of 1.0: on Tone's StereoWidener 1.0 removes the centre entirely. */
const WIDTH_STEPS = [0.1, 0.25, 0.38, 0.5, 0.58, 0.65, 0.72];

const NOISE_MAX_DB = -14;
const NOISE_MIN_DB = -38;

function step(x: number): number {
  return Math.min(6, Math.max(0, Number.isFinite(x) ? x : 0));
}

export function mixToParams(mix: MixState, world: SoundWorld = 'large_hall'): MixParams {
  const w = WORLDS[world] ?? WORLDS.large_hall;
  const lp = step(mix.lowpass) / 6;
  const lowpassHz = Math.min(20000, w.lowpassFloorHz * Math.pow(w.lowpassCeilHz / w.lowpassFloorHz, lp));

  const reverbWet = Math.min(0.7, (0.05 + 0.55 * (step(mix.reverb) / 6)) * w.reverbScale);
  const dry = 1 - 0.45 * reverbWet;
  const delayWet = 0.35 * (step(mix.delay) / 6);

  const ns = step(mix.noise);
  let noiseGain = ns <= 0 ? 0 : dbToGain(NOISE_MIN_DB + ((ns - 1) / 5) * (NOISE_MAX_DB - NOISE_MIN_DB) + w.noiseBoostDb);
  if (Number.isFinite(w.noiseFloorDb)) noiseGain = Math.max(noiseGain, dbToGain(w.noiseFloorDb));

  const wi = step(mix.width);
  const i0 = Math.floor(wi);
  const i1 = Math.min(6, i0 + 1);
  const width = WIDTH_STEPS[i0] + (WIDTH_STEPS[i1] - WIDTH_STEPS[i0]) * (wi - i0);

  // tanh shaper driven 0.5× … 4×; output trimmed so loudness stays roughly level (unity at step 0)
  const satPre = 0.5 * Math.pow(8, step(mix.saturation) / 6);
  const satPost = Math.pow(satPre, -0.75) / (0.5 * Math.pow(0.5, -0.75));

  // pp sits 18 dB under fff: 3 dB a step, so f to fff is a 6 dB jump (proposed; tune by ear).
  const master = dbToGain(-18 + 18 * (step(mix.dynamics) / 6));

  return { lowpassHz, reverbWet, dry, delayWet, noiseGain, width, satPre, satPost, chorusWet: mix.chorus ? 0.38 : 0, master, sidechain: !!mix.sidechain };
}

/** The dynamics level (a fractional pp..fff step) at one beat of a phrase's dynamic curve. */
export function curveLevel(curve: { beat: number; step: number }[], beat: number): number {
  if (!curve.length) return DEFAULT_MIX.dynamics;
  if (beat <= curve[0].beat) return step(curve[0].step);
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (beat <= b.beat) return step(a.step + ((b.step - a.step) * (beat - a.beat)) / Math.max(1e-6, b.beat - a.beat));
  }
  return step(curve[curve.length - 1].step);
}

export function mergeMix(base: MixState, patch?: Partial<MixState>): MixState {
  if (!patch) return { ...base };
  const out: MixState = { ...base };
  for (const [k, v] of Object.entries(patch) as [keyof MixState, MixState[keyof MixState]][]) {
    if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Feedback-delay time: a dotted eighth of the beat (three quarters of a beat), folded into 0.12–0.9 s. */
export function delayTimeSec(bpm: number): number {
  let d = 0.75 * (60 / Math.max(20, bpm));
  while (d > 0.9) d /= 2;
  while (d < 0.12) d *= 2;
  return d;
}

/** Sidechain duck: depth and recovery. */
export const DUCK_GAIN = dbToGain(-9);
export const DUCK_RECOVERY_SEC = 0.18;
