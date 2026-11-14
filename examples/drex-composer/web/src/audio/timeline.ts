// Scheduling arithmetic (pure): phrase chaining, the beat grid that keeps running through a
// hold, and the inverse of beatToSec for the playhead.

import { beatToSec, phraseSeconds } from '../../../shared/types.ts';
import type { PhraseScore } from '../../../shared/types.ts';

/** Scheduler timer period. */
export const TICK_MS = 25;
/** Everything that starts within this window of the audio clock gets scheduled. */
export const LOOKAHEAD_SEC = 0.2;
/** Earliest a phrase may start after the decision to start it. */
export const START_LEAD_SEC = 0.12;
/** Tails ring this long after the final phrase before `ended`. */
export const TAIL_SEC = 6;
/** Video-locked mode: clock disagreement that forces a resync. */
export const SYNC_DRIFT_SEC = 0.06;

type Tempo = Pick<PhraseScore, 'bpm' | 'beats' | 'ritardando'>;

/** Start times of phrases played back to back: start(n+1) = start(n) + phraseSeconds(n). */
export function chainStarts(firstStart: number, scores: readonly Tempo[]): number[] {
  const out: number[] = [];
  let t = firstStart;
  for (const s of scores) {
    out.push(t);
    t += phraseSeconds(s);
  }
  return out;
}

/**
 * Where a phrase that arrives during a hold may begin: the next whole beat of the previous
 * tempo, on a grid that started at the end of the last phrase (`origin`) and kept running.
 * `earliest` is the soonest the scheduler can still make (now + lead).
 */
export function holdResumeTime(origin: number, secPerBeat: number, earliest: number): { time: number; beats: number } {
  const spb = Math.max(1e-3, secPerBeat);
  const beats = Math.max(0, Math.ceil((earliest - origin) / spb - 1e-9));
  return { time: origin + beats * spb, beats };
}

/** Inverse of beatToSec: beat position `sec` seconds into the phrase (runs on past the end at the final tempo). */
export function secToBeat(score: Tempo, sec: number): number {
  const spb = 60 / score.bpm;
  const r = score.ritardando;
  if (sec <= 0) return sec / spb;
  if (!r) return sec / spb;
  const fromSec = r.fromBeat * spb;
  if (sec <= fromSec) return sec / spb;
  const total = beatToSec(score, score.beats);
  const spbEnd = 60 / r.toBpm;
  if (sec >= total) return score.beats + (sec - total) / spbEnd;
  const span = Math.max(1e-6, score.beats - r.fromBeat);
  const a = (spbEnd - spb) / (2 * span);
  const s = sec - fromSec;
  if (Math.abs(a) < 1e-12) return r.fromBeat + s / spb;
  const disc = Math.max(0, spb * spb + 4 * a * s);
  return r.fromBeat + (-spb + Math.sqrt(disc)) / (2 * a);
}

/** Linear search helper: index of the first element whose time is >= t (array sorted by time). */
export function firstAtOrAfter<T>(items: readonly T[], time: (x: T) => number, t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(items[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
