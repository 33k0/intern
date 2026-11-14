// The phrase loop: direction questions sampled into drafts, a chord path and voice leading for
// each draft, measured facts, then a judge call that picks one draft or rejects them all.

import type { DraftView, PhraseRole, VerdictView } from '../../shared/types.ts';
import { sigmoid, type Ctx } from '../context.ts';
import { clashes, pct, shareKept, similarity } from '../core/facts.ts';
import { lineLength, mergeRests, notation, padTo, pitched, q, timed, truncate, type Line } from '../core/line.ts';
import { clamp, mod, shuffled } from '../core/rng.ts';
import {
  chordCandidates, chordName, chordPcs, chordToneName, degreeToMidi, fitOf, intervalName, keyName, midiName, MODES,
  parallelMode, tonicChord, usesFlats, type Chord, type Key,
} from '../core/theory.ts';
import { applyOps, describeOps, MELODIC_OPS, TEXTURE_OPS } from '../core/transform.ts';
import type { ChoiceOption, Picks, Question } from '../gateway/gateway.ts';
import { arrivesAfterBreath, isWall, type Direction, type Piece, type SegmentChoice, type Slot } from '../piece.ts';

const opt = (key: string, label: string, criteria: string, prior = 0): ChoiceOption => ({ key, label, criteria, prior });

export const PHRASE_DRAFTS = 4; // proposed; tune by ear
export const COPY_LEVEL = 0.8; // similarity above this counts as a copy (proposed)
export const DRIFT_LEVEL = 0.4; // share of the theme kept below this counts as drift (proposed)

export interface Draft {
  id: string;
  direction: Direction;
  key: Key;
  line: Line;
  lineage: string;
  depth: number;
  intact: boolean;
  related: number;
  slots: Slot[];
  facts: { label: string; value: string }[];
  /** Stand-in only. */
  quality: number;
  failure: string;
}

// ───────────────────────────── Direction ─────────────────────────────

const HARMONIC_RHYTHM: Record<string, string> = {
  two_bars: 'one chord every two bars: broad and still',
  bar: 'one chord per bar: steady, walking harmony',
  half_bar: 'two chords per bar: busy, urgent, pushing forward',
  oscillation: 'two chords alternating bar by bar: stillness, breathing',
};

const ENDINGS: Record<string, string> = {
  resolved: 'resolved: the phrase comes to rest on the tonic',
  half_resolved: 'half-resolved: the phrase pauses on the dominant, expecting more',
  suspended: 'suspended: the phrase ends unresolved and floating',
};

const COUNTER: Record<string, string> = {
  none: 'no counter-melody: the melody stands alone against the harmony',
  counter_theme: 'the counter-theme runs under the melody',
  theme_augmented: 'the opening of the main theme at half speed, low, as a slow shadow of the melody',
  descending_steps: 'a slow stepwise descent from the fifth: a sighing line against the melody',
  sixths_below: 'the melody doubled a sixth below: sweet, blended, sung together',
};

function recentOps(piece: Piece): Map<string, number> {
  const out = new Map<string, number>();
  piece.phrases.slice(-2).forEach((ph, i, all) => {
    const weight = i === all.length - 1 ? 0.9 : 0.5;
    for (const id of [...ph.direction.seg1.ops, ...ph.direction.seg2.ops]) out.set(id, Math.max(out.get(id) ?? 0, weight));
  });
  return out;
}

function opWeight(role: PhraseRole, seg: 1 | 2, id: string): number {
  const dev: Record<string, number> = {
    seq_up_step: 1, seq_up_third: 1, seq_down_step: 0.9, seq_down_third: 0.8, inversion: 0.7, fragment_head: 0.9, fragment_tail: 0.6,
    expand: 0.8, contract: 0.5, displace_half: 0.5, displace_beat: 0.4, ornament: 0.9, extension: 0.7, register_up: 0.5, register_down: 0.4,
    diminution: 0.5, augmentation: 0.3, retrograde: 0.3, liquidation: seg === 2 ? 1 : 0.3, none: 0.1,
  };
  const table: Record<PhraseRole, Record<string, number>> = {
    statement: seg === 1 ? { none: 3.2 } : { none: 0.9, seq_up_step: 1, seq_up_third: 0.8, seq_down_step: 0.8, ornament: 0.8, extension: 0.6 },
    development: dev,
    departure: { none: 1.6, seq_up_step: 0.6, seq_down_step: 0.6, ornament: 0.6, extension: 0.5, inversion: 0.4, seq_up_third: 0.5 },
    return: seg === 1 ? { none: 3.2 } : { none: 1, ornament: 1, extension: 0.8, seq_up_step: 0.6 },
    climax: { register_up: 1.6, expand: 1.3, seq_up_third: 1, augmentation: 0.9, extension: 0.8, none: 0.5, seq_up_step: 0.7 },
    coda: { augmentation: 1.4, liquidation: seg === 2 ? 1.5 : 0.6, fragment_tail: 1, register_down: 0.8, contract: 0.8, none: 0.6, fragment_head: 0.6 },
  };
  return table[role][id] ?? -0.8;
}

/** What the plan has already decided about this phrase's first half: at the climax, the theme may return whole or broadened. */
export function planFixed(piece: Piece, index: number): Picks {
  // The chorus is the hook, whole.
  if (piece.chorusAt(index)) return { seg1_source: 'A', seg1_op1: 'none' };
  if (index !== piece.plan.climaxPhrase) return {};
  if (piece.plan.climaxTheme === 'returns') return { seg1_source: 'A', seg1_op1: 'none' };
  if (piece.plan.climaxTheme === 'broadened') return { seg1_source: 'A', seg1_op1: 'augmentation' };
  return {};
}

