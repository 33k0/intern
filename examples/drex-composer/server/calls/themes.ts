// Theme writing: shape, then notes one at a time, six sampled drafts, and a separate judge call
// that picks one or rejects all. Rejected sets are redrafted with no cap.

import type { DraftView, ThemeView, VerdictView } from '../../shared/types.ts';
import type { Ctx } from '../context.ts';
import { pct, shapeOf, shareKept } from '../core/facts.ts';
import { contourOf, lineLength, notation, pitched, q, timed, type Line } from '../core/line.ts';
import { clamp, mod, shuffled } from '../core/rng.ts';
import { applyOps } from '../core/transform.ts';
import { keyName } from '../core/theory.ts';
import type { ChoiceOption, Picks, Question } from '../gateway/gateway.ts';
import type { Theme } from '../piece.ts';

const opt = (key: string, label: string, criteria: string, prior = 0): ChoiceOption => ({ key, label, criteria, prior });

export const THEME_DRAFTS = 6; // proposed; tune by ear

// ───────────────────────────── Rhythm cells ─────────────────────────────

interface Cell {
  id: string;
  label: string;
  feel: string;
  pattern: number[];
}

const SIMPLE_CELLS: Cell[] = [
  { id: 'even', label: 'even', feel: 'even notes: calm, hymn-like, steady', pattern: [1] },
  { id: 'long_short', label: 'long-short', feel: 'dotted long-short: leaning forward, lyrical', pattern: [1.5, 0.5] },
  { id: 'short_short_long', label: 'short-short-long', feel: 'two quick notes then a long one: speech-like, catchy', pattern: [0.5, 0.5, 1] },
  { id: 'syncopated', label: 'syncopated', feel: 'off-beat pushes: restless, dance-like', pattern: [0.75, 0.75, 0.5] },
  { id: 'long_then_run', label: 'long, then a run', feel: 'a held note released into quick notes: a breath then motion', pattern: [2, 0.5, 0.5, 0.5, 0.5] },
];

const COMPOUND_CELLS: Cell[] = [
  { id: 'even', label: 'even beats', feel: 'one note per beat: broad, calm', pattern: [1] },
  { id: 'lilt', label: 'lilt', feel: 'long-short lilt inside the beat: rocking, wave-like', pattern: [2 / 3, 1 / 3] },
  { id: 'flowing', label: 'flowing', feel: 'running triplet eighths: flowing, restless', pattern: [1 / 3] },
  { id: 'held_then_lilt', label: 'held, then lilt', feel: 'a long held note that tips into a lilt: longing', pattern: [2, 2 / 3, 1 / 3] },
  { id: 'broad_then_quick', label: 'broad, then quick', feel: 'a broad note answered by a quick one: sighing', pattern: [4 / 3, 2 / 3] },
];

export const cellsFor = (sub: 2 | 3) => (sub === 3 ? COMPOUND_CELLS : SIMPLE_CELLS);

/** Lay `count` notes of a rhythm cell across one unit, leaving the last note to ring. */
export function rhythmFor(cell: Cell, count: number, unit: number): number[] {
  for (const m of [2, 1, 0.5]) {
    const durs: number[] = [];
    for (let i = 0; i < count - 1; i++) durs.push(q(cell.pattern[i % cell.pattern.length] * m));
    const used = durs.reduce((a, b) => a + b, 0);
    const room = q(unit - used);
    if (room >= Math.min(1, m)) {
      durs.push(Math.min(room, 4));
      return durs;
    }
  }
  // Too many notes for the unit even at the fastest setting: squeeze evenly.
  const each = q(unit / count);
  return Array.from({ length: count }, () => each);
}

// ───────────────────────────── Shape ─────────────────────────────

interface Shape {
  /** Bars the theme fills. */
  bars: number;
  count: number;
  contour: string;
  cell: Cell;
  start: number;
  end: number;
  leapAt: number;
}

const CONTOURS: Record<string, string> = {
  arch: 'arch: rises to a peak near the middle, then falls. Balanced, singing',
  rising: 'rising: climbs through the phrase. Hopeful, reaching, opening outward',
  falling: 'falling: descends through the phrase. Sighing, resigned, settling',
  valley: 'valley: dips and comes back up. Searching, then recovering',
  wave: 'wave: turns back on itself more than once. Restless or playful',
};

