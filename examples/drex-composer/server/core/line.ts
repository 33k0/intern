// A melodic line in scale degrees. Lines stay in degrees until orchestration, so every
// transformation is key-independent and the lineage back to the theme stays exact.

import { degreeToMidi, type Key } from './theory.ts';
import { mod } from './rng.ts';

export interface LNote {
  /** Diatonic degree index (0 = tonic in the central octave); null is a rest. */
  deg: number | null;
  /** Chromatic alteration in semitones. */
  alt?: number;
  /** Length in beats. */
  dur: number;
}

export type Line = LNote[];

/** Snap to a 1/12-beat grid so thirds and halves both stay exact. */
export const q = (x: number) => Math.round(x * 12) / 12;

export const lineLength = (line: Line) => q(line.reduce((s, n) => s + n.dur, 0));
export const pitched = (line: Line) => line.filter((n) => n.deg !== null) as (LNote & { deg: number })[];

function fmtDur(d: number): string {
  const r = Math.round(d * 100) / 100;
  const s = String(r);
  return s.startsWith('0.') ? s.slice(1) : s;
}

/** "5(1.5) 6(.5) 5(1) 3(2) 2(1) 1(3)" — degree 1..7, ' per octave up, , per octave down, r = rest. */
export function notation(line: Line): string {
  return line
    .map((n) => {
      if (n.deg === null) return `r(${fmtDur(n.dur)})`;
      const oct = Math.floor(n.deg / 7);
      const mark = oct > 0 ? "'".repeat(oct) : ','.repeat(-oct);
      const acc = n.alt ? (n.alt > 0 ? '♯'.repeat(n.alt) : '♭'.repeat(-n.alt)) : '';
      return `${acc}${mod(n.deg, 7) + 1}${mark}(${fmtDur(n.dur)})`;
    })
    .join(' ');
}

export function contourOf(line: Line): string {
  const p = pitched(line).map((n) => n.deg);
  if (p.length < 3) return 'flat';
  const hi = p.indexOf(Math.max(...p));
  const lo = p.indexOf(Math.min(...p));
  const last = p.length - 1;
  let turns = 0;
  let prev = 0;
  for (let i = 1; i < p.length; i++) {
    const d = Math.sign(p[i] - p[i - 1]);
    if (d !== 0) {
      if (prev !== 0 && d !== prev) turns++;
      prev = d;
    }
  }
  if (prev === 0) return 'flat';
  if (turns >= 3) return 'wave';
  if (hi > 0 && hi < last && p[hi] > p[0] && p[hi] > p[last]) return 'arch';
  if (lo > 0 && lo < last && p[lo] < p[0] && p[lo] < p[last]) return 'valley';
  if (p[last] > p[0]) return 'rising';
  if (p[last] < p[0]) return 'falling';
  return 'wave';
}

/** Notes with onsets, for drawing and for realising. */
export function timed(line: Line, key: Key, octaveShift = 0): { midi: number; t: number; dur: number }[] {
  const out: { midi: number; t: number; dur: number }[] = [];
  let t = 0;
  for (const n of line) {
    if (n.deg !== null) out.push({ midi: degreeToMidi(key, n.deg, n.alt ?? 0) + 12 * octaveShift, t: q(t), dur: n.dur });
    t += n.dur;
  }
  return out;
}

/** Cut a line to at most `beats`, shortening the note that crosses the edge. */
export function truncate(line: Line, beats: number, minDur = 0.25): Line {
  const out: Line = [];
  let t = 0;
  for (const n of line) {
    if (t >= beats - 1e-9) break;
    const room = q(beats - t);
    if (n.dur <= room + 1e-9) {
      out.push({ ...n });
      t += n.dur;
    } else {
      if (room >= minDur) out.push({ ...n, dur: room });
      t = beats;
    }
  }
  return out;
}

/** Pad a line up to `beats`: let the last note ring a little, then rest. */
export function padTo(line: Line, beats: number, maxRing = 2): Line {
  const out = line.map((n) => ({ ...n }));
  let gap = q(beats - lineLength(out));
  if (gap <= 0) return out;
  const last = out[out.length - 1];
  if (last && last.deg !== null) {
    const ring = Math.min(gap, maxRing);
    last.dur = q(last.dur + ring);
    gap = q(gap - ring);
  }
  if (gap > 0) out.push({ deg: null, dur: gap });
  return out;
}

export function mergeRests(line: Line): Line {
  const out: Line = [];
  for (const n of line) {
    const last = out[out.length - 1];
    if (n.deg === null && last && last.deg === null) last.dur = q(last.dur + n.dur);
    else if (n.dur > 0) out.push({ ...n });
  }
  return out;
}