function directionQuestions(ctx: Ctx, index: number): Question[] {
  const { piece } = ctx;
  const role = piece.roleOf(index);
  const t = piece.tensionOf(index);
  const style = piece.rules.style;
  const orch = style === 'bittersweet_orchestral';
  const m = piece.mood;
  const recent = recentOps(piece);
  const rej = piece.lastReject.toLowerCase();
  const wasCopy = /close|copy/.test(rej);
  const wasDrift = /related|drift/.test(rej);
  const wasTooNear = /contrast/.test(rej);
  const last = piece.phrases[piece.phrases.length - 1];
  const hasB = !!piece.theme('B');
  const hasC = !!piece.theme('C');
  const section = piece.sectionOf(index);
  const sectionEnd = index === section.last;
  const finalPhrase = index === piece.plan.totalPhrases - 1;
  const fixed = planFixed(piece, index);
  const wallHere = index === piece.plan.climaxPhrase && (isWall(piece.plan.climaxArrival) || piece.plan.climaxArrival === 'bloom');
  const wallNext = index === piece.plan.climaxPhrase - 1 && arrivesAfterBreath(piece.plan.climaxArrival);

  const sources = (seg: 1 | 2): ChoiceOption[] => {
    const lead = role === 'statement' || role === 'return' || role === 'climax' || role === 'coda';
    const out = [
      opt('A', 'theme A', `the main theme: ${notation(piece.mainTheme.line)}`,
        role === 'departure' ? (hasC ? -1.5 : 0.3) - (wasTooNear ? 2.5 : 0) : lead ? 2.6 : 1.5 + (wasDrift ? 1.5 : 0)),
    ];
    if (hasB) out.push(opt('B', 'counter-theme B', `the counter-theme: ${notation(piece.theme('B')!.line)}`, role === 'development' ? 0.3 : -1));
    if (hasC) out.push(opt('C', 'contrast theme C', `the contrast theme, for departures: ${notation(piece.theme('C')!.line)}`, role === 'departure' ? 3 : -2));
    if (last) {
      out.push(opt('prev', 'previous phrase', `carry on from the second half of the previous phrase (${last.lineage})`,
        role === 'development' ? (last.depth < 3 ? 1.1 : -0.4) - (wasDrift ? 1.5 : 0) : role === 'departure' ? (hasC ? 0 : 0.6) : 0.2));
    }
    if (seg === 2) out.push(opt('first_half', 'first half of this phrase', 'answer the first half of this phrase with a variant of itself', role === 'development' ? 1.5 : role === 'departure' ? 1.2 : 0.9));
    return out;
  };

  const ops = (seg: 1 | 2, second: boolean): ChoiceOption[] => {
    const all = [
      opt('none', 'none (intact)', second ? 'no further change' : 'leave the material intact', (second ? 1.7 : 0) + opWeight(role, seg, 'none') * (second ? 0.3 : 1) - (wasCopy ? 1.5 : 0) + (wasDrift ? 1.2 : 0)),
      ...MELODIC_OPS.map((o) => {
        let w = opWeight(role, seg, o.id) * (second ? 0.6 : 1);
        if (t >= 5 && ['seq_up_step', 'seq_up_third', 'expand', 'diminution', 'fragment_head', 'register_up'].includes(o.id)) w += 0.5;
        if (t <= 2.5 && ['augmentation', 'contract', 'register_down', 'liquidation'].includes(o.id)) w += 0.4;
        w -= recent.get(o.id) ?? 0;
        if (wasCopy) w += 0.5;
        if (wasDrift && ['retrograde', 'liquidation', 'inversion', 'fragment_tail'].includes(o.id)) w -= 0.8;
        if (wasTooNear && !hasC && ['retrograde', 'inversion', 'liquidation', 'augmentation', 'contract'].includes(o.id)) w += 1.4;
        return opt(o.id, o.label, o.effect, w);
      }),
    ];
    // The theme returning at the climax may only be lifted an octave, nothing more.
    if (seg === 1 && second && fixed.seg1_source) return all.filter((o) => o.key === 'none' || o.key === 'register_up');
    return all;
  };

  const questions: Question[] = [
    { id: 'seg1_source', type: 'choice', label: 'First half: material', instructions: 'A phrase has two halves. What material should the first half be built from?', options: sources(1) },
    { id: 'seg1_op1', type: 'choice', label: 'First half: transformation', instructions: 'Which transformation should be applied to the first half\'s material?', options: ops(1, false) },
    { id: 'seg1_op2', type: 'choice', label: 'First half: second transformation', instructions: 'Should a second transformation be applied on top, in the first half?', options: ops(1, true) },
    { id: 'seg2_source', type: 'choice', label: 'Second half: material', instructions: 'What material should the second half be built from?', options: sources(2) },
    { id: 'seg2_op1', type: 'choice', label: 'Second half: transformation', instructions: 'Which transformation should be applied to the second half\'s material?', options: ops(2, false) },
    { id: 'seg2_op2', type: 'choice', label: 'Second half: second transformation', instructions: 'Should a second transformation be applied on top, in the second half?', options: ops(2, true) },
    {
      id: 'counter_line', type: 'choice', label: 'Counter-melody',
      instructions: 'What should the counter-melody line be, if the orchestration brings one in?',
      options: Object.entries(COUNTER)
        .filter(([k]) => k !== 'counter_theme' || hasB)
        .map(([k, text]) => opt(k, k.replace(/_/g, ' '), text,
          k === 'none' ? 2.4 - t * 0.55 : k === 'counter_theme' ? 1.1 : k === 'theme_augmented' ? 0.5 + (role === 'departure' ? 0.5 : 0) : k === 'descending_steps' ? 0.5 + Math.max(0, -m.valence) * 0.5 : 0.2 + (role === 'climax' ? 0.6 : 0))),
    },
  ];

  const yesPrior: Record<string, number> = {
    reharmonise: role === 'return' ? 0.88 : role === 'development' ? 0.3 : role === 'statement' ? 0.05 : 0.2,
    mode_mixture: clamp((0.05 + m.darkness * 0.12 + (section.key.tonic !== piece.rules.key.tonic ? 0.15 : 0)) * (index < 3 ? 0.3 : 1), 0, 1),
    handoff: !last ? 0.02 : role === 'return' ? 0.72 : role === 'development' ? 0.28 : 0.15,
    call_response: style === 'playful' ? 0.3 : 0.1,
    overlap: t >= 5 ? 0.34 : 0.07,
    pedal_underlay: role === 'coda' ? 0.5 : orch ? 0.2 + (t <= 2.5 ? 0.2 : 0) : 0.12,
    octave_doubling: role === 'climax' ? 0.88 : t >= 6 ? 0.55 : 0.08,
  };
  for (const tex of TEXTURE_OPS) {
    questions.push({
      id: tex.id, type: 'noul', label: tex.label,
      instructions: `Should this phrase use ${tex.label.toLowerCase()}? Effect: ${tex.effect}.`,
      prior: yesPrior[tex.id],
    });
  }

  questions.push({
    id: 'harmonic_rhythm', type: 'choice', label: 'Harmonic rhythm',
    instructions: 'How fast should the chords change in this phrase?',
    options: Object.entries(HARMONIC_RHYTHM).filter(([k]) => !(wallHere && k === 'half_bar')).map(([k, text]) => opt(k, k.replace(/_/g, ' '), text,
      k === 'oscillation' ? (orch ? 1.6 - t * 0.3 : 0.6) + (index === 0 && orch ? 0.8 : 0)
        : k === 'two_bars' ? 1.2 - t * 0.25
          : k === 'bar' ? 1
            : -1.2 + t * 0.32)),
  });
  const endPref = finalPhrase
    ? { resolved: piece.rules.ending === 'resolved' ? 3 : 0.3, half_resolved: piece.rules.ending === 'sudden_stop' ? 2 : 0, suspended: piece.rules.ending === 'suspended' || piece.rules.ending === 'fade' ? 2.5 : 0.2 }
    : { resolved: (sectionEnd ? 1 : 0.2) + (orch ? 0 : 0.4), half_resolved: 0.9 + (wallNext ? 1.5 : 0), suspended: orch ? 1 : 0.4 };
  questions.push({
    id: 'phrase_ending', type: 'choice', label: 'Phrase ending',
    instructions: wallNext
      ? 'How should the phrase end? The climax arrives straight after it, following a held breath: the chord left hanging in that silence decides whether the arrival feels earned.'
      : 'How should the phrase end?',
    options: Object.entries(ENDINGS).map(([k, text]) => opt(k, k.replace(/_/g, ' '), text, endPref[k as keyof typeof endPref])),
  });

  const nextKey = index + 1 < piece.plan.totalPhrases ? piece.sectionOf(index + 1).key : section.key;
  if (nextKey.tonic !== section.key.tonic || nextKey.mode !== section.key.mode) {
    questions.push({
      id: 'modulation', type: 'choice', label: 'Modulation',
      instructions: `The next phrase is in ${keyName(nextKey)}. How should this phrase get there?`,
      options: [
        opt('pivot', 'pivot chord', 'pivot chord: end on the dominant of the new key so the change feels prepared', 1.2),
        opt('direct', 'direct shift', 'direct shift: no preparation; the new key simply arrives, a jolt or a lift', index + 1 === piece.plan.climaxPhrase ? 1.4 : 0.5),
        opt('common_tone', 'common tone', 'common tone: end on a suspended chord sharing a note with the new key, then melt into it', 0.7),
      ],
    });
  }
  // How long the phrase is. Loop music stays square, and a phrase fitted to picture already has its length.
  if (lengthAsked(piece)) {
    const recent = piece.phrases.slice(-4).map((ph) => ph.score.bars);
    let sameRun = 0;
    for (let i = recent.length - 1; i >= 0 && recent[i] === 4; i--) sameRun++;
    const text: Record<number, [string, number]> = {
      2: ['two bars: half the usual length. One idea said once, then straight on: urgency, an interjection, a quick answer', -0.4 + (t >= 5 ? 0.5 : 0)],
      3: ['three bars: a contracted phrase. The close comes a bar early, so the next phrase arrives sooner than expected: pressing forward', 0.2 + (t >= 4.5 ? 0.5 : 0)],
      4: ['four bars: the regular length. Balanced and expected', 1.7 - 0.45 * sameRun],
      5: ['five bars: an extended phrase. The last note is held through an extra bar: the close lingers, with time to breathe', 0.4 + (sectionEnd ? 0.7 : 0) + (t <= 3 ? 0.3 : 0)],
      6: ['six bars: a long-breathed phrase. Its first idea is said twice before the answer comes: insistence, a broad span', 0.1 + (role === 'climax' ? 0.6 : 0)],
    };
    const min = Math.max(2, piece.themeBars, fixed.seg1_source ? 4 : 2, index === 0 ? Math.min(4, piece.themeBars + 1) : 2);
    questions.push({
      id: 'phrase_length', type: 'choice', label: 'Phrase length',
      instructions: `How many bars long should this phrase be? The theme fills ${piece.themeBars} bar${piece.themeBars === 1 ? '' : 's'}.${recent.length ? ` The last ${recent.length === 1 ? 'phrase was' : `${recent.length} phrases were`} ${recent.join(', ')} bars long.` : ''}`,
      options: [2, 3, 4, 5, 6].filter((b) => b >= min).map((b) => opt(String(b), `${b} bars`, text[b][0], text[b][1])),
    });
  }
  // Whatever the plan already fixed is not asked again.
  return questions.filter((qn) => !(qn.id in fixed));
}