const START = [
  { key: 'start_1', deg: 0, text: 'starts on the tonic: grounded' },
  { key: 'start_3', deg: 2, text: 'starts on the third: warm, already in mid-thought' },
  { key: 'start_5', deg: 4, text: 'starts on the fifth: open, poised' },
];
const END = [
  { key: 'end_1', deg: 0, text: 'ends on the tonic: closed, at rest' },
  { key: 'end_2', deg: 1, text: 'ends on the second: unresolved, leaning' },
  { key: 'end_3', deg: 2, text: 'ends on the third: gentle, half-settled' },
  { key: 'end_5', deg: 4, text: 'ends on the fifth: open, asking for more' },
  { key: 'end_7', deg: 6, text: 'ends on the seventh: left hanging, aching' },
];

function shapeQuestions(ctx: Ctx, contrastWith?: Theme): Question[] {
  const { piece } = ctx;
  const { style } = piece.rules;
  const m = piece.mood;
  const orch = style === 'bittersweet_orchestral';
  const beat = style === 'beat_driven';
  const targetCount = beat ? 4.6 : orch ? 6 : 5.4;
  const other = contrastWith ? { contour: contrastWith.contour, count: pitched(contrastWith.line).length } : null;
  const contourPrior: Record<string, number> = {
    arch: 1 + (orch ? 0.4 : 0),
    rising: Math.max(0, m.valence) * 1.1 + m.size * 0.5,
    falling: Math.max(0, -m.valence) * 1.2 + 0.2,
    valley: 0.2 + m.darkness * 0.5,
    wave: m.playful * 1.5 + (beat ? 0.7 : 0),
  };
  const cells = cellsFor(piece.rules.meter.sub);
  const cellPrior: Record<string, number> = {
    even: (1 - m.energy) * 0.8, long_short: 0.9, short_short_long: 0.5 + m.playful, syncopated: (beat ? 1.6 : 0) + m.energy * 0.6 - 0.3,
    long_then_run: 0.4, lilt: 1 + (orch ? 0.3 : 0), flowing: m.energy * 0.9 - 0.2, held_then_lilt: orch ? 1.1 : 0.3, broad_then_quick: 0.7,
  };
  const barText: Record<number, [string, number]> = {
    1: ['one bar: a short motif, a cell that can be repeated, answered and broken up', beat ? 1.2 : 0.5],
    2: ['two bars: a sung phrase, the classic length', 1.2],
    3: ['three bars: a long-breathed line that does not fall into squares', beat ? -2 : 0.3],
  };
  return [
    // Only the main theme chooses its length; later themes match it.
    ...(contrastWith ? [] : [{
      id: 'bars', type: 'choice' as const, label: 'Theme length in bars',
      instructions: 'How many bars should the theme fill?',
      options: (beat ? [1, 2] : [1, 2, 3]).map((b) => opt(`b${b}`, `${b} bar${b === 1 ? '' : 's'}`, barText[b][0], barText[b][1])),
    }]),
    {
      id: 'length', type: 'choice', label: 'Theme length',
      instructions: 'How many notes should the theme have? A theme must be short enough to remember and long enough to develop.',
      options: [4, 5, 6, 7, 8].map((n) => opt(`n${n}`, `${n} notes`, `${n} notes`, -(((n - targetCount) / 1.3) ** 2) - (other && other.count === n ? 0.8 : 0))),
    },
    {
      id: 'contour', type: 'choice', label: 'Contour',
      instructions: 'What overall shape should the theme trace?',
      options: Object.entries(CONTOURS).map(([k, text]) => opt(k, k, text, contourPrior[k] - (other?.contour === k ? 1.6 : 0))),
    },
    {
      id: 'rhythm_cell', type: 'choice', label: 'Rhythm cell',
      instructions: 'Which rhythm cell should the theme be built from?',
      options: cells.map((c) => opt(c.id, c.label, c.feel, cellPrior[c.id] ?? 0)),
    },
    {
      id: 'start_degree', type: 'choice', label: 'Starting degree',
      instructions: 'Which scale degree should the theme start on?',
      options: START.map((s) => opt(s.key, s.key.replace('start_', 'degree '), s.text, s.deg === 4 ? 0.5 : s.deg === 2 ? 0.4 : 0.3)),
    },
    {
      id: 'end_degree', type: 'choice', label: 'Ending degree',
      instructions: 'Which scale degree should the theme end on?',
      options: END.map((e) => opt(e.key, e.key.replace('end_', 'degree '), e.text,
        e.deg === 0 ? 0.6 + Math.max(0, m.valence) * 0.5 : e.deg === 1 ? 0.3 + (orch ? 0.5 : 0) : e.deg === 2 ? 0.4 : e.deg === 4 ? 0.3 : -0.3 + Math.max(0, -m.valence) * 0.6)),
    },
    {
      id: 'leap_position', type: 'choice', label: 'Where the leap sits',
      instructions: 'A theme gets one leap; everything else moves by step or repeats. Where should the leap sit?',
      options: [
        opt('early', 'early', 'early: the theme opens with its gesture, then settles by step', 0.6),
        opt('middle', 'middle', 'in the middle: steps lead to the leap and away from it', 0.7),
        opt('late', 'late', 'late: steps build up to a leap just before the end', 0.2),
      ],
    },
  ];
}

