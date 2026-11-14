// The transformation library. Drex chooses which of these to apply; this file only carries them out.

import { lineLength, mergeRests, pitched, q, type Line, type LNote } from './line.ts';

export interface TransformCtx {
  /** Smallest note value used by the meter, in beats (0.5 simple, 1/3 compound). */
  grid: number;
}

export interface MelodicOp {
  id: string;
  /** Name in the option list. */
  label: string;
  /** How it reads in a lineage, e.g. "sequenced up a third". */
  phrase: string;
  /** Effect told to Drex. */
  effect: string;
  apply(line: Line, ctx: TransformCtx): Line;
}

const mapPitch = (line: Line, f: (deg: number, i: number) => number): Line => {
  let i = 0;
  return line.map((n) => (n.deg === null ? { ...n } : { ...n, deg: f(n.deg, i++) }));
};

function reinterval(line: Line, f: (interval: number, index: number, all: number[]) => number): Line {
  const p = pitched(line);
  if (p.length < 2) return line.map((n) => ({ ...n }));
  const intervals = p.slice(1).map((n, i) => n.deg - p[i].deg);
  const next = intervals.map(f);
  const degs = [p[0].deg];
  for (const iv of next) degs.push(degs[degs.length - 1] + iv);
  return mapPitch(line, (_d, i) => degs[i]);
}

function head(line: Line, count: number): Line {
  const out: Line = [];
  let seen = 0;
  for (const n of line) {
    if (n.deg !== null) seen++;
    if (seen > count) break;
    out.push({ ...n });
  }
  return out;
}

function tail(line: Line, count: number): Line {
  const out: Line = [];
  let seen = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    const n = line[i];
    if (n.deg === null && seen === 0) continue; // drop trailing rests
    if (n.deg !== null) seen++;
    if (seen > count) break;
    out.unshift({ ...n });
  }
  return out;
}

const sequence = (steps: number, name: string): MelodicOp => ({
  id: `seq_${steps > 0 ? 'up' : 'down'}_${Math.abs(steps) === 1 ? 'step' : 'third'}`,
  label: `Sequence ${steps > 0 ? 'up' : 'down'} a ${name}`,
  phrase: `sequenced ${steps > 0 ? 'up' : 'down'} a ${name}`,
  effect: steps > 0 ? 'same shape, higher: climbing momentum' : 'same shape, lower: sinking momentum',
  apply: (line) => mapPitch(line, (d) => d + steps),
});