/** Drex chooses each phrase's length, except in loop music (which stays square) and when the picture has already set it. */
const lengthAsked = (piece: Piece) => piece.rules.style !== 'beat_driven' && !piece.picture;

function directionFrom(p: Picks): Direction {
  const seg = (n: 1 | 2): SegmentChoice => {
    const o1 = p[`seg${n}_op1`];
    const o2 = p[`seg${n}_op2`];
    const ops = [o1, o2].filter((o, i, all) => o && o !== 'none' && all.indexOf(o) === i);
    return { source: p[`seg${n}_source`], ops };
  };
  const flags: Record<string, boolean> = {};
  for (const tex of TEXTURE_OPS) flags[tex.id] = p[tex.id] === 'yes';
  return { seg1: seg(1), seg2: seg(2), counter: p.counter_line, flags, harmonicRhythm: p.harmonic_rhythm, ending: p.phrase_ending, modulation: p.modulation };
}

// ───────────────────────────── Realising a direction in notes ─────────────────────────────

function sliceLine(line: Line, from: number, to: number): Line {
  const out: Line = [];
  let t = 0;
  for (const n of line) {
    const a = Math.max(t, from);
    const b = Math.min(t + n.dur, to);
    if (b - a > 1e-6) out.push({ ...n, dur: q(b - a) });
    t += n.dur;
  }
  while (out.length && out[0].deg === null) out.shift();
  while (out.length && out[out.length - 1].deg === null) out.pop();
  return out;
}

export function buildLine(piece: Piece, dir: Direction, index: number): { line: Line; lineage: string; depth: number; intact: boolean; truncated: boolean } {
  const unit = piece.segStart(index);
  const whole = piece.beatsOf(index);
  const bars = piece.barsOf(index);
  const prevHalf = piece.phrases.length ? piece.segStart(piece.phrases[piece.phrases.length - 1].index) : unit;
  const prevWhole = piece.phrases.length ? piece.beatsOf(piece.phrases[piece.phrases.length - 1].index) : whole;
  const ctx = { grid: piece.grid };
  const last = piece.phrases[piece.phrases.length - 1];
  let truncated = false;

  const material = (source: string, firstHalf: Line): { line: Line; name: string; depth: number } => {
    if (source === 'first_half') return { line: firstHalf, name: 'first half', depth: 0 };
    if (source === 'prev' && last) {
      const tail = sliceLine(last.line, prevHalf, prevWhole);
      const use = pitched(tail).length >= 2 ? tail : sliceLine(last.line, 0, prevHalf);
      return { line: use, name: `phrase ${last.index + 1} tail`, depth: last.depth + 1 };
    }
    const theme = piece.theme(source) ?? piece.mainTheme;
    return { line: theme.line, name: theme.id, depth: 0 };
  };

  const m1 = material(dir.seg1.source === 'first_half' ? 'A' : dir.seg1.source, []);
  let seg1 = applyOps(m1.line, dir.seg1.ops, ctx);
  if (lineLength(seg1) > whole) {
    seg1 = truncate(seg1, whole, piece.grid);
    truncated = true;
  }
  // A six-bar phrase says its first idea twice before the answer.
  const twice = bars === 6 && lineLength(seg1) <= unit / 2 && pitched(seg1).length > 0;
  if (twice) seg1 = [...padTo(seg1, unit / 2), ...seg1];
  const len1 = lineLength(seg1);
  const start2 = Math.max(unit, Math.ceil(len1 - 1e-6));
  const room = q(whole - start2);

  const m2 = material(dir.seg2.source, seg1);
  let seg2 = applyOps(m2.line, dir.seg2.ops, ctx);
  let seg2Used = room >= 1 && pitched(seg2).length > 0;
  if (seg2Used && lineLength(seg2) > room) {
    seg2 = truncate(seg2, room, piece.grid);
    truncated = true;
    seg2Used = pitched(seg2).length > 0;
  }

  let line = padTo(seg1, start2);
  if (seg2Used) line = [...line, ...seg2];
  line = mergeRests(padTo(line, whole));
  // A five-bar phrase holds its last note through the extra bar.
  if (bars === 5 && line.length >= 2 && line[line.length - 1].deg === null && line[line.length - 2].deg !== null) {
    const rest = line.pop()!;
    line[line.length - 1] = { ...line[line.length - 1], dur: q(line[line.length - 1].dur + rest.dur) };
  }

  const part = (name: string, ops: string[]) => `${name} ${describeOps(ops)}`.replace(' intact', ops.length ? '' : ' intact');
  let lineage = part(m1.name, dir.seg1.ops) + (twice ? ', said twice' : '');
  if (seg2Used) lineage += ` + ${part(m2.name === 'first half' ? 'the same again' : m2.name, dir.seg2.ops)}`;
  const texture = TEXTURE_OPS.filter((x) => dir.flags[x.id]).map((x) => x.phrase);
  if (texture.length) lineage += `; ${texture.join(', ')}`;
  if (bars !== 4) lineage += `; ${bars} bars${bars === 5 ? ', the close held' : ''}`;

  const intact = (dir.seg1.source === 'A' || dir.seg1.source === 'first_half') && dir.seg1.ops.length === 0;
  const depth = Math.max(m1.depth + dir.seg1.ops.length, seg2Used ? (m2.name === 'first half' ? m1.depth + dir.seg1.ops.length : m2.depth) + dir.seg2.ops.length : 0);
  return { line, lineage, depth, intact, truncated };
}

