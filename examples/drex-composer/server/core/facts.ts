// The fact measurer. Code measures; it never gives a verdict. These numbers go into the state
// for the judge calls, which decide what to do with them.

import { pitched, q, type Line } from './line.ts';
import { chordName, degreeToMidi, fitOf, midiName, type Chord, type Key } from './theory.ts';

/** Longest common subsequence length. */
function lcs<T>(a: T[], b: T[], same: (x: T, y: T) => boolean = (x, y) => x === y): number {
  if (!a.length || !b.length) return 0;
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = same(a[i - 1], b[j - 1]) ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

const intervalsOf = (line: Line) => {
  const p = pitched(line);
  return p.slice(1).map((n, i) => n.deg - p[i].deg);
};
const contourSigns = (line: Line) => intervalsOf(line).map(Math.sign);
const durations = (line: Line) => pitched(line).map((n) => q(n.dur));
const ratios = (line: Line) => {
  const d = durations(line);
  return d.slice(1).map((x, i) => Math.round((x / d[i]) * 100) / 100);
};

export interface Kept {
  contour: number;
  intervals: number;
  rhythm: number;
  /** Weighted overall share, 0..1. */
  overall: number;
}

/**
 * Best match of `a` inside any stretch of `b` about one and a half times its own length.
 * A long phrase always contains a short theme's ups and downs somewhere if you may skip freely, so
 * the search is kept local: the theme has to survive in one place, with room for added notes.
 */
function keptIn<T>(a: T[], b: T[]): number {
  if (!a.length || !b.length) return 0;
  const width = Math.ceil(a.length * 1.5) + 1;
  if (b.length <= width) return lcs(a, b) / a.length;
  let best = 0;
  for (let i = 0; i + width <= b.length && best < a.length; i++) best = Math.max(best, lcs(a, b.slice(i, i + width)));
  return best / a.length;
}

/** Share of a theme's contour, intervals and rhythm that survives in a line (0..1 each). */
export function shareKept(theme: Line, line: Line): Kept {
  const intervals = keptIn(intervalsOf(theme), intervalsOf(line));
  const contour = keptIn(contourSigns(theme), contourSigns(line));
  const rhythm = Math.max(keptIn(durations(theme), durations(line)), keptIn(ratios(theme), ratios(line)));
  return { contour, intervals, rhythm, overall: 0.4 * intervals + 0.25 * contour + 0.35 * rhythm };
}

/** How alike two phrases are, 0..1: mostly melody (exact pitch and length), partly chords. */
export function similarity(a: Line, b: Line, chordsA: string[] = [], chordsB: string[] = []): number {
  const tok = (line: Line) => pitched(line).map((n) => `${n.deg}:${q(n.dur)}`);
  const ta = tok(a);
  const tb = tok(b);
  const melodic = ta.length && tb.length ? lcs(ta, tb) / Math.max(ta.length, tb.length) : 0;
  if (!chordsA.length || chordsA.length !== chordsB.length) return melodic;
  const same = chordsA.filter((c, i) => c === chordsB[i]).length / chordsA.length;
  return 0.75 * melodic + 0.25 * same;
}

export interface Clash {
  beat: number;
  note: string;
  chord: string;
}

/** Melody notes that sit a semitone above a chord tone of the harmony under them. */
export function clashes(line: Line, slots: { t: number; dur: number; chord: Chord }[], key: Key): Clash[] {
  const out: Clash[] = [];
  let t = 0;
  for (const n of line) {
    if (n.deg !== null && n.dur >= 0.5) {
      const slot = slots.find((s) => t >= s.t - 1e-6 && t < s.t + s.dur - 1e-6);
      if (slot) {
        const midi = degreeToMidi(key, n.deg, n.alt ?? 0);
        if (fitOf(midi, slot.chord, key) === 'clash') out.push({ beat: q(t), note: midiName(midi, key), chord: chordName(slot.chord, key) });
      }
    }
    t += n.dur;
  }
  return out;
}

export interface LineShape {
  rangeSemitones: number;
  largestLeap: number;
  distinct: number;
  repeats: number;
  leapRecovered: boolean;
  oneDirection: boolean;
}

export function shapeOf(line: Line, key: Key): LineShape {
  const p = pitched(line);
  const midis = p.map((n) => degreeToMidi(key, n.deg, n.alt ?? 0));
  const iv = intervalsOf(line);
  let largest = 0;
  let recovered = false;
  iv.forEach((x, i) => {
    if (Math.abs(x) > Math.abs(largest)) largest = x;
    if (Math.abs(x) >= 2 && i + 1 < iv.length && Math.abs(iv[i + 1]) === 1 && Math.sign(iv[i + 1]) === -Math.sign(x)) recovered = true;
  });
  const signs = iv.map(Math.sign).filter((s) => s !== 0);
  return {
    rangeSemitones: midis.length ? Math.max(...midis) - Math.min(...midis) : 0,
    largestLeap: Math.abs(largest),
    distinct: new Set(p.map((n) => n.deg)).size,
    repeats: iv.filter((x) => x === 0).length,
    leapRecovered: recovered,
    oneDirection: signs.length > 1 && signs.every((s) => s === signs[0]),
  };
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;