function shapeFrom(p: Picks, sub: 2 | 3, themeBars: number): Shape {
  const bars = p.bars ? Number(p.bars.slice(1)) : themeBars;
  // A one-bar motif cannot hold eight notes, nor a three-bar line only four.
  const count = clamp(Number(p.length.slice(1)), bars === 3 ? 5 : 4, bars === 1 ? 6 : 8);
  const leapAt = p.leap_position === 'early' ? 1 : p.leap_position === 'late' ? count - 2 : Math.floor((count - 1) / 2);
  return {
    bars,
    count,
    contour: p.contour,
    cell: cellsFor(sub).find((c) => c.id === p.rhythm_cell)!,
    start: START.find((s) => s.key === p.start_degree)!.deg,
    end: END.find((e) => e.key === p.end_degree)!.deg,
    leapAt: clamp(leapAt, 1, Math.max(1, count - 2)),
  };
}

// ───────────────────────────── Notes, one at a time ─────────────────────────────

const CHORD_DEGREES = [0, 2, 4];
const degName = (d: number) => `degree ${mod(d, 7) + 1}${d >= 7 ? ' (upper octave)' : d < 0 ? ' (lower octave)' : ''}`;

function leapTarget(from: number, dir: 1 | -1): number {
  for (let d = from + 2 * dir; Math.abs(d - from) <= 7; d += dir) {
    if (CHORD_DEGREES.includes(mod(d, 7))) return d;
  }
  return from + 2 * dir;
}

/** The end degree, placed in the octave nearest the note before it. */
function nearestEnd(prev: number, end: number): number {
  let best = end;
  for (const cand of [end - 14, end - 7, end, end + 7, end + 14]) if (Math.abs(cand - prev) < Math.abs(best - prev)) best = cand;
  return best;
}

function wantedDirection(shape: Shape, i: number): number {
  const f = i / (shape.count - 1);
  switch (shape.contour) {
    case 'arch': return f <= 0.5 ? 1 : -1;
    case 'rising': return 1;
    case 'falling': return -1;
    case 'valley': return f <= 0.5 ? -1 : 1;
    default: return Math.floor((i - 1) / 2) % 2 === 0 ? 1 : -1;
  }
}