export const MELODIC_OPS: MelodicOp[] = [
  sequence(1, 'step'),
  sequence(2, 'third'),
  sequence(-1, 'step'),
  sequence(-2, 'third'),
  {
    id: 'inversion', label: 'Inversion', phrase: 'inverted',
    effect: 'intervals flipped: familiar but questioning',
    apply: (line) => {
      const p = pitched(line);
      if (!p.length) return line;
      const axis = p[0].deg;
      return mapPitch(line, (d) => 2 * axis - d);
    },
  },
  {
    id: 'retrograde', label: 'Retrograde', phrase: 'played backwards',
    effect: 'backwards: a distant echo',
    apply: (line) => mergeRests(line.slice().reverse().map((n) => ({ ...n }))),
  },
  {
    id: 'augmentation', label: 'Augmentation', phrase: 'augmented (twice as slow)',
    effect: 'twice as slow: weight, calm',
    apply: (line) => line.map((n) => ({ ...n, dur: q(n.dur * 2) })),
  },
  {
    id: 'diminution', label: 'Diminution', phrase: 'diminished (twice as fast)',
    effect: 'twice as fast: urgency, decoration',
    apply: (line, ctx) => line.map((n) => ({ ...n, dur: Math.max(ctx.grid / 2, q(n.dur / 2)) })),
  },
  {
    id: 'fragment_head', label: 'Fragmentation (opening notes)', phrase: 'fragmented to its opening',
    effect: 'two or three notes only: tension, unfinished',
    apply: (line) => head(line, pitched(line).length <= 3 ? 2 : 3),
  },
  {
    id: 'fragment_tail', label: 'Fragmentation (closing notes)', phrase: 'fragmented to its close',
    effect: 'only the last two or three notes: tension, an ending without its beginning',
    apply: (line) => tail(line, pitched(line).length <= 3 ? 2 : 3),
  },
  {
    id: 'liquidation', label: 'Liquidation', phrase: 'liquidated',
    effect: 'stripped to its barest feature: dissolving, preparing change',
    apply: (line) => {
      const p = pitched(line);
      if (p.length < 2) return line.map((n) => ({ ...n }));
      const [a, b] = p;
      return [
        { deg: a.deg, dur: a.dur },
        { deg: b.deg, dur: b.dur },
        { deg: b.deg, dur: b.dur },
        { deg: b.deg, dur: q(b.dur * 2) },
      ];
    },
  },
  {
    id: 'extension', label: 'Extension', phrase: 'tail extended',
    effect: 'runs past its expected end: delay, longing',
    apply: (line) => {
      const out = line.map((n) => ({ ...n }));
      while (out.length && out[out.length - 1].deg === null) out.pop();
      const p = pitched(out);
      if (p.length < 2) return out;
      const last = out[out.length - 1] as LNote & { deg: number };
      const before = p[p.length - 2];
      const dir = Math.sign(last.deg - before.deg) || -1;
      const longDur = last.dur;
      const shortDur = Math.max(before.dur, 0.5);
      last.dur = q(Math.min(longDur, shortDur));
      out.push({ deg: last.deg + dir, dur: q(shortDur) });
      out.push({ deg: last.deg + 2 * dir, dur: q(longDur) });
      return out;
    },
  },
  {
    id: 'expand', label: 'Interval expansion', phrase: 'leaps widened',
    effect: 'leaps widened: reaching, intensity',
    apply: (line) => {
      const p = pitched(line);
      const intervals = p.slice(1).map((n, i) => n.deg - p[i].deg);
      const hasLeap = intervals.some((iv) => Math.abs(iv) >= 2);
      const biggest = Math.max(0, ...intervals.map(Math.abs));
      let done = false;
      return reinterval(line, (iv) => {
        if (hasLeap) return Math.abs(iv) >= 2 ? iv + Math.sign(iv) : iv;
        if (!done && Math.abs(iv) === biggest && iv !== 0) {
          done = true;
          return iv + Math.sign(iv);
        }
        return iv;
      });
    },
  },
  {
    id: 'contract', label: 'Interval contraction', phrase: 'leaps narrowed',
    effect: 'leaps narrowed: intimacy, withdrawal',
    apply: (line) => reinterval(line, (iv) => (Math.abs(iv) >= 2 ? iv - Math.sign(iv) : iv)),
  },
  {
    id: 'displace_half', label: 'Rhythmic displacement (off the beat)', phrase: 'displaced off the beat',
    effect: 'starts just after the beat: unsettled, fresh',
    apply: (line, ctx) => mergeRests([{ deg: null, dur: ctx.grid }, ...line.map((n) => ({ ...n }))]),
  },
  {
    id: 'displace_beat', label: 'Rhythmic displacement (a beat late)', phrase: 'displaced by a beat',
    effect: 'starts on a different beat: the accents fall in new places',
    apply: (line) => mergeRests([{ deg: null, dur: 1 }, ...line.map((n) => ({ ...n }))]),
  },
  {
    id: 'ornament', label: 'Ornamentation', phrase: 'ornamented',
    effect: 'passing and neighbour notes added: warmth, flow',
    apply: (line, ctx) => {
      const g = ctx.grid;
      const out: Line = [];
      let added = 0;
      for (let i = 0; i < line.length; i++) {
        const n = line[i];
        const next = line.slice(i + 1).find((x) => x.deg !== null);
        if (n.deg === null || added >= 4) {
          out.push({ ...n });
          continue;
        }
        const gap = next && next.deg !== null ? next.deg - n.deg : 0;
        if (Math.abs(gap) === 2 && n.dur >= 2 * g) {
          // Fill a third with a passing note.
          out.push({ ...n, dur: q(n.dur - g) }, { deg: n.deg + Math.sign(gap), dur: g });
          added++;
        } else if (n.dur >= 1.5 && n.dur >= 4 * g && next) {
          // Decorate a long note with its upper neighbour.
          out.push({ ...n, dur: q(n.dur - 2 * g) }, { deg: n.deg + 1, dur: g }, { deg: n.deg, dur: g });
          added++;
        } else {
          out.push({ ...n });
        }
      }
      return out;
    },
  },
  {
    id: 'register_up', label: 'Register transfer (octave up)', phrase: 'moved up an octave',
    effect: 'an octave higher: brighter, more exposed',
    apply: (line) => mapPitch(line, (d) => d + 7),
  },
  {
    id: 'register_down', label: 'Register transfer (octave down)', phrase: 'moved down an octave',
    effect: 'an octave lower: darker, heavier',
    apply: (line) => mapPitch(line, (d) => d - 7),
  },
];

export const MELODIC_OP_BY_ID: Record<string, MelodicOp> = Object.fromEntries(MELODIC_OPS.map((o) => [o.id, o]));

/** Transformations that change the setting of a line rather than its notes. Each is a yes/no for Drex. */
export interface TextureOp {
  id: string;
  label: string;
  phrase: string;
  effect: string;
}

export const TEXTURE_OPS: TextureOp[] = [
  { id: 'reharmonise', label: 'Reharmonise', phrase: 'reharmonised', effect: 'same melody, new chords: familiar tune, changed meaning' },
  { id: 'mode_mixture', label: 'Mode mixture', phrase: 'with a chord borrowed from the parallel mode', effect: 'one chord late in the phrase is borrowed from the parallel major or minor, the key itself staying put: the same idea in a different light for a moment' },
  { id: 'handoff', label: 'Instrument handoff', phrase: 'handed to a new instrument', effect: 'the line passes to another instrument: a new voice takes the idea' },
  { id: 'call_response', label: 'Call and response', phrase: 'split as call and response', effect: 'split between two instruments: conversation' },
  { id: 'overlap', label: 'Overlap', phrase: 'second entry overlapping', effect: 'a second entry begins before the first ends: density' },
  { id: 'pedal_underlay', label: 'Pedal underlay', phrase: 'over a pedal note', effect: 'a held note under changing harmony: suspension, gravity' },
  { id: 'octave_doubling', label: 'Octave doubling', phrase: 'doubled at the octave', effect: 'doubled above or below: power, clarity' },
];

export const TEXTURE_OP_BY_ID: Record<string, TextureOp> = Object.fromEntries(TEXTURE_OPS.map((o) => [o.id, o]));

/** Apply a chain of melodic operations. Unknown or "none" ids are skipped. */
export function applyOps(line: Line, opIds: string[], ctx: TransformCtx): Line {
  let out = line.map((n) => ({ ...n }));
  for (const id of opIds) {
    const op = MELODIC_OP_BY_ID[id];
    if (op) out = op.apply(out, ctx);
  }
  return out;
}

export function describeOps(opIds: string[]): string {
  const parts = opIds.map((id) => MELODIC_OP_BY_ID[id]?.phrase).filter(Boolean);
  return parts.length ? parts.join(', ') : 'intact';
}

export { lineLength };