/** Where the chords change. */
export function slotLayout(piece: Piece, harmonicRhythm: string, index: number): { t: number; dur: number; group: string }[] {
  const bar = piece.rules.meter.beatsPerBar;
  const bars = piece.barsOf(index);
  if (harmonicRhythm === 'two_bars' && bars >= 2) {
    const out: { t: number; dur: number; group: string }[] = [];
    for (let b = 0; b < bars; b += 2) out.push({ t: b * bar, dur: Math.min(2, bars - b) * bar, group: String(out.length + 1) });
    return out;
  }
  if (harmonicRhythm === 'half_bar') return Array.from({ length: bars * 2 }, (_x, i) => ({ t: q((i * bar) / 2), dur: q(bar / 2), group: String(i + 1) }));
  if (harmonicRhythm === 'oscillation' && bars >= 3) return Array.from({ length: bars }, (_x, i) => ({ t: i * bar, dur: bar, group: i === bars - 1 ? 'end' : i % 2 === 0 ? 'a' : 'b' }));
  return Array.from({ length: bars }, (_x, i) => ({ t: i * bar, dur: bar, group: String(i + 1) }));
}

function melodyOver(line: Line, key: Key, from: number, to: number): { midi: number; weight: number }[] {
  const out: { midi: number; weight: number }[] = [];
  let t = 0;
  for (const n of line) {
    const overlap = Math.min(t + n.dur, to) - Math.max(t, from);
    if (n.deg !== null && overlap > 1e-6) out.push({ midi: degreeToMidi(key, n.deg, n.alt ?? 0), weight: overlap / (to - from) });
    t += n.dur;
  }
  return out;
}

// ───────────────────────────── Chord path ─────────────────────────────

function endingAllowed(chord: Chord, ending: string): boolean {
  if (ending === 'resolved') return chord.root === 0 && chord.family !== 'suspended' && chord.family !== 'late_romantic';
  if (ending === 'half_resolved') return chord.root === 7 && chord.family !== 'chromatic_mediant';
  // suspended: anything that floats or avoids the tonic.
  return chord.family === 'suspended' || [5, 8, 9, 2].includes(chord.root);
}

function modulationChords(key: Key, next: Key, how: string): Chord[] | null {
  const rel = mod(next.tonic - key.tonic, 12);
  const mk = (id: string, root: number, intervals: number[], roman: string, effect: string, fn: Chord['fn'] = 'dominant'): Chord =>
    ({ id, root: mod(root, 12), intervals, family: 'borrowed', fn, roman, effect });
  if (how === 'pivot') {
    return [
      mk('pivot_V', rel + 7, [0, 4, 7], 'V of new key', 'the dominant of the new key: prepares the change firmly'),
      mk('pivot_V7', rel + 7, [0, 4, 7, 10], 'V7 of new key', 'the dominant seventh of the new key: leans hard into the change'),
    ];
  }
  if (how === 'common_tone') {
    return [
      mk('ct_sus4', rel, [0, 5, 7], 'new I sus4', 'the new tonic, suspended: melts into the new key', 'tonic'),
      mk('ct_sus2', rel, [0, 2, 7], 'new I sus2', 'the new tonic, open and unresolved: drifts into the new key', 'tonic'),
      mk('ct_Vsus', rel + 7, [0, 5, 7], 'new V sus4', 'the new dominant, suspended: hovers before the change'),
    ];
  }
  return null;
}