async function draftNotes(ctx: Ctx, shape: Shape, label: string, themeId: string, extraState: string[]): Promise<Line> {
  const { piece, gw } = ctx;
  const durs = rhythmFor(shape.cell, shape.count, shape.bars * piece.rules.meter.beatsPerBar);
  const degs = [shape.start];
  for (let i = 1; i <= shape.count - 2; i++) {
    const prev = degs[i - 1];
    const before = degs[i - 2];
    const lastMove = before === undefined ? 0 : prev - before;
    const remaining = shape.count - 1 - i; // notes still to come after this one, including the fixed last note
    const want = wantedDirection(shape, i);
    const describe = (target: number, how: string) => {
      const toEnd = Math.abs(nearestEnd(target, shape.end) - target);
      return `${how} to ${degName(target)}. ${remaining} note${remaining === 1 ? '' : 's'} left after this; the last must be degree ${mod(shape.end, 7) + 1}, ${toEnd} step${toEnd === 1 ? '' : 's'} from here.`;
    };
    const prior = (target: number, kind: 'step' | 'repeat' | 'leap') => {
      const dir = Math.sign(target - prev);
      let s = 0;
      if (dir === want) s += 1.2;
      if (kind === 'repeat') s -= ctx.piece.rules.style === 'beat_driven' ? 0 : 0.5;
      if (kind === 'repeat' && lastMove === 0 && degs.length > 1) s -= 1.2;
      if (Math.abs(lastMove) >= 2 && dir === -Math.sign(lastMove) && kind === 'step') s += 1; // recover a leap by step, the other way
      const toEnd = Math.abs(nearestEnd(target, shape.end) - target);
      if (toEnd > remaining + 1) s -= 1.5 * (toEnd - remaining - 1);
      if (Math.abs(target - shape.start) > 6) s -= 1.5;
      return s;
    };
    let options: ChoiceOption[];
    if (i === shape.leapAt) {
      const up = leapTarget(prev, 1);
      const down = leapTarget(prev, -1);
      options = [
        opt('leap_up', 'leap up', describe(up, `Leap up a ${['', '', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'octave'][up - prev] ?? 'wide interval'} to a chord tone,`), prior(up, 'leap') + 0.3),
        opt('leap_down', 'leap down', describe(down, `Leap down a ${['', '', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'octave'][prev - down] ?? 'wide interval'} to a chord tone,`), prior(down, 'leap')),
      ];
    } else {
      options = [
        opt('step_up', 'step up', describe(prev + 1, 'Step up'), prior(prev + 1, 'step')),
        opt('step_down', 'step down', describe(prev - 1, 'Step down'), prior(prev - 1, 'step')),
        opt('repeat', 'repeat', describe(prev, 'Repeat the note, staying'), prior(prev, 'repeat')),
      ];
    }
    const soFar: Line = degs.map((d, k) => ({ deg: d, dur: durs[k] }));
    const ans = await gw.ask({
      callType: 'theme_note', title: `Theme ${themeId} ${label}: note ${i + 1} of ${shape.count}`,
      state: piece.preludeState('theme_note', [
        ...extraState,
        `SHAPE   ${shape.bars} bar${shape.bars === 1 ? '' : 's'}, ${shape.count} notes; contour ${shape.contour}; rhythm ${shape.cell.label} (${durs.map((d) => Math.round(d * 100) / 100).join(' ')} beats); ends on degree ${mod(shape.end, 7) + 1}; the one leap is note ${shape.leapAt + 1}`,
        `SO FAR  ${notation(soFar)}   (degree(beats); this is note ${i + 1})`,
      ]),
      questions: [{
        id: 'next_note', type: 'choice', label: `Note ${i + 1}`,
        instructions: i === shape.leapAt
          ? 'This is the theme\'s one leap. Which way should it go?'
          : 'How should the melody move to its next note?',
        options,
      }],
      picking: 'sampled', draws: 1,
    });
    const pick = ans.picks[0].next_note;
    degs.push(pick === 'step_up' ? prev + 1 : pick === 'step_down' ? prev - 1 : pick === 'repeat' ? prev : pick === 'leap_up' ? leapTarget(prev, 1) : leapTarget(prev, -1));
  }
  degs.push(nearestEnd(degs[degs.length - 1], shape.end));
  return degs.map((d, k) => ({ deg: d, dur: durs[k] }));
}

// ───────────────────────────── Drafts and judge ─────────────────────────────

function themeView(ctx: Ctx, theme: Theme): ThemeView {
  return { id: theme.id, kind: theme.kind, notation: notation(theme.line), contour: theme.contour, notes: timed(theme.line, ctx.piece.rules.key) };
}

/**
 * Draft and judge one theme. `contrastWith` flips the judge for a contrast theme: it must differ
 * from the main theme while fitting the key and mood.
 */
export async function writeTheme(ctx: Ctx, id: string, kind: 'main' | 'contrast', contrastWith?: Theme): Promise<Theme> {
  const { piece, gw } = ctx;
  const key = piece.rules.key;
  const extra = [`KEY     ${keyName(key)}; ${piece.rules.meter.id}${contrastWith || piece.themes.length ? `; one theme fills ${piece.unitBeats} beats (${piece.themeBars} bar${piece.themeBars === 1 ? '' : 's'})` : ''}`];
  if (contrastWith) extra.push(`THEME ${contrastWith.id} ${notation(contrastWith.line)}   contour: ${contrastWith.contour}   (the main theme; the new theme must contrast with it)`);
  let rejectNote = '';

  for (let round = 1; ; round++) {
    const state = piece.preludeState('theme_shape', [...extra, ...(rejectNote ? [`REJECTS last round: "${rejectNote}"`] : [])]);
    const shapeAns = await gw.ask({
      callType: 'theme_shape', title: `Theme ${id}: shape (round ${round})`,
      state, questions: shapeQuestions(ctx, contrastWith), picking: 'sampled', draws: THEME_DRAFTS,
    });
    const shapes = shapeAns.picks.map((p) => shapeFrom(p, piece.rules.meter.sub, piece.themeBars));
    const lines = await Promise.all(shapes.map((s, i) => draftNotes(ctx, s, `draft ${i + 1}`, id, extra)));

    // Shuffle before judging so position cannot bias the pick.
    const order = shuffled(lines.map((_l, i) => i), ctx.rng);
    const labelled = order.map((src, pos) => ({ id: `draft_${pos + 1}`, line: lines[src], shape: shapes[src] }));

    const scored = labelled.map((d) => {
      const sh = shapeOf(d.line, key);
      const kept = contrastWith ? shareKept(contrastWith.line, d.line) : null;
      let s = 0;
      if (sh.rangeSemitones >= 5 && sh.rangeSemitones <= 12) s += 1;
      if (sh.rangeSemitones > 14) s -= 1;
      if (sh.leapRecovered) s += 0.9;
      if (sh.distinct >= Math.min(4, d.shape.count - 1)) s += 0.9;
      if (sh.repeats > 2) s -= 0.6 * (sh.repeats - 2);
      if (sh.oneDirection) s -= 1;
      if (contourOf(d.line) === d.shape.contour) s += 0.5;
      if (kept) s += 1.6 * (1 - kept.overall) - 0.6;
      const facts = [
        { label: 'length', value: `${d.shape.bars} bar${d.shape.bars === 1 ? '' : 's'}, ${d.shape.count} notes` },
        { label: 'range', value: `${sh.rangeSemitones} semitones` },
        { label: 'largest leap', value: `${sh.largestLeap + 1 > 1 ? `${['unison', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'octave'][sh.largestLeap] ?? 'wide'}` : 'none'}${sh.leapRecovered ? ', recovered by step' : ''}` },
        { label: 'distinct pitches', value: String(sh.distinct) },
        { label: 'contour heard', value: contourOf(d.line) },
        ...(kept ? [{ label: `kept from theme ${contrastWith!.id}`, value: `contour ${pct(kept.contour)}, intervals ${pct(kept.intervals)}, rhythm ${pct(kept.rhythm)}` }] : []),
      ];
      return { ...d, facts, score: s };
    });
    const best = Math.max(...scored.map((d) => d.score));

    const verdictQ: Question = {
      id: 'verdict', type: 'choice', label: `Best theme ${id} draft`,
      instructions: contrastWith
        ? `Which draft is the best contrast theme for the departures of this piece: clearly different from theme ${contrastWith.id}, yet at home in the key and mood of the prompt? Choose "none" if none is good enough.`
        : 'Which draft is the best main theme for this piece: memorable, singable, fitting the prompt and style sheet, with room to be developed? Choose "none" if none is good enough.',
      options: [
        ...scored.map((d) => opt(d.id, d.id.replace('_', ' '), `${notation(d.line)} | ${d.facts.map((f) => `${f.label}: ${f.value}`).join('; ')}`, d.score * 1.6)),
        opt('none', 'none', 'None of these is good enough; draft again.', (best < 1.9 ? 2.4 : 1.1) * 1.6),
      ],
    };
    const whyQ: Question = {
      id: 'reject_reason', type: 'choice', label: 'If none: why',
      instructions: 'If no draft is good enough, what is the main weakness to fix in the next round?',
      options: [
        opt('shapeless', 'shapeless', 'The drafts wander without a clear shape or gesture.', 1),
        opt('too_plain', 'too plain', 'The drafts are scale fragments with nothing memorable.', 0.8),
        opt('too_jumpy', 'too jumpy', 'The drafts are awkward to sing; too wide or erratic.', 0.2),
        opt('wrong_mood', 'wrong mood', 'The drafts do not fit the prompt or style sheet.', 0.4),
        ...(contrastWith ? [opt('too_similar', 'too similar', `The drafts are too close to theme ${contrastWith.id} to work as a contrast.`, 1.2)] : []),
      ],
    };
    const judge = await gw.ask({
      callType: 'theme_judge', title: `Theme ${id} judge (round ${round})`,
      state: piece.preludeState('theme_judge', [
        ...extra,
        'DRAFTS  ' + scored.map((d) => `${d.id}: ${notation(d.line)}`).join('\n        '),
      ]),
      questions: [verdictQ, whyQ], picking: 'top',
    });
    const picked = judge.picks[0].verdict;
    const reasonKey = judge.picks[0].reject_reason;
    const reasonText = whyQ.options.find((o) => o.key === reasonKey)!.criteria;
    const verdict: VerdictView = {
      picked: picked === 'none' ? null : picked,
      reason: picked === 'none' ? reasonText : 'Accepted as the theme.',
      probabilities: judge.probabilities.verdict,
    };
    const drafts: DraftView[] = scored.map((d) => ({
      id: d.id, notation: notation(d.line), lineage: `${d.shape.contour}, ${d.shape.cell.label}`, notes: timed(d.line, key), facts: d.facts,
    }));
    ctx.emit({ type: 'theme_drafts', themeId: id, round, drafts, verdict });

    if (picked !== 'none') {
      const win = scored.find((d) => d.id === picked)!;
      const theme: Theme = { id, kind, line: win.line, contour: contourOf(win.line) };
      if (kind === 'main') piece.themeBars = win.shape.bars;
      piece.themes.push(theme);
      ctx.emit({ type: 'theme', theme: themeView(ctx, theme) });
      return theme;
    }
    rejectNote = reasonText;
  }
}