async function chordPath(ctx: Ctx, index: number, draft: Draft, label: string): Promise<void> {
  const { piece, gw } = ctx;
  const { direction: dir, key, line } = draft;
  const role = piece.roleOf(index);
  const t = piece.tensionOf(index);
  const lang = piece.rules.harmonicLanguage;
  const section = piece.sectionOf(index);
  const dark = section.key.tonic !== piece.rules.key.tonic && piece.rules.keyPlan === 'distant_dark_turn';
  const layout = slotLayout(piece, dir.harmonicRhythm, index);
  const groups = [...new Set(layout.map((s) => s.group))];
  const lastGroup = layout[layout.length - 1].group;
  const candidates = chordCandidates(key);
  const nextKey = index + 1 < piece.plan.totalPhrases ? piece.sectionOf(index + 1).key : section.key;
  const modChords = dir.modulation ? modulationChords(key, nextKey, dir.modulation) : null;

  // Reharmonise means new chords under a known melody: drop the chord that sat here last time.
  let previousUse: string[] = [];
  if (dir.flags.reharmonise) {
    const ref = [...piece.phrases].reverse().find((ph) => ph.direction.seg1.source === dir.seg1.source && ph.direction.seg1.ops.join() === dir.seg1.ops.join());
    if (ref && ref.slots.length === layout.length) previousUse = ref.slots.map((s) => s.chord.id);
  }

  const famPrior = (c: Chord): number => {
    const four = c.intervals.length >= 4;
    switch (c.family) {
      case 'diatonic': return (lang === 'triads' ? 1 : lang === 'sevenths' ? 0.2 : lang === 'extended' ? -0.3 : 0) - (c.intervals[2] === 6 ? 1.2 : 0);
      case 'diatonic_extended': return (lang === 'extended' ? 1.1 + (c.intervals.includes(14) ? 0.3 : 0) : lang === 'sevenths' ? (four ? 0.9 : 0.4) : lang === 'triads' ? -0.6 : 0.3) - (c.intervals[2] === 6 ? 1 : 0);
      case 'suspended': return lang === 'suspended' ? 1.2 : 0;
      case 'borrowed': return -1.3 + t * 0.16 + (lang === 'chromatic' ? 1.2 : 0) + (dark ? 0.6 : 0);
      case 'chromatic_mediant': return -1.5 + (lang === 'chromatic' ? 1.2 : 0) + (dark ? 1 : 0) + (t >= 6 ? 0.5 : 0);
      default: return -1.7 + (lang === 'chromatic' ? 1.3 : 0) + (dark ? 1.4 : 0);
    }
  };

  // Mode mixture: the chord before the last is borrowed from the parallel mode.
  const mixGroup = dir.flags.mode_mixture && groups.length >= 2 ? groups[groups.length - 2] : null;
  const wallNext = index === piece.plan.climaxPhrase - 1 && arrivesAfterBreath(piece.plan.climaxArrival);
  const climaxHere = index === piece.plan.climaxPhrase;

  const questions: Question[] = [];
  for (const g of groups) {
    const slots = layout.filter((s) => s.group === g);
    const first = layout.indexOf(slots[0]);
    const pos = layout.length === 1 ? 0 : first / (layout.length - 1);
    const isLast = g === lastGroup;
    const notes = slots.flatMap((s) => melodyOver(line, key, s.t, s.t + s.dur).map((n) => ({ ...n, weight: n.weight / slots.length })));
    let pool = candidates;
    if (isLast) {
      pool = modChords ?? candidates.filter((c) => endingAllowed(c, dir.ending));
      if (!pool.length) pool = candidates;
    }
    if (g === mixGroup && !isLast) {
      const borrowed = candidates.filter((c) => c.family === 'borrowed');
      if (borrowed.length >= 2) pool = borrowed;
    }
    const excluded = previousUse[first];
    if (excluded && pool.length > 3) pool = pool.filter((c) => c.id !== excluded);

    const options = pool.map((c) => {
      let fits = 0;
      let colours = 0;
      let bad = 0;
      let s = famPrior(c);
      for (const n of notes) {
        const f = fitOf(n.midi, c, key);
        if (f === 'chord_tone') { fits++; s += 0.9 * n.weight * 2; }
        else if (f === 'colour') { colours++; s += 0.1 * n.weight; }
        else { bad++; s -= 1.8 * n.weight * 2; }
      }
      if (!isLast) {
        const home = c.family === 'diatonic' || c.family === 'diatonic_extended' || c.family === 'suspended';
        if (pos === 0) s += c.fn === 'tonic' && home ? (c.root === 0 ? (role === 'statement' || role === 'return' ? 2 : 1.1) : 0.6) : 0;
        else if (first === layout.length - 2) s += c.fn === 'dominant' ? 0.8 : c.fn === 'predominant' ? 0.5 : 0;
        else s += c.fn === 'predominant' ? 0.6 : c.fn === 'tonic' && c.root !== 0 ? 0.5 : c.fn === 'colour' ? 0.2 : 0;
        if (dir.harmonicRhythm === 'oscillation') s += g === 'a' ? (c.fn === 'tonic' ? 0.6 : 0) : c.fn === 'predominant' || (c.fn === 'tonic' && c.root !== 0) ? 0.7 : 0;
      } else if (c.root === 0 && c.family === 'diatonic_extended' && lang !== 'triads') s += 0.3;
      const melodyText = notes.length
        ? `Melody here: ${[...new Set(notes.map((n) => midiName(n.midi, key)))].join(' ')} → ${fits} chord tone${fits === 1 ? '' : 's'}, ${colours} colour, ${bad} clash${bad === 1 ? '' : 'es'}.`
        : 'No melody notes here.';
      return opt(c.id, `${chordName(c, key)} (${c.roman})`, `${chordName(c, key)}, ${c.roman}: ${c.effect}. Function: ${c.fn}. ${melodyText}`, s);
    });
    const where = dir.harmonicRhythm === 'oscillation' && !isLast
      ? `the ${g === 'a' ? 'first' : 'second'} chord of the alternating pair`
      : `chord ${first + 1} of ${layout.length}${isLast ? ' (the last: it carries the phrase ending)' : ''}`;
    questions.push({
      id: `chord_${g}`, type: 'choice', label: `Chord ${g}`,
      instructions: `Choose ${where}, starting at beat ${slots[0].t + 1}.${isLast && !modChords ? ` The phrase ending was chosen as ${dir.ending.replace('_', '-')}.` : ''}${g === mixGroup && !isLast ? ' Mode mixture was chosen for this phrase: this is the chord borrowed from the parallel mode.' : ''}${isLast && wallNext ? ' The climax arrives straight after this chord, following a held breath.' : ''}${first === 0 && climaxHere ? ' This is the chord the climax arrives on.' : ''}`,
      options,
    });
    questions.push({
      id: `bass_${g}`, type: 'choice', label: `Bass ${g}`,
      instructions: `What should the bass do under ${where}?`,
      options: [
        opt('root', 'root', 'root: the chord\'s root, plain and firm', 1.3),
        opt('inversion', 'inversion', 'inversion: the third in the bass; lighter, smoother, less final', isLast && dir.ending === 'resolved' ? -1 : 0.3),
        opt('pedal', 'pedal', 'pedal: the bass stays on the tonic while the harmony moves over it; suspended, grave', (dir.flags.pedal_underlay ? 1.6 : 0.2) + (dir.harmonicRhythm === 'oscillation' ? 0.7 : 0) - (isLast && dir.ending === 'half_resolved' ? 1 : 0)),
        opt('walk', 'stepwise walk', 'stepwise walk: the root, then steps leading toward the next chord; motion', -0.2 + t * 0.14),
        opt('octave_drop', 'octave drop', 'octave drop: the root, then the octave below; weight, a deepening', -0.4 + (t >= 5 ? 0.7 : 0) + (piece.rules.style === 'beat_driven' ? 0.5 : 0)),
      ],
    });
  }

  const ans = await gw.ask({
    callType: 'chord_path', title: `Phrase ${index + 1} ${label}: chord path`,
    state: piece.state('chord_path', index, [
      `DRAFT   ${notation(line)}   = ${draft.lineage}`,
      `HARMONY ${HARMONIC_RHYTHM[dir.harmonicRhythm]}; ending ${dir.ending.replace('_', '-')}${mixGroup ? '; mode mixture: one chord is borrowed from the parallel mode' : ''}${dir.modulation ? `; modulation to ${keyName(nextKey)} by ${dir.modulation.replace('_', ' ')}` : ''}${piece.lastChord ? `; the previous phrase ended on ${chordName(piece.lastChord, piece.phrases[piece.phrases.length - 1].key)}` : ''}`,
    ]),
    questions, picking: 'sampled', draws: 1,
  });
  const p = ans.picks[0];
  const all = [...candidates, ...(modChords ?? [])];
  draft.slots = layout.map((s) => ({
    t: s.t, dur: s.dur,
    chord: all.find((c) => c.id === p[`chord_${s.group}`]) ?? tonicChord(key),
    bass: p[`bass_${s.group}`],
    voices: [],
  }));
}

// ───────────────────────────── Voice leading ─────────────────────────────

function chordTonesNear(chord: Chord, key: Key, lo: number, hi: number): number[] {
  const pcs = chordPcs(chord, key);
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(mod(m, 12))) out.push(m);
  return out;
}

/** First voicing of the piece: three chord tones in close position around middle C. */
export function initialVoicing(chord: Chord, key: Key): number[] {
  const tones = chordTonesNear(chord, key, 52, 72);
  const targets = [55, 60, 64];
  const out: number[] = [];
  for (const target of targets) {
    const free = tones.filter((x) => !out.includes(x));
    out.push(free.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] ?? target);
  }
  return out.sort((a, b) => a - b);
}

function voiceOptions(pitch: number, chord: Chord, key: Key, susLanguage: boolean): { key: string; label: string; target: number; criteria: string; prior: number }[] {
  const scale = MODES[key.mode].map((s) => mod(key.tonic + s, 12));
  const tones = chordTonesNear(chord, key, pitch - 12, pitch + 12);
  const nameAt = (m: number) => chordToneName(m, chord, key);
  const describe = (m: number) => {
    const tone = nameAt(m);
    return tone ? `${midiName(m, key)}, the chord's ${tone}` : `${midiName(m, key)}, not a chord tone (a ${intervalName(mod(m - key.tonic - chord.root, 12))} above the root: an added colour or suspension)`;
  };
  const range = (m: number) => (m < 48 || m > 77 ? -1.5 : 0);
  const stepTo = (dir: 1 | -1) => {
    const tone = tones.filter((x) => (x - pitch) * dir > 0 && Math.abs(x - pitch) <= 2).sort((a, b) => Math.abs(a - pitch) - Math.abs(b - pitch))[0];
    if (tone !== undefined) return tone;
    for (let d = 1; d <= 2; d++) if (scale.includes(mod(pitch + d * dir, 12))) return pitch + d * dir;
    return pitch + dir;
  };
  const up = stepTo(1);
  const down = stepTo(-1);
  const far = tones.filter((x) => Math.abs(x - pitch) >= 3).sort((a, b) => Math.abs(a - pitch) - Math.abs(b - pitch) || Math.abs(a - 62) - Math.abs(b - 62))[0] ?? pitch + 7;
  const holdIn = !!nameAt(pitch);
  return [
    { key: 'hold', label: 'hold', target: pitch, criteria: `Hold: stays on ${describe(pitch)}. A common tone binds the two chords.`, prior: (holdIn ? 1.7 : susLanguage ? -0.2 : -0.9) + range(pitch) },
    { key: 'step_up', label: 'step up', target: up, criteria: `Step up to ${describe(up)}.`, prior: (nameAt(up) ? 1.1 : -1) + range(up) + (pitch < 52 ? 0.5 : 0) },
    { key: 'step_down', label: 'step down', target: down, criteria: `Step down to ${describe(down)}.`, prior: (nameAt(down) ? 1.2 : -1) + range(down) + (pitch > 74 ? 0.5 : 0) },
    { key: 'leap', label: 'leap', target: far, criteria: `Leap ${far > pitch ? 'up' : 'down'} a ${intervalName(far - pitch)} to ${describe(far)}.`, prior: -0.3 - 0.15 * (Math.abs(far - pitch) - 3) + range(far) + (holdIn ? 0 : 0.5) },
  ];
}

async function voiceLead(ctx: Ctx, index: number, draft: Draft, label: string): Promise<{ leaps: number; nonChord: number; motion: number }> {
  const { piece, gw } = ctx;
  const key = draft.key;
  const sus = piece.rules.harmonicLanguage === 'suspended';
  let voices = piece.voices.length ? piece.voices.slice() : [];
  // Chord ids are relative to a key: after a key change the previous chord is simply "the previous chord".
  const lastPhrase = piece.phrases[piece.phrases.length - 1];
  const sameKey = !!lastPhrase && lastPhrase.key.tonic === key.tonic && lastPhrase.key.mode === key.mode;
  let prevChord: Chord | null = sameKey ? piece.lastChord : null;
  const stats = { leaps: 0, nonChord: 0, motion: 0 };

  for (let k = 0; k < draft.slots.length; k++) {
    const slot = draft.slots[k];
    if (!voices.length) {
      voices = initialVoicing(slot.chord, key);
    } else if (!prevChord || prevChord.id !== slot.chord.id || prevChord.root !== slot.chord.root || prevChord.intervals.join() !== slot.chord.intervals.join()) {
      const perVoice = voices.map((v) => voiceOptions(v, slot.chord, key, sus));
      const names = ['low', 'middle', 'high'];
      const questions: Question[] = perVoice.map((options, v) => ({
        id: `voice_${v + 1}`, type: 'choice', label: `${names[v]} voice`,
        instructions: `The ${names[v]} inner voice is on ${midiName(voices[v], key)}. How should it move into the new chord?`,
        options: options.map((o) => opt(o.key, o.label, o.criteria, o.prior)),
      }));
      const ans = await gw.ask({
        callType: 'voice_leading', title: `Phrase ${index + 1} ${label}: voices into chord ${k + 1}`,
        state: piece.state('voice_leading', index, [
          `DRAFT   ${notation(draft.line)}`,
          `CHANGE  ${prevChord ? chordName(prevChord, key) : 'previous chord'} → ${chordName(slot.chord, key)} (${slot.chord.roman}); bass plays the ${slot.bass.replace('_', ' ')}; inner voices now ${voices.map((v) => midiName(v, key)).join(' ')}`,
        ]),
        questions, picking: 'sampled', draws: 1,
      });
      voices = voices.map((v, i) => {
        const chosen = perVoice[i].find((o) => o.key === ans.picks[0][`voice_${i + 1}`])!;
        if (chosen.key === 'leap') stats.leaps++;
        if (!chordToneName(chosen.target, slot.chord, key)) stats.nonChord++;
        stats.motion += Math.abs(chosen.target - v);
        return chosen.target;
      });
    }
    slot.voices = voices.slice();
    prevChord = slot.chord;
  }
  return stats;
}

// ───────────────────────────── One round: drafts, facts, judge ─────────────────────────────

const REASONS: Record<string, string> = {
  drift: 'Drift: the phrase is no longer related to the theme.',
  copy: 'Copy: too close to one of the last four phrases.',
  weak_contrast: 'Weak contrast: a departure must leave the theme, and this stays too near it.',
  stale_return: 'Stale return: the theme comes back intact without new harmony or instruments.',
  clash: 'Clash: melody notes grind against the chords under them.',
  aimless: 'Aimless: the phrase does not serve its role or its place on the tension curve.',
};