/** The counter-theme is derived from the main theme. Code lists the derivations; Drex picks one. */
export async function deriveCounterTheme(ctx: Ctx, id: string): Promise<Theme> {
  const { piece, gw } = ctx;
  const main = piece.mainTheme;
  const tctx = { grid: piece.grid };
  const below = (line: Line, steps: number): Line => line.map((n) => (n.deg === null ? { ...n } : { ...n, deg: n.deg - steps }));
  const candidates: { key: string; label: string; how: string; line: Line; prior: number }[] = [
    { key: 'inversion_low', label: 'inverted, an octave lower', how: 'the theme inverted and set an octave lower: moves against the theme in contrary motion', line: below(applyOps(main.line, ['inversion'], tctx), 7), prior: 1.1 },
    { key: 'augmented_head', label: 'opening, augmented', how: 'the opening of the theme at half speed, an octave lower: a slow shadow of the theme', line: below(applyOps(main.line, ['fragment_head', 'augmentation'], tctx), 7), prior: 0.9 },
    { key: 'retrograde_low', label: 'backwards, a sixth lower', how: 'the theme backwards, a sixth lower: the same notes heard as an echo', line: below(applyOps(main.line, ['retrograde'], tctx), 5), prior: 0.5 },
    { key: 'sixths_below', label: 'in sixths below', how: 'the theme a sixth lower, moving in parallel: sweet and blended', line: below(main.line, 5), prior: 0.3 },
    { key: 'inverted_tail', label: 'closing notes inverted, augmented', how: 'the close of the theme inverted at half speed, an octave lower: a slow answer to the theme\'s ending', line: below(applyOps(main.line, ['fragment_tail', 'inversion', 'augmentation'], tctx), 7), prior: 0.6 },
  ];
  const ans = await gw.ask({
    callType: 'theme_derive', title: `Counter-theme ${id}: derivation`,
    state: piece.preludeState('theme_derive', [`KEY     ${keyName(piece.rules.key)}`, piece.themeLines()]),
    questions: [{
      id: 'derivation', type: 'choice', label: 'Counter-theme derivation',
      instructions: `Which derivation of theme ${main.id} makes the best counter-theme: one that can run under the theme without copying or fighting it?`,
      options: candidates.map((c) => {
        const kept = shareKept(main.line, c.line);
        return opt(c.key, c.label, `${c.how}. Notes: ${notation(c.line)}. Keeps contour ${pct(kept.contour)}, intervals ${pct(kept.intervals)}, rhythm ${pct(kept.rhythm)} of the theme; lasts ${lineLength(c.line)} beats.`, c.prior);
      }),
    }],
    picking: 'top',
  });
  const chosen = candidates.find((c) => c.key === ans.picks[0].derivation)!;
  const theme: Theme = { id, kind: 'counter', line: chosen.line, contour: contourOf(chosen.line), derivation: `theme ${main.id} ${chosen.label}` };
  piece.themes.push(theme);
  ctx.emit({ type: 'theme', theme: themeView(ctx, theme) });
  return theme;
}