export interface RoundResult {
  accepted: Draft | null;
  round: number;
}

export async function draftRound(ctx: Ctx, index: number, round: number): Promise<Draft | null> {
  const { piece, gw } = ctx;
  const role = piece.roleOf(index);
  const section = piece.sectionOf(index);

  // 2. Drex answers the direction questions; code samples the drafts and realises each in notes.
  const dirAns = await gw.ask({
    callType: 'phrase_direction', title: `Phrase ${index + 1} direction${round > 1 ? ` (round ${round})` : ''}`,
    state: piece.state('phrase_direction', index),
    questions: directionQuestions(ctx, index), picking: 'sampled', draws: PHRASE_DRAFTS,
  });
  // The phrase length is one decision for all drafts: Drex's most probable answer.
  const lengths = dirAns.probabilities.phrase_length;
  if (lengths) piece.phraseBars.set(index, Number(Object.entries(lengths).sort((a, b) => b[1] - a[1])[0][0]));
  const letters = 'abcdefgh';
  const fixed = planFixed(piece, index);
  const drafts: Draft[] = dirAns.picks.map((p, i) => {
    const direction = directionFrom({ ...p, ...fixed });
    // Mode mixture borrows one chord (see chordPath); the phrase itself stays in the section's key.
    const key: Key = section.key;
    const built = buildLine(piece, direction, index);
    return {
      id: `draft_${letters[i]}`, direction, key, line: built.line, lineage: built.lineage, depth: built.depth, intact: built.intact,
      related: 0, slots: [], facts: built.truncated ? [{ label: 'fit', value: 'material ran past the phrase and was cut short' }] : [], quality: 0, failure: '',
    };
  });

  // 3. Chord path, then voice leading, per draft.
  const vl = await Promise.all(
    drafts.map(async (d) => {
      await chordPath(ctx, index, d, d.id.replace('_', ' '));
      // "Resolved" was Drex's choice for the ending: the melody lands on a tone of the final chord.
      if (d.direction.ending === 'resolved') snapEnding(d);
      return voiceLead(ctx, index, d, d.id.replace('_', ' '));
    }),
  );

  return judgeDrafts(ctx, index, round, drafts, vl);
}

export interface VoiceStats { leaps: number; nonChord: number; motion: number }

/** Steps 4 to 6 of the phrase loop: measure facts, ask the judge, record the verdict. */
export async function judgeDrafts(ctx: Ctx, index: number, round: number, drafts: Draft[], vl: VoiceStats[]): Promise<Draft | null> {
  const { piece, gw } = ctx;
  const role = piece.roleOf(index);

  // 4. Code measures facts about each draft.
  const main = piece.mainTheme;
  const contrast = piece.theme('C');
  const lastFour = piece.phrases.slice(-4);
  const firstStatement = piece.phrases.find((ph) => ph.themeIntact);
  drafts.forEach((d, i) => {
    // In a departure each half is measured on its own: two statements of a contrasting idea must not
    // count as "near the theme" just because the join between them happens to trace the theme's shape.
    const half = piece.segStart(index);
    const halves = [sliceLine(d.line, 0, half), sliceLine(d.line, half, piece.beatsOf(index))].filter((h) => pitched(h).length >= 2);
    const kept = role === 'departure' && halves.length
      ? halves.map((h) => shareKept(main.line, h)).sort((a, b) => b.overall - a.overall)[0]
      : shareKept(main.line, d.line);
    const keptC = contrast ? shareKept(contrast.line, d.line) : null;
    const chordIds = d.slots.map((s) => s.chord.id);
    const sims = lastFour.map((ph) => ({ n: ph.index + 1, sim: similarity(d.line, ph.line, chordIds, ph.slots.map((s) => s.chord.id)) }));
    const maxSim = sims.length ? Math.max(...sims.map((s) => s.sim)) : 0;
    // Beyond the last four: the closest phrase anywhere earlier, so nothing comes back note for note by accident.
    const earlier = piece.phrases.slice(0, -4).map((ph) => ({ n: ph.index + 1, sim: similarity(d.line, ph.line, chordIds, ph.slots.map((s) => s.chord.id)) }));
    const closest = earlier.sort((x, y) => y.sim - x.sim)[0];
    const bad = clashes(d.line, d.slots, d.key);
    const newHarmony = firstStatement
      ? d.slots.length !== firstStatement.slots.length || d.slots.filter((s, k) => s.chord.id !== firstStatement.slots[k].chord.id).length >= Math.ceil(d.slots.length / 2)
      : true;
    d.related = kept.overall;
    d.facts.push(
      { label: 'derivation', value: d.lineage },
      { label: `kept from theme ${main.id}`, value: `contour ${pct(kept.contour)}, intervals ${pct(kept.intervals)}, rhythm ${pct(kept.rhythm)}` },
      ...(keptC && role === 'departure' ? [{ label: 'kept from theme C', value: `contour ${pct(keptC.contour)}, intervals ${pct(keptC.intervals)}, rhythm ${pct(keptC.rhythm)}` }] : []),
      { label: 'similarity to last four', value: sims.length ? sims.map((s) => `phrase ${s.n}: ${pct(s.sim)}`).join(', ') : 'no earlier phrases' },
      ...(closest && closest.sim > 0.6 ? [{ label: 'closest earlier phrase', value: `phrase ${closest.n}: ${pct(closest.sim)}` }] : []),
      { label: 'theme last heard intact', value: piece.phrases.length ? `${piece.phrasesSinceThemeIntact()} phrases ago` : 'not yet' },
      { label: 'clashing notes', value: bad.length ? bad.slice(0, 4).map((c) => `${c.note} over ${c.chord} at beat ${c.beat + 1}`).join('; ') : 'none' },
      { label: 'chords', value: d.slots.map((s) => chordName(s.chord, d.key)).join(' | ') },
      { label: 'inner voices', value: `${vl[i].motion} semitones of motion, ${vl[i].leaps} leap${vl[i].leaps === 1 ? '' : 's'}, ${vl[i].nonChord} non-chord tone${vl[i].nonChord === 1 ? '' : 's'}` },
      ...(d.intact && firstStatement ? [{ label: 'theme returns intact', value: `${newHarmony ? 'with new harmony' : 'over the same harmony as its first statement'}${d.direction.flags.handoff ? ', on a new instrument' : ''}` }] : []),
    );

    // Stand-in quality from the same facts.
    const chainRelated = d.depth <= 2 && ['A', 'B'].includes(d.direction.seg1.source);
    let s = 0;
    let failure = '';
    if (role === 'departure') {
      if (kept.overall > 0.62) { s -= 2; failure = 'weak_contrast'; } else s += 1.6;
    } else if (role === 'statement') {
      s += 2.2 * kept.overall;
      if (!d.intact) { s -= 1; failure = 'aimless'; }
    } else if (role === 'return') {
      if (!d.intact) { s -= 1.2; failure = 'aimless'; } else s += 1.5;
      if (d.intact && !newHarmony && !d.direction.flags.handoff && !piece.chorusAt(index)) { s -= 2.2; failure = 'stale_return'; } else if (d.intact) s += 0.7;
    } else {
      const rel = Math.max(kept.overall, chainRelated ? 0.42 : 0);
      if (rel < DRIFT_LEVEL) { s -= 2; failure = 'drift'; } else s += 1 + (kept.overall > 0.35 && kept.overall < 0.92 ? 0.7 : 0);
    }
    const plannedReturn = (index === piece.plan.climaxPhrase && piece.plan.climaxTheme !== 'continues') || piece.rules.style === 'beat_driven';
    if (lastFour.length && maxSim > COPY_LEVEL && role !== 'return' && !plannedReturn) { s -= 2.6; failure = 'copy'; } else s += (1 - maxSim) * 0.8;
    if (closest && closest.sim > COPY_LEVEL && !(role === 'return' && d.intact) && !plannedReturn) { s -= 2.6; failure = 'copy'; }
    if (bad.length >= 3) failure = failure || 'clash';
    s -= 0.4 * Math.min(4, bad.length);
    s -= 0.12 * vl[i].leaps + 0.15 * vl[i].nonChord;
    d.quality = s;
    d.failure = failure;
  });

  // Draft order is shuffled before judging.
  const order = shuffled(drafts, ctx.rng);
  const best = Math.max(...order.map((d) => d.quality));
  const failures = order.map((d) => d.failure).filter(Boolean);
  const mainFailure = failures.sort((a, b) => failures.filter((x) => x === b).length - failures.filter((x) => x === a).length)[0] ?? 'aimless';

  const themeBack = index === piece.plan.climaxPhrase && piece.plan.climaxTheme !== 'continues';
  const loops = piece.rules.style === 'beat_driven';
  const roleRule: Record<PhraseRole, string> = {
    statement: 'This phrase states the theme: it should be plainly recognisable.',
    development: loops
      ? 'This is a development phrase in a loop-based style. It must stay related to the theme; an exact repeat of an earlier phrase is right here, because the change comes from the drums, bass, layers and filter around it. Reject drift (no longer related).'
      : 'This is a development phrase: it must be related to the theme AND new. Reject drift (no longer related) and copies (too close to any of the last four phrases).',
    departure: 'This is a planned departure: the test flips. The phrase must CONTRAST with the main theme while fitting the key and mood.',
    return: piece.chorusAt(index)
      ? 'This phrase is the chorus: the hook must be whole and plainly recognisable. Hearing it again is the point; prefer the draft whose chords and second half serve the hook best.'
      : 'The theme returns here. A theme that comes back intact must have new harmony or new instruments.',
    climax: themeBack
      ? `This is the climax, and the plan brings the main theme back here ${piece.plan.climaxTheme === 'broadened' ? 'at half speed' : 'whole'}: hearing the theme again at full intensity is the point of the moment, not a copy.`
      : 'This is the climax: related to the theme, at its most intense, and not a copy of the last four phrases.',
    coda: 'This is the coda: related to the theme, winding down, not a copy of the last four phrases.',
  };
  const verdictQ: Question = {
    id: 'verdict', type: 'choice', label: `Phrase ${index + 1}: best draft`,
    instructions: `${roleRule[role]} Which draft should be played? Choose "none" to reject all of them and redraft.`,
    options: [
      ...order.map((d) => opt(d.id, d.id.replace('_', ' '), `${notation(d.line)} | ${d.facts.map((f) => `${f.label}: ${f.value}`).join('; ')}`, d.quality * 1.5)),
      opt('none', 'none', 'Reject all drafts and redraft.', (best < 1 ? 2.2 : 0.4) * 1.5),
    ],
  };
  const whyQ: Question = {
    id: 'reject_reason', type: 'choice', label: 'If none: why',
    instructions: 'If every draft is rejected, what is the main reason? It is fed into the next round of drafting.',
    options: Object.entries(REASONS).map(([k, text]) => opt(k, k.replace('_', ' '), text, k === mainFailure ? 2 : 0)),
  };
  const strongQ: Question = {
    id: 'strength', type: 'choice', label: 'If accepted: why',
    instructions: 'If a draft is accepted, what is its main strength?',
    options: [
      opt('related_and_new', 'related and new', 'It is clearly from the theme and clearly new.', role === 'development' ? 1.5 : 0.5),
      opt('serves_role', 'serves its role', 'It does exactly what its role in the plan asks.', role === 'development' ? 0.6 : 1.6),
      opt('harmony', 'harmony', 'Its chords give the melody new meaning.', 0.4),
      opt('momentum', 'momentum', 'It carries the tension curve where it needs to go.', 0.5),
    ],
  };
  // 5. The judge sees the theme, the last four phrases, the drafts and the facts.
  const judge = await gw.ask({
    callType: 'phrase_judge', title: `Phrase ${index + 1} judge${round > 1 ? ` (round ${round})` : ''}`,
    state: piece.state('phrase_judge', index, ['DRAFTS  ' + order.map((d) => `${d.id}: ${notation(d.line)}   = ${d.lineage}`).join('\n        ')]),
    questions: [verdictQ, whyQ, strongQ], picking: 'top',
  });
  const picked = judge.picks[0].verdict;
  const accepted = picked === 'none' ? null : order.find((d) => d.id === picked)!;
  const reason = accepted
    ? strongQ.options.find((o) => o.key === judge.picks[0].strength)!.criteria
    : REASONS[judge.picks[0].reject_reason];
  const verdict: VerdictView = { picked: accepted ? accepted.id : null, reason, probabilities: judge.probabilities.verdict };
  const views: DraftView[] = order.map((d) => ({
    id: d.id, notation: notation(d.line), lineage: d.lineage, chords: d.slots.map((s) => chordName(s.chord, d.key)),
    notes: timed(d.line, d.key), facts: d.facts,
  }));
  ctx.emit({ type: 'phrase_drafts', phrase: index, round, drafts: views, verdict });

  // 6. On rejection, the reason goes into the state and the loop returns to step 2.
  piece.lastReject = accepted ? '' : reason;
  return accepted;
}

/** Move the last melody note onto the nearest tone of the final chord. */
function snapEnding(draft: Draft) {
  const final = draft.slots[draft.slots.length - 1];
  const lastNote = [...draft.line].reverse().find((n) => n.deg !== null);
  if (!final || !lastNote || lastNote.deg === null) return;
  const pcs = chordPcs(final.chord, draft.key);
  for (const delta of [0, -1, 1, -2, 2]) {
    if (pcs.includes(mod(degreeToMidi(draft.key, lastNote.deg + delta), 12))) {
      lastNote.deg += delta;
      lastNote.alt = 0;
      return;
    }
  }
}

export { sigmoid };
