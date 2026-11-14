// Orchestration and mix: one call per accepted phrase. Drex decides which layers play, on what,
// in which register, how loud, in what style, and every effect amount. Code then writes the notes.

import type {
  Articulation, HoldNote, InstrumentId, LayerRole, LayerSummary, MixState, NoteEvent, PhraseScore, Step7,
} from '../../shared/types.ts';
import { DYNAMIC_NAMES } from '../../shared/types.ts';
import { AMOUNT_LEVELS, DYNAMIC_LEVELS, sigmoid, type Ctx } from '../context.ts';
import { lineLength, notation, pitched, q, timed, truncate, type Line } from '../core/line.ts';
import { clamp, mod } from '../core/rng.ts';
import { chordName, chordPcs, degreeToMidi, fitOf, keyName, midiName, MODES, type Key } from '../core/theory.ts';
import { applyOps } from '../core/transform.ts';
import type { ChoiceOption, Picks, Question } from '../gateway/gateway.ts';
import { ARRIVAL_LABEL, arrivesAfterBreath, GROOVES, INSTRUMENTS, isWall, ROLE_INSTRUMENTS, type PhraseRecord, type Piece, type Slot } from '../piece.ts';
import { linger } from './ending.ts';
import type { Draft } from './phrase.ts';

const opt = (key: string, label: string, criteria: string, prior = 0): ChoiceOption => ({ key, label, criteria, prior });

const LAYERS: LayerRole[] = ['melody', 'counter', 'inner', 'bass', 'pedal', 'figuration', 'texture', 'pulse', 'accents'];
const LAYER_JOB: Record<LayerRole, string> = {
  melody: 'the melody line',
  counter: 'the counter-melody',
  inner: 'inner harmony (the voice-led chord tones)',
  bass: 'the bass line',
  pedal: 'a pedal: one held note under the changing harmony',
  figuration: 'figuration: arpeggios or plucked patterns on the chords',
  texture: 'texture: noise, tremolo or a swell behind everything',
  pulse: 'pulse: drums or a kick marking time',
  accents: 'accents: hits and swells at chosen moments',
};

/** Comfortable centre of each instrument when it carries a line. */
const CENTRE: Partial<Record<InstrumentId, number>> = {
  piano: 72, violins: 76, violins2: 67, solo_violin: 76, flute: 79, oboe: 72, clarinet: 65, pluck: 72, celesta: 84,
  glockenspiel: 88, vibraphone: 67, celli: 55, violas: 62, horn: 55, harp: 67,
  lead: 74, keys: 67, bell: 84, brass: 65, supersaw: 64,
};

const velOf = (step: number) => clamp(0.2 + step * 0.118, 0.12, 0.95);

function fold(midi: number, inst: InstrumentId): number {
  const [lo, hi] = INSTRUMENTS[inst].range;
  let m = midi;
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

function pcIn(pc: number, lo: number): number {
  return lo + mod(pc - lo, 12);
}

// ───────────────────────────── Facts for Drex ─────────────────────────────

/** Where the melody has been: the note the last phrase ended on, and the highest note heard so far. */
function melodyFacts(piece: Piece): { lastEnd: number | null; top: { midi: number; phrase: number } | null } {
  let top: { midi: number; phrase: number } | null = null;
  for (const ph of piece.phrases) {
    for (const n of ph.score.notes) {
      if (n.layer === 'melody' && (!top || n.midi > top.midi)) top = { midi: n.midi, phrase: ph.index + 1 };
    }
  }
  const last = piece.phrases[piece.phrases.length - 1];
  const tail = last?.score.notes.filter((n) => n.layer === 'melody').sort((a, b) => a.t + a.dur - (b.t + b.dur) || a.midi - b.midi).pop();
  return { lastEnd: tail ? tail.midi : null, top };
}

/** Which instruments have been playing without a break, which are resting, and the fullest phrase so far. */
function playedFacts(piece: Piece): string | null {
  if (!piece.phrases.length) return null;
  const heard = piece.phrases.map((ph) => new Set(ph.score.notes.map((n) => n.inst)));
  const running: string[] = [];
  const resting: string[] = [];
  for (const id of piece.rules.palette) {
    let run = 0;
    for (let i = heard.length - 1; i >= 0 && heard[i].has(id); i--) run++;
    if (run > 0) running.push(`${INSTRUMENTS[id].name} (${run} phrase${run === 1 ? '' : 's'} running)`);
    else {
      let since = -1;
      for (let i = heard.length - 1; i >= 0; i--) if (heard[i].has(id)) { since = heard.length - 1 - i; break; }
      resting.push(`${INSTRUMENTS[id].name} (${since < 0 ? 'not yet heard' : `silent ${since} phrase${since === 1 ? '' : 's'}`})`);
    }
  }
  const sizes = heard.map((h) => h.size);
  const most = Math.max(...sizes);
  return `PLAYED  sounding in the last phrase: ${running.join(', ') || 'nothing'}; resting: ${resting.join(', ') || 'none'}; fullest phrase so far: phrase ${sizes.indexOf(most) + 1} with ${most} instruments`;
}

/** The level the last phrase left off at (its dynamic curve's end, if it had one). */
function lastLevel(piece: Piece): number | null {
  const last = piece.phrases[piece.phrases.length - 1];
  if (!last) return null;
  const curve = last.score.dynCurve;
  return curve?.length ? curve[curve.length - 1].step : last.mix.dynamics;
}

/** Overall dynamics moving inside the phrase, from the shape Drex chose and the level `to` it set. */
function dynamicCurve(shape: string, to: number, from: number | null, beats: number): { beat: number; step: number }[] | undefined {
  const prev = from ?? to;
  if (shape === 'crescendo') {
    const start = clamp(Math.min(prev, to - 1), 0, 6);
    return start < to ? [{ beat: 0, step: start }, { beat: beats, step: to }] : undefined;
  }
  if (shape === 'diminuendo') {
    const start = prev > to ? prev : to;
    const end = prev > to ? to : Math.max(0, to - 1);
    return start > end ? [{ beat: 0, step: start }, { beat: beats, step: end }] : undefined;
  }
  if (shape === 'swell') {
    const low = Math.max(0, to - 1);
    return low < to ? [{ beat: 0, step: low }, { beat: beats / 2, step: to }, { beat: beats, step: low }] : undefined;
  }
  return undefined;
}

/** Song form: the level Drex planned for this phrase's kind of part. The whole last chorus stays at the top. */
function songLevel(piece: Piece, index: number): number | null {
  const part = piece.sectionOf(index).part;
  const level = part ? piece.plan.partLevels?.[part] : undefined;
  if (level === undefined) return null;
  const ch = piece.chorusAt(index);
  return ch && ch.of > 1 && ch.n === ch.of && piece.plan.climaxArrival === 'drop' ? 6 : level;
}

/** Song form: a few words placed inside a question, so the answer knows which part of the song it is for. */
function partHint(piece: Piece, index: number): string {
  const part = piece.sectionOf(index).part;
  if (!part) return '';
  const ch = piece.chorusAt(index);
  if (ch) return ` This phrase is in the chorus (chorus ${ch.n} of ${ch.of}): a peak of the song, which must sound clearly bigger than the verse, not only louder.`;
  if (part === 'verse') return ' This phrase is in a verse: lean and held back, so the chorus has somewhere to go.';
  if (part === 'prechorus') return ' This phrase is in the pre-chorus: building, something still held back for the chorus.';
  if (part === 'bridge') return ' This phrase is in the bridge: the thinnest part of the song, a real drop before the last chorus.';
  return ` This phrase is in the ${part}.`;
}

// ───────────────────────────── Questions ─────────────────────────────

interface LayerChoice {
  role: LayerRole;
  on: boolean;
  inst: InstrumentId | null;
  dyn: Step7;
  entry: LayerSummary['entry'];
  art: Articulation | null;
  detail: string;
}

function buildQuestions(ctx: Ctx, index: number, draft: Draft): { questions: Question[]; offered: Record<LayerRole, InstrumentId[]> } {
  const { piece } = ctx;
  const { rules, mood: m } = piece;
  const role = piece.roleOf(index);
  const t = piece.tensionOf(index);
  const orch = rules.style === 'bittersweet_orchestral';
  const beat = rules.style === 'beat_driven';
  const play = rules.style === 'playful';
  const last = piece.phrases[piece.phrases.length - 1];
  const was = (r: LayerRole) => !!last?.layers.find((l) => l.role === r && l.inst);
  const lastInst = (r: LayerRole) => last?.layers.find((l) => l.role === r)?.inst ?? null;
  const flags = draft.direction.flags;
  // When scoring a video, what the picture does under this phrase steers register, style and accents.
  const cue = piece.picture?.(index) ?? null;
  const moves = (...q: string[]) => !!cue && q.includes(cue.quality);
  const level = (...l: string[]) => !!cue && l.includes(cue.bodyLevel);
  const overall = clamp(Math.round(t - 1 + (role === 'climax' ? 1 : 0) + (role === 'coda' ? -0.5 : 0)), 0, 6);
  const questions: Question[] = [];
  const offered = {} as Record<LayerRole, InstrumentId[]>;
  // How Drex chose the climax to arrive (plan call). A wall fixes this phrase's overall dynamics,
  // filter, pulse and figuration, so those are not asked again here.
  const arrival = piece.plan.climaxArrival;
  const atClimax = index === piece.plan.climaxPhrase;
  const wall = atClimax && isWall(arrival);
  // The drop (beat-driven) is the other fixed arrival: every layer in, full volume, the filter open.
  const drop = atClimax && arrival === 'drop';
  const peak = wall || drop;
  // The clearing: the motion stops and the music opens out, still and bright. Its level is asked relative to what came before.
  const bloom = atClimax && arrival === 'bloom';
  const still = wall || bloom;

  if (bloom) questions.push({
    id: 'bloom_level', type: 'choice', label: 'How much louder the clearing is',
    instructions: `The climax arrives as a still, bright clearing after a held breath. The phrase before it left off at ${DYNAMIC_NAMES[clamp(Math.round(lastLevel(piece) ?? 3), 0, 6)]}. How loud should the clearing be?`,
    options: [
      opt('same', 'no louder', 'no louder than before: the change is all in colour and stillness', 0.5),
      opt('one', 'one step louder', 'one step louder: it opens, gently', 1.2),
      opt('two', 'two steps louder', 'two steps louder: a clear lift, still without force', 0.8),
    ],
  });
  // In a song the level of each kind of part was set in the plan, so it is not asked here.
  const song = songLevel(piece, index);
  const hint = partHint(piece, index);
  if (!peak && !bloom && song === null) questions.push({
    id: 'overall_dynamics', type: 'score', label: 'Overall dynamics',
    instructions: `How loud is this phrase overall? Target tension is ${t} of 7.`,
    levels: DYNAMIC_LEVELS, prior: overall, spread: 0.6,
  });
  // One decision for how full the phrase is. Asked layer by layer, each yes/no sat near even and the
  // cut-off thinned the texture at random; asked once, Drex's answer follows the tension curve (measured live).
  if (!drop) questions.push({
    id: 'density', type: 'score', label: 'How full the texture is',
    instructions: `How full should the texture of this phrase be: how many supporting layers (counter-melody, inner harmony, bass, pedal, figuration, texture, pulse) play under the melody? ${bloom ? 'This is the climax, arriving as a still, bright clearing: nothing moves but the melody, so fullness here means held notes, not activity.' : `Target tension is ${t} of 7.`}${hint}`,
    levels: [
      'the melody alone, nothing under it',
      'the melody and one supporting layer: bare, intimate',
      'the melody and two supporting layers: a light texture',
      'three supporting layers: a full, warm texture',
      'four supporting layers: rich',
      'five supporting layers: dense, the whole ensemble at work',
      'every layer available: the fullest texture of the piece',
    ],
    prior: clamp((t - 1) * 0.9, 0, 6), spread: 0.7,
  });

  const inPrior: Record<LayerRole, number> = {
    melody: 0.97,
    counter: sigmoid((t - 3.6) * 1.2),
    inner: sigmoid((t - 1.6) * 1.3),
    bass: beat ? sigmoid((t - 1.1) * 1.6) : sigmoid((t - 1.4) * 1.4),
    pedal: 0.12,
    figuration: orch ? 0.92 * sigmoid((t - 0.4) * 1.2) : beat ? sigmoid(t - 2.4) : sigmoid((t - 1.3) * 1.2),
    texture: orch ? 0.22 + m.water * 0.5 + (rules.soundWorld === 'submerged' ? 0.25 : 0) : beat ? 0.3 : 0.08,
    pulse: beat ? sigmoid((t - 1.5) * 1.6) : play ? sigmoid(t - 3.2) : sigmoid((t - 5.6) * 1.5),
    accents: role === 'climax' ? 0.93 : t >= 6 ? 0.5 : t >= 5 && index === piece.sectionOf(index).first ? 0.3 : 0.05,
  };
  const instPrefer: Record<LayerRole, Partial<Record<InstrumentId, number>>> = {
    melody: orch
      ? { piano: 1.9 - 0.3 * t, violins: -0.9 + 0.42 * t, solo_violin: 0.7 - 0.2 * t + (1 - m.size) * 0.5, flute: 0.1, oboe: 0.2, clarinet: -0.2 }
      : play ? { flute: 1.1, clarinet: 1, oboe: 0.5, violins: 0.6, glockenspiel: 0.4, celesta: 0.4, piano: 0.5, pluck: 0.3 }
        : { pluck: 1.5, piano: 0.7, vibraphone: 0.5, violins: 0.2 },
    counter: { celli: 1.2, violas: 0.7, horn: 0.6 + (t >= 5 ? 0.5 : 0), clarinet: play ? 1 : 0.3, violins2: 0.3, oboe: 0.2, flute: 0.1, vibraphone: beat ? 0.8 : 0 },
    inner: beat ? { pad: 1.6, piano: 0.5, violas: 0.2 } : { violas: 1.1, violins2: 1, pad: 0, piano: 0.2, horn: 0.3 },
    bass: beat ? { sub: 1.8, piano: 0.3, basses: 0.3 } : { basses: 1.1 + 0.15 * t, celli: 1.5 - 0.25 * t, piano: 0.3, sub: -0.5 },
    pedal: { basses: 1, celli: 0.7, horn: 0.5, piano: 0.3, sub: beat ? 1 : -0.5 },
    figuration: orch ? { piano: 1.5, harp: 1.1, violas: 0.1, violins2: 0.1 } : play ? { harp: 0.8, violins2: 1, violas: 0.9, piano: 0.6, celesta: 0.5 } : { pluck: 1.5, piano: 0.6 },
    texture: { noise: 1 + m.water, violins: orch && t >= 4 ? 1.1 : 0.1, pad: beat ? 1 : 0.2, cymbal: t >= 5 ? 0.6 : -0.5 },
    pulse: beat ? { drumkit: 1.6, kick808: 0.8 + (t <= 3 ? 1.2 : 0) } : { timpani: orch ? 1.2 : 0.4, drumkit: play ? 1 : 0, kick808: 0.2 },
    accents: {},
  };

  for (const r of LAYERS) {
    if (r === 'accents') continue;
    let pool = ROLE_INSTRUMENTS[r].filter((id) => rules.palette.includes(id));
    if (r === 'counter' && draft.direction.counter === 'none' && !flags.overlap) pool = [];
    // A handoff was chosen for this phrase: the melody must move to a different instrument.
    if (r === 'melody' && flags.handoff && pool.length > 1) pool = pool.filter((id) => id !== lastInst('melody'));
    if (still && (r === 'figuration' || r === 'pulse')) pool = []; // the wall and the clearing: pulse and figuration fall away
    if (bloom && r === 'counter') pool = []; // the clearing leaves the melody alone above held chords
    offered[r] = pool;
    if (!pool.length) continue;
    const forced = (r === 'pedal' && flags.pedal_underlay) || (r === 'counter' && flags.overlap);
    let p = inPrior[r];
    p = was(r) ? p * 0.7 + 0.3 : p * 0.88;
    if (role === 'coda' && r !== 'melody') p *= 0.75;
    questions.push({
      id: `${r}_in`, type: 'noul', label: `${r}: in`,
      // For the supporting layers these answers rank which ones fill the places the density answer allows.
      instructions: `Should ${LAYER_JOB[r]} play in this phrase?${r === 'melody' ? '' : hint}${forced ? ' (The direction for this phrase already calls for it.)' : ''} ${was(r) ? 'It played in the previous phrase.' : 'It was silent in the previous phrase.'}`,
      prior: forced ? 0.98 : clamp(p, 0.02, 0.98),
    });
    if (r === 'melody') {
      // Instrument and register are one choice, so each option can state where the line would really
      // sit: how far it starts from where the last phrase ended, and how its top compares with the highest note so far.
      const facts = melodyFacts(piece);
      const semis = (n: number) => `${Math.abs(n)} semitone${Math.abs(n) === 1 ? '' : 's'}`;
      const REG: [string, number, string, number][] = [
        ['low', -1, 'dark, close, private', 0.2 + (t <= 2 ? 0.5 : 0) + (role === 'coda' ? 0.5 : 0) + (level('low') ? 0.9 : 0)],
        ['middle', 0, 'natural, singing', 1.2],
        ['high', 1, 'bright, exposed, soaring', -0.5 + t * 0.22 + (role === 'climax' ? 1.4 : 0) + (level('high', 'airborne') ? 1 : 0)],
      ];
      const seen = new Set<string>();
      const options: ChoiceOption[] = [];
      for (const id of pool) {
        for (const [reg, oct, feel, regPrior] of REG) {
          const placed = placeLine(draft.line, draft.key, id, oct);
          if (!placed.length) continue;
          const lo = Math.min(...placed.map((n) => n.midi));
          const hi = Math.max(...placed.map((n) => n.midi));
          if (seen.has(`${id}:${lo}:${hi}`)) continue; // a narrow instrument: this register lands where another already did
          seen.add(`${id}:${lo}:${hi}`);
          const leap = facts.lastEnd === null ? null : placed[0].midi - facts.lastEnd;
          const join = leap === null ? ''
            : leap === 0 ? ' It starts on the very note the last phrase ended on.'
              : ` It starts ${semis(leap)} ${leap > 0 ? 'above' : 'below'} the note the last phrase's melody ended on${Math.abs(leap) > 12 ? ' (more than an octave away)' : ''}.`;
          const peak = !facts.top ? ''
            : ` Its top note, ${midiName(hi, draft.key)}, is ${hi === facts.top.midi ? 'the same as' : `${semis(hi - facts.top.midi)} ${hi > facts.top.midi ? 'above' : 'below'}`} the highest melody note so far (${midiName(facts.top.midi, draft.key)}, phrase ${facts.top.phrase}).`;
          let prior = (instPrefer.melody[id] ?? -0.3) + regPrior + (role === 'return' && lastInst('melody') === id ? -1 : 0);
          if (leap !== null && Math.abs(leap) > 12) prior -= 1.2;
          if (atClimax && facts.top && hi > facts.top.midi) prior += 1;
          options.push(opt(`${id}__${reg}`, `${INSTRUMENTS[id].name}, ${reg}`,
            `${INSTRUMENTS[id].name} (${INSTRUMENTS[id].character}), ${reg} register (${feel}): ${midiName(lo, draft.key)} to ${midiName(hi, draft.key)}.${join}${peak}`, prior));
        }
      }
      if (!options.length) for (const id of pool) options.push(opt(`${id}__middle`, INSTRUMENTS[id].name, `${INSTRUMENTS[id].name}: ${INSTRUMENTS[id].character}`, instPrefer.melody[id] ?? -0.3));
      const climaxAt = piece.plan.climaxPhrase;
      const where = index < climaxAt ? `The climax is phrase ${climaxAt + 1}, ${climaxAt - index} phrase${climaxAt - index === 1 ? '' : 's'} from now.`
        : index === climaxAt ? 'This phrase is the climax.' : `The climax has passed (it was phrase ${climaxAt + 1}).`;
      questions.push({
        id: 'melody_voice', type: 'choice', label: 'melody: instrument and register',
        instructions: `Which instrument should take the melody, and in which register? ${where}`,
        options,
      });
    } else questions.push({
      id: `${r}_inst`, type: 'choice', label: `${r}: instrument`,
      instructions: `Which instrument should take ${LAYER_JOB[r]}?`,
      options: pool.map((id) => opt(id, INSTRUMENTS[id].name, `${INSTRUMENTS[id].name}: ${INSTRUMENTS[id].character}`,
        (instPrefer[r][id] ?? -0.3) + (lastInst(r) === id ? 0.5 : 0))),
    });
    const offset: Record<string, number> = { melody: 0.5, counter: -0.5, inner: -1, bass: -0.4, pedal: -1.5, figuration: -1, texture: -1.6, pulse: 0 };
    questions.push({
      id: `${r}_dyn`, type: 'score', label: `${r}: dynamics`,
      instructions: `How loud should ${LAYER_JOB[r]} be? The melody must stay clear above its accompaniment.`,
      levels: DYNAMIC_LEVELS, prior: clamp(overall + offset[r], 0, 6), spread: 0.55,
    });
    questions.push({
      id: `${r}_entry`, type: 'choice', label: `${r}: entry`,
      instructions: `If ${LAYER_JOB[r]} is newly entering, how should it come in?`,
      options: [
        opt('immediate', 'immediate', 'immediately, at the start of the phrase', r === 'melody' || r === 'bass' || r === 'pulse' ? 1.4 : 0.8),
        opt('fade_in', 'fade in', 'fading in from nothing across the first bar or two', r === 'inner' || r === 'texture' || r === 'pedal' ? 1.2 : 0.3),
        opt('delayed', 'delayed', 'delayed: it waits a bar and enters in bar two', r === 'counter' ? 1.1 : r === 'figuration' ? 0.5 : -0.2),
      ],
    });
  }

  // Melody details.
  const doublers = [...new Set([...ROLE_INSTRUMENTS.melody, ...ROLE_INSTRUMENTS.counter])].filter((id) => rules.palette.includes(id));
  if (doublers.length >= 2) {
    questions.push({
      id: 'melody_double', type: 'choice', label: 'melody: doubled by',
      instructions: `Should a second instrument play the melody together with the first, and if so which?${hint}`,
      options: [
        opt('none', 'no doubling', 'no doubling: the melody on one instrument alone, its own pure colour, free to be expressive', 1.6 - Math.max(0, t - 3) * 0.55),
        ...doublers.map((id) => opt(id, INSTRUMENTS[id].name, `${INSTRUMENTS[id].name} joins the melody: ${INSTRUMENTS[id].character}`, -0.5 + (t >= 5 ? 0.9 : 0) + (instPrefer.melody[id] ?? 0) * 0.3)),
      ],
    });
    questions.push({
      id: 'melody_double_at', type: 'choice', label: 'melody: doubling at',
      instructions: 'If the melody is doubled, where does the second instrument play it?',
      options: [
        opt('unison', 'unison', 'in unison: one thicker, sweeter voice', 1),
        opt('octave_above', 'octave above', 'an octave above: brilliance on top of the line', t >= 5 ? 0.9 : 0.2),
        opt('octave_below', 'octave below', 'an octave below: body and warmth under the line', 0.6),
      ],
    });
  }
  if (!still) questions.push({
    id: 'melody_style', type: 'choice', label: 'melody: playing style',
    instructions: 'How should the melody be played?',
    options: [
      opt('sustain', 'sustained', 'sustained and connected: singing', (play ? 0.6 : 1.6) + (moves('flowing', 'frozen') ? 0.8 : 0)),
      opt('staccato', 'staccato', 'staccato: short, detached, light', (play ? 1.2 : -0.8 + (beat ? 0.8 : 0)) + (moves('sharp', 'bouncing') ? 1.3 : 0)),
      opt('pizzicato', 'pizzicato', 'pizzicato (strings only): plucked, dry, playful', play ? 0.9 : -1.2),
    ],
  });
  if (flags.octave_doubling) {
    questions.push({
      id: 'doubling', type: 'choice', label: 'octave doubling',
      instructions: 'The melody is doubled at the octave in this phrase. Which way?',
      options: [opt('above', 'above', 'doubled an octave above: brilliance, clarity', role === 'climax' ? 1 : 0.6), opt('below', 'below', 'doubled an octave below: body, power', 0.7)],
    });
  }
  if (flags.call_response) {
    const pool = [...new Set([...offered.melody, ...(ROLE_INSTRUMENTS.counter.filter((id) => rules.palette.includes(id)))])];
    if (pool.length > 1) {
      questions.push({
        id: 'response_inst', type: 'choice', label: 'response instrument',
        instructions: 'Call and response was chosen: the second half of the melody passes to another instrument. Which one answers?',
        options: pool.map((id) => opt(id, INSTRUMENTS[id].name, `${INSTRUMENTS[id].name}: ${INSTRUMENTS[id].character}`, instPrefer.counter[id] ?? instPrefer.melody[id] ?? 0)),
      });
    }
  }

  // Layer details.
  questions.push({
    id: 'inner_style', type: 'choice', label: 'inner harmony: style',
    instructions: 'How should the inner harmony be played?',
    options: [
      opt('sustain', 'sustained', 'sustained: a smooth bed', 1.4 - (play ? 0.8 : 0)),
      opt('tremolo', 'tremolo', 'tremolo: shivering, charged, tense', -1 + (t >= 5 ? 1.6 : 0) + (orch ? 0.3 : 0) + (moves('shaking') ? 1.6 : 0)),
      ...(still ? [] : [opt('pulsed', 'pulsed', 'pulsed: repeated chords on the beat; urgency or bounce', -0.6 + (play ? 1.6 : 0) + (t >= 5 ? 0.6 : 0) + (beat ? 0.6 : 0) + (moves('bouncing', 'sharp') ? 0.9 : 0))]),
    ],
  });
  questions.push({
    id: 'inner_density', type: 'choice', label: 'inner harmony: density',
    instructions: 'How dense should the inner harmony be?',
    options: [
      opt('two', 'two voices', 'two voices: thin, transparent', 1.2 - t * 0.25),
      opt('three', 'three voices', 'three voices: full', 0.8),
      opt('three_plus', 'three, top doubled', 'three voices with the top doubled an octave up: rich, wide', -1.6 + t * 0.4),
    ],
  });
  questions.push({
    id: 'bass_octave', type: 'choice', label: 'bass: octave',
    instructions: 'Which octave should the bass take?',
    options: [opt('normal', 'normal', 'normal bass register: clear', 1), opt('low', 'low', 'an octave lower: deep, heavy', -0.6 + t * 0.25 + (beat ? 0.5 : 0))],
  });
  questions.push({
    id: 'pedal_note', type: 'choice', label: 'pedal: which note',
    instructions: 'If a pedal is held, on which note?',
    options: [opt('tonic', 'tonic', 'the tonic: grounded, grave', 1), opt('dominant', 'dominant', 'the dominant: suspended, expectant', draft.direction.ending === 'half_resolved' ? 1.2 : 0.4)],
  });
  questions.push({
    id: 'pedal_span', type: 'choice', label: 'pedal: how long',
    instructions: 'How long should the pedal be held?',
    options: [opt('half', 'half the phrase', 'the first two bars only', 0.4), opt('whole', 'the whole phrase', 'the whole phrase', 1)],
  });
  const perSec = (n: number) => (n * piece.bpmOf(index)) / 60;
  const speeds = [1, 2, 3, 4].filter((n) => perSec(n) <= 9.5 || n === 1);
  questions.push({
    id: 'figuration_pattern', type: 'choice', label: 'figuration: pattern',
    instructions: 'Which figuration pattern?',
    options: [
      opt('rising', 'rising arpeggio', 'rising arpeggio, restarting on each chord: lifting, wave after wave', 1),
      opt('rise_fall', 'rise and fall', 'rising then falling through the chord: rocking, wave-like', orch ? 1.3 : 0.7),
      opt('broken', 'broken chord', 'broken chord alternating low and high notes: gentle motor', play ? 1.1 : 0.5),
      opt('ostinato', 'ostinato', 'a fixed root-fifth-octave cell repeated: insistent', beat ? 1.4 : 0.1 + (t >= 5 ? 0.6 : 0)),
    ],
  });
  questions.push({
    id: 'figuration_speed', type: 'choice', label: 'figuration: speed',
    instructions: 'How fast should the figuration move?',
    options: speeds.map((n) => opt(`n${n}`, `${n} per beat`, `${n} note${n === 1 ? '' : 's'} per beat (${perSec(n).toFixed(1)} notes a second)`,
      -(((perSec(n) - (2.4 + t * 0.6)) / 2) ** 2) + (n === rules.meter.sub || n === 1 ? 0.4 : rules.meter.sub === 3 && n !== 3 ? -0.8 : 0))),
  });
  questions.push({
    id: 'pulse_pattern', type: 'choice', label: 'pulse: pattern',
    instructions: 'Which pulse pattern?',
    options: ([
      opt('trap', 'trap', 'trap: half time with the snare on beat three, sparse syncopated kicks, fast hi-hats that roll into the bar line', 1.6),
      opt('boom_bap', 'boom-bap', 'boom-bap: swung hats, kick and snare trading blows, heavy and unhurried', 1.6),
      opt('funk', 'funk', 'funk: sixteenth-note hats, syncopated kick, snare on two and four with ghost notes between', 1.6),
      opt('four_on_floor', 'four on the floor', 'a kick on every beat: driving, dance', beat ? 1.2 + (t >= 4 ? 0.5 : 0) : -0.3),
      opt('backbeat', 'backbeat', 'kick on one and three, snare on two and four: a groove', beat ? 1 : play ? 0.9 : -0.2),
      opt('half_time', 'half time', 'half time: one kick, one snare per bar; heavy, spacious', beat ? 0.6 + (t <= 3 ? 0.6 : 0) : 0),
      opt('syncopated', 'syncopated', 'syncopated kicks and busy hats: restless, intricate', beat ? 0.8 + (t >= 5 ? 0.6 : 0) : play ? 0.4 : -0.6),
      opt('heartbeat', 'heartbeat', 'a soft double thump at the start of each bar: a heartbeat under the music', orch ? 0.9 : 0.3 + (t <= 3 ? 0.6 : 0)),
      opt('downbeats', 'downbeats', 'one stroke on each downbeat: solemn, processional', orch ? 1 : 0),
      opt('roll_to_downbeat', 'roll to the downbeat', 'a roll swelling through the last bar into the next downbeat: arrival', orch ? 0.7 + (t >= 6 ? 0.8 : 0) : 0),
    ] as ChoiceOption[]).filter((o) => (rules.groove ? GROOVES[rules.groove].patterns.includes(o.key) : !['trap', 'boom_bap', 'funk'].includes(o.key))),
  });
  if (beat) {
    const g = rules.groove;
    questions.push({
      id: 'bass_rhythm', type: 'choice', label: 'bass: rhythm',
      instructions: 'What rhythm should the bass play?',
      options: [
        opt('held', 'held', 'held: one long note per chord: weight without motion', 0.6 + (t <= 3 ? 0.8 : 0)),
        opt('eighths', 'pumping eighths', 'pumping eighth notes on the chord root: drive, the engine of dance music', g === 'house' ? 1.5 : 0.3),
        opt('with_kick', 'with the kick', 'hits with every kick and rings until the next: the 808 way, bass and kick as one instrument', g === 'trap' || g === 'boom_bap' ? 1.7 : 0.5),
        opt('syncopated', 'syncopated', 'a syncopated sixteenth-note figure with octave pops: funk, the bass as a second drummer', g === 'funk' ? 1.8 : 0.1),
      ],
    });
  }
  questions.push({
    id: 'pulse_intensity', type: 'score', label: 'pulse: intensity',
    instructions: `How busy and forceful should the pulse be?${hint}`,
    levels: AMOUNT_LEVELS, prior: clamp(t - 1.5, 0, 6), spread: 0.7,
  });

  // Accents.
  const accentKinds: [string, string, string, InstrumentId[], number][] = [
    ['full_hit', 'full hit', 'full hit: every available drum, cymbal and low octave together; the biggest blow', ['bass_drum', 'cymbal', 'timpani', 'piano', 'drumkit', 'tam_tam'], role === 'climax' ? 1.6 : 0.2],
    ['cymbal_swell', 'cymbal swell', 'cymbal swell: a roll rising into the moment; anticipation, light', ['cymbal'], 0.9],
    ['bass_drum', 'bass drum', 'bass drum: one deep impact', ['bass_drum'], 0.6],
    ['low_piano_octave', 'low piano octave', 'low piano octave: a dark bell under everything', ['piano'], orch ? 0.9 : 0.3],
    ['timpani', 'timpani stroke', 'timpani stroke on the root: pitched thunder', ['timpani'], 0.6],
    ['tam_tam', 'tam-tam', 'tam-tam: a dark metallic wash that blooms after the stroke', ['tam_tam'], 0.2 + m.darkness * 0.6],
    ['crash', 'kit crash', 'drum-kit crash and kick: a drop landing', ['drumkit'], beat ? 1.4 : 0],
  ];
  // A swell arrival has no blow at the peak; a hit arrival always has one.
  const noAccent = atClimax && (arrival === 'swell' || arrival === 'bloom');
  const hitArrival = atClimax && arrival === 'hit';
  const accentPool = noAccent ? [] : accentKinds.filter(([key, , , needs]) => (key === 'full_hit' ? needs.filter((id) => rules.palette.includes(id)).length >= 2 : needs.every((id) => rules.palette.includes(id))));
  offered.accents = accentPool.length ? (accentPool.flatMap((a) => a[3]).filter((id, i, all) => rules.palette.includes(id) && all.indexOf(id) === i)) : [];
  if (accentPool.length) {
    questions.push({
      id: 'accents_in', type: 'noul', label: 'accents: in',
      instructions: `Should this phrase have an accent: a hit or swell at a chosen moment?${hitArrival ? ' (The plan already calls for it: the climax arrives as a hit.)' : ''}`,
      prior: hitArrival ? 0.98 : clamp(Math.max(inPrior.accents, cue?.peak && cue.peak.strength >= 5 ? 0.9 : cue?.cut ? 0.45 : 0), 0.02, 0.98),
    });
    questions.push({
      id: 'accents_kind', type: 'choice', label: 'accents: kind',
      instructions: 'Which kind of accent?',
      options: accentPool.map(([key, label, text, , prior]) => opt(key, label, text, prior)),
    });
    questions.push({
      id: 'accents_where', type: 'choice', label: 'accents: where',
      instructions: 'Where in the phrase should the accent land?',
      options: [
        opt('phrase_start', 'phrase start', 'on the first downbeat: an arrival', role === 'climax' ? 1.1 : 0.8),
        opt('bar_3', 'bar three', 'on the downbeat of bar three: the middle of the phrase', 0.5),
        opt('last_bar', 'last bar', 'on the downbeat of the last bar: a late blow', 0.3),
        opt('melody_peak', 'melody peak', 'on the highest note of the melody: the accent crowns the line', role === 'climax' ? 1.3 : 0.6),
        ...(cue?.peak ? [opt('video_peak', 'picture high point', `on the high point in the picture at beat ${Math.round(cue.peak.beat * 10) / 10 + 1} (peak ${cue.peak.strength} of 7): the hit lands with the image`, 2.6)] : []),
        ...(cue?.cut ? [opt('video_cut', 'scene cut', `on the scene cut at beat ${Math.round(cue.cut.beat * 10) / 10 + 1}: the hit marks the change of shot`, cue.peak ? 0.6 : 1.8)] : []),
      ],
    });
    questions.push({
      id: 'accents_dyn', type: 'score', label: 'accents: how hard',
      instructions: 'How hard should the accent hit?',
      levels: DYNAMIC_LEVELS, prior: clamp(overall + 1, 0, 6), spread: 0.6,
    });
    questions.push({
      id: 'pause_before_hit', type: 'noul', label: 'pause before the hit',
      instructions: 'Should everything fall silent for an instant just before the accent, so it lands harder?',
      yes: 'A breath of silence before the hit: the biggest moments earn this.',
      no: 'No pause: the music runs straight into the accent.',
      prior: role === 'climax' ? (orch ? 0.82 : 0.5) : cue?.peak && cue.peak.strength >= 6 ? 0.45 : 0.05,
    });
  }

  // How the phrase moves inside itself: who drops out, where it breathes, how the level moves.
  const sectionEnd = index === piece.sectionOf(index).last;
  const sectionEnd0 = index === piece.sectionOf(index).first; // this phrase opens a section
  const chorusNext = !!piece.chorusAt(index + 1)?.starts;
  const finalPhrase = index === piece.plan.totalPhrases - 1;
  const wallNext = index === piece.plan.climaxPhrase - 1 && arrivesAfterBreath(arrival);
  if (!peak && !bloom) {
    questions.push({
      id: 'texture_shape', type: 'choice', label: 'texture inside the phrase',
      instructions: 'How should the texture move inside this phrase? Instruments need not play all the way through.',
      options: [
        opt('full', 'full', 'every chosen layer plays through the whole phrase', 1.4),
        opt('late_entry', 'late entry', 'the melody and bass begin alone; the rest of the accompaniment waits and enters at the half: space first, then warmth', 0.5 + (t <= 3 ? 0.4 : 0)),
        opt('drop_out', 'drop out', 'the accompaniment falls away at the half, leaving melody and bass exposed: a sudden clearing', 0.3),
        opt('bare_ending', 'bare ending', 'everything but the melody stops for the last bar: the line is left alone in the air', 0.3 + (sectionEnd ? 0.5 : 0)),
      ],
    });
  }
  if (!wallNext && !finalPhrase) {
    questions.push({
      id: 'phrase_close', type: 'choice', label: 'how the phrase closes',
      instructions: 'How should this phrase close before the next one begins?',
      options: [
        opt('run_on', 'run on', 'runs straight on into the next phrase: momentum, no punctuation', 0.8 + (t >= 5 ? 0.6 : 0)),
        opt('melody_breathes', 'melody breathes', 'the melody lifts off a beat early while the accompaniment carries on underneath: a comma', 0.9),
        opt('all_breathe', 'everyone breathes', 'everything stops for a moment just before the bar line, only the hall still ringing: a full stop the listener can feel', 0.4 + (sectionEnd ? 0.9 : 0)),
        opt('long_silence', 'long silence', 'everything stops for the whole last half-bar: a long held silence before the music goes on', sectionEnd && t <= 3 ? 0.6 : -0.4),
        ...(beat ? [opt('strip_back', 'strip back', 'the drums, bass and chords drop out for the last bar and the melody is left alone: the set-up before a chorus or a drop, so what comes next lands harder', chorusNext ? 1.8 : 0.1)] : []),
      ],
    });
  }
  // How this phrase is joined to the one before. Asked only when the last phrase did not end in silence, and not at an arrival after a held breath.
  const afterSilence = !last || ['breath', 'all_breathe', 'long_silence', 'strip_back'].includes(last.close ?? '');
  if (!afterSilence && !peak && !bloom) {
    const lastStarts = piece.phrases.slice(-3).map((ph) => (ph.start ?? 'downbeat').replace('_', ' '));
    const first = draft.line[0];
    const g = piece.grid === 0.5 ? 'two eighth notes' : 'two quick notes';
    questions.push({
      id: 'melody_start', type: 'choice', label: 'how the melody begins',
      instructions: `How should the melody begin this phrase? The last ${lastStarts.length === 1 ? 'phrase began' : `${lastStarts.length} phrases began`}: ${lastStarts.join(', ')}.`,
      options: [
        opt('downbeat', 'on the downbeat', 'on the downbeat: the melody begins exactly at the bar line: clear and square', 1 - 0.3 * lastStarts.filter((x) => x === 'downbeat').length),
        ...(first && first.deg !== null ? [opt('pickup', 'with a pickup', `with a pickup: ${g} step into the first note, starting before the bar line, so the melody is already moving when the phrase begins and the join is sung across`, 0.8)] : []),
        ...(first && first.deg !== null && first.dur >= 2 ? [opt('late', 'after the downbeat', 'after the downbeat: the accompaniment starts the phrase and the melody waits one beat before coming in: unhurried, conversational', 0.5)] : []),
      ],
    });
    const lastJoins = piece.phrases.slice(-3).map((ph) => ph.join ?? 'clean');
    questions.push({
      id: 'join', type: 'choice', label: 'how the instruments change over',
      instructions: `If instruments join or leave at this phrase, how should the change happen? The last ${lastJoins.length === 1 ? 'join was' : `${lastJoins.length} joins were`}: ${lastJoins.join(', ')}.`,
      options: [
        opt('clean', 'clean', 'clean: every change happens exactly at the bar line: a clear new section', sectionEnd0 ? 1.1 : 0.6),
        opt('dovetail', 'dovetailed', 'dovetailed: instruments joining now steal in softly a bar early, under the end of the last phrase, and instruments leaving linger over the first bar before letting go: the seam is hidden and the music flows across it', sectionEnd0 ? 0.6 : 1.2),
      ],
    });
  }
  const lastT = last ? last.score.display.tension : t;
  const before = lastLevel(piece);
  questions.push({
    id: 'dynamic_shape', type: 'choice', label: 'dynamics inside the phrase',
    instructions: `How should the overall dynamic move inside this phrase?${before === null ? '' : ` The last phrase left off at ${DYNAMIC_NAMES[clamp(Math.round(before), 0, 6)]}.`}`,
    options: [
      opt('steady', 'steady', 'steady: one level throughout; any change from the last phrase happens at once, at the bar line', 1),
      ...(peak ? [] : [opt('crescendo', 'crescendo', 'crescendo: grows through the whole phrase, from where the last phrase left off up to this phrase\'s dynamic', t > lastT + 0.3 ? 1.6 : 0.2)]),
      opt('diminuendo', 'diminuendo', 'diminuendo: falls through the phrase; from the last phrase\'s level down to this one if that was louder, otherwise fading about one level by the end', t < lastT - 0.3 ? 1.5 : role === 'coda' ? 0.9 : 0.1),
      ...(peak ? [] : [opt('swell', 'swell', 'swell: rises to this phrase\'s dynamic in the middle and falls back by the end, like one breath', 0.6)]),
    ],
  });

  // Effects.
  const sub = rules.soundWorld === 'submerged';
  const fx: [keyof MixState & string, string, string, number][] = [
    ['lowpass', 'Low-pass filter', 'How open should the low-pass filter be? (none = submerged, muffled; maximum = fully open and bright)', sub ? 1.4 + t * 0.5 : beat ? 2.2 + t * 0.55 : 3.6 + t * 0.35],
    ['reverb', 'Reverb amount', 'How much reverb? (none = dry and close; maximum = vast)', (rules.soundWorld === 'close_dry' ? 1.5 : rules.soundWorld === 'electronic_hybrid' ? 2.4 : 3.8) + (t <= 2 ? 0.6 : 0) + (role === 'coda' ? 0.5 : 0)],
    ['delay', 'Delay', 'How much echo? Echoes suit sparse lines and blur busy ones.', (t <= 2.5 ? 2.2 : 0.8) + (beat ? 1 : 0)],
    ['noise', 'Noise texture', 'How much water-and-air noise texture?', 0.4 + m.water * 2.6 + (sub ? 1 : 0)],
    ['width', 'Stereo width', 'How wide should the stereo image be? (none = narrow, intimate; maximum = wide)', 1.6 + t * 0.55],
    ['saturation', 'Saturation', 'How much saturation? (a little = warmth; a lot = grit)', beat ? 1.6 + t * 0.35 : 0.6 + (t >= 6 ? 1 : 0)],
  ];
  for (const [id, label, text, prior] of fx) {
    if ((peak || bloom) && id === 'lowpass') continue; // the wall, the clearing and the drop open the filter fully
    questions.push({ id: `fx_${id}`, type: 'score', label, instructions: id === 'lowpass' || id === 'width' ? text + hint : text, levels: AMOUNT_LEVELS, prior: clamp(prior, 0, 6), spread: 0.6 });
  }
  questions.push({ id: 'fx_chorus', type: 'noul', label: 'Chorus', instructions: 'Should chorus thicken the pads and strings in this phrase?', prior: beat ? 0.6 : 0.12 + (t >= 5 ? 0.15 : 0) });
  questions.push({ id: 'fx_sidechain', type: 'noul', label: 'Sidechain pump', instructions: 'Should the mix duck on every kick (sidechain pump)? It only makes sense with a kick-driven pulse.', prior: beat ? 0.84 : 0.02 });
  return { questions, offered };
}

// ───────────────────────────── Writing the notes ─────────────────────────────

function chordAt(slots: Slot[], t: number): Slot {
  return slots.find((s) => t >= s.t - 1e-6 && t < s.t + s.dur - 1e-6) ?? slots[slots.length - 1];
}

function placeLine(line: Line, key: Key, inst: InstrumentId, octaves: number): { midi: number; t: number; dur: number }[] {
  const notes = timed(line, key);
  if (!notes.length) return [];
  const mean = notes.reduce((s, n) => s + n.midi, 0) / notes.length;
  const centre = CENTRE[inst] ?? (INSTRUMENTS[inst].range[0] + INSTRUMENTS[inst].range[1]) / 2;
  const shift = (Math.round((centre - mean) / 12) + octaves) * 12;
  return notes.map((n) => ({ ...n, midi: fold(n.midi + shift, inst) }));
}

function artFor(inst: InstrumentId, wanted: Articulation): Articulation {
  const arts = INSTRUMENTS[inst].arts;
  if (arts.includes(wanted)) return wanted;
  if (wanted === 'pizzicato' && arts.includes('staccato')) return 'staccato';
  return arts[0];
}

function drumBar(pattern: string, intensity: number, bar: number, sub: 2 | 3, lastBar: boolean, barIndex = 0): { t: number; midi: number; vel: number }[] {
  const out: { t: number; midi: number; vel: number }[] = [];
  const v = 0.45 + intensity * 0.075;
  const beats = Math.floor(bar + 1e-6);
  const KICK = 36, SNARE = 38, HAT = 42, OPEN = 46, TOM1 = 50, TOM2 = 47, TOM3 = 45;
  const kick = (t: number, s = 1) => t < bar && out.push({ t, midi: KICK, vel: v * s });
  const snare = (t: number, s = 1) => t < bar && out.push({ t, midi: SNARE, vel: v * 0.92 * s });
  const hats = (step: number, accentEvery: number) => {
    if (intensity < 2) return;
    for (let i = 0; i * step < bar - 1e-6; i++) out.push({ t: q(i * step), midi: HAT, vel: v * (i % accentEvery === 0 ? 0.6 : 0.36) });
  };
  const offbeat = sub === 3 ? 2 / 3 : 0.5;
  const fine = sub === 3 ? 1 / 3 : intensity >= 4 ? 0.25 : 0.5;
  const back = beats >= 4 ? [1, 3] : beats === 3 ? [2] : [1];
  // The hip-hop and funk grooves are written for simple meters; in a compound meter they fall back to a backbeat.
  if (sub === 3 && ['trap', 'boom_bap', 'funk'].includes(pattern)) pattern = 'backbeat';
  const odd = barIndex % 2 === 1;
  const hat = (t: number, s: number, midi = HAT) => t < bar - 1e-6 && out.push({ t: q(t), midi, vel: v * s });
  switch (pattern) {
    case 'trap': {
      kick(0); if (odd) kick(0.75, 0.8); kick(2.5, 0.85); if (intensity >= 4) kick(3.25, 0.7);
      snare(beats >= 4 ? 2 : beats - 1);
      // fast hats, breaking into a roll over the last beat of every second bar
      const rolls = intensity >= 2 && (odd || lastBar);
      const stepH = intensity >= 3 ? 0.25 : 0.5;
      for (let i = 0; i * stepH < (rolls ? bar - 1 : bar) - 1e-6; i++) hat(i * stepH, (i * stepH) % 1 < 1e-6 ? 0.6 : 0.36);
      if (rolls) { const r = intensity >= 5 ? 1 / 12 : 1 / 6; for (let k = 0; k * r < 1 - 1e-6; k++) hat(bar - 1 + k * r, 0.3 + 0.35 * k * r); }
      if (intensity >= 4) hat(1.5, 0.5, OPEN);
      break;
    }
    case 'boom_bap': {
      const sw = 2 / 3; // the off-beat, swung late
      kick(0); if (odd) { kick(1 + sw, 0.75); kick(2, 0.9); } else kick(2 + sw, 0.9);
      if (intensity >= 4) kick(3 + sw, 0.55);
      back.forEach((b) => snare(b));
      for (let b = 0; b < beats; b++) { hat(b, 0.6); hat(b + sw, 0.4); }
      break;
    }
    case 'funk': {
      kick(0); kick(0.75, 0.7); kick(2.5, 0.9); if (odd) kick(3.25, 0.7);
      back.forEach((b) => snare(b));
      if (intensity >= 3) { snare(1.75, 0.3); snare(2.25, 0.3); snare(3.75, 0.35); } // ghost notes
      for (let i = 0; i * 0.25 < bar - 1e-6; i++) { const t = i * 0.25; if (intensity >= 4 && Math.abs(t - (bar - 0.5)) < 1e-6) hat(t, 0.55, OPEN); else hat(t, i % 2 === 0 ? 0.6 : 0.32); }
      break;
    }
    case 'four_on_floor':
      for (let b = 0; b < beats; b++) kick(b);
      if (intensity >= 3) back.forEach((b) => snare(b, 0.85));
      hats(fine, sub === 3 ? 3 : Math.round(1 / fine));
      if (intensity >= 2 && sub === 2) for (let b = 0; b < beats; b++) out.push({ t: b + 0.5, midi: intensity >= 5 ? OPEN : HAT, vel: v * 0.55 });
      break;
    case 'backbeat':
      kick(0); if (beats >= 4) kick(2); if (intensity >= 4) kick(q((beats >= 4 ? 2 : 1) - (1 - offbeat)), 0.7);
      back.forEach((b) => snare(b));
      hats(sub === 3 ? 1 / 3 : 0.5, sub === 3 ? 3 : 2);
      break;
    case 'half_time':
      kick(0); snare(beats >= 4 ? 2 : beats - 1);
      hats(sub === 3 ? 1 / 3 : 0.5, sub === 3 ? 3 : 2);
      if (intensity >= 3) out.push({ t: q(bar - offbeat), midi: OPEN, vel: v * 0.5 });
      break;
    case 'syncopated':
      kick(0); kick(q(1 + offbeat), 0.85); if (beats >= 4) kick(q(2 + offbeat), 0.8);
      back.forEach((b) => snare(b));
      if (intensity >= 4) snare(q(bar - (sub === 3 ? 1 / 3 : 0.25)), 0.45);
      hats(sub === 3 ? 1 / 3 : 0.25, sub === 3 ? 3 : 4);
      break;
    case 'heartbeat':
      kick(0, 0.85); kick(q(offbeat), 0.6);
      break;
    case 'roll_to_downbeat':
      kick(0);
      if (lastBar) [TOM1, TOM1, TOM2, TOM2, TOM3, TOM3].forEach((midi, i) => out.push({ t: q(bar - 1 + i / 6), midi, vel: v * (0.5 + i * 0.08) }));
      else hats(sub === 3 ? 1 / 3 : 0.5, sub === 3 ? 3 : 2);
      break;
    default: // downbeats
      kick(0); if (intensity >= 3) for (let b = 1; b < beats; b++) out.push({ t: b, midi: 51, vel: v * 0.4 });
  }
  return out;
}

interface Written {
  notes: NoteEvent[];
  pedal: { t: number; down: boolean }[];
  layers: LayerSummary[];
  mix: MixState;
  holdChord: HoldNote[];
  /** What happened inside the phrase, for the lineage line on the panel. */
  remarks: string[];
  /** Notes that sound before this phrase's first bar line (a pickup, instruments stealing in), in beats before it: t is negative. */
  leadIn: NoteEvent[];
}

function write(ctx: Ctx, index: number, draft: Draft, picks: Picks, values: Record<string, number>, offered: Record<LayerRole, InstrumentId[]>): Written {
  const { piece } = ctx;
  const { rules } = piece;
  const key = draft.key;
  const bar = rules.meter.beatsPerBar;
  const beats = piece.beatsOf(index);
  const unit = piece.halfOf(index);
  const bars = piece.barsOf(index);
  const last = piece.phrases[piece.phrases.length - 1];
  const flags = draft.direction.flags;
  const notes: NoteEvent[] = [];
  const leadIn: NoteEvent[] = [];
  const remarks: string[] = [];
  const step = (id: string, fallback = 3) => clamp(Number(picks[id] ?? fallback), 0, 6) as Step7;

  // Which layers are in, and on what.
  const chosen = {} as Record<LayerRole, LayerChoice>;
  for (const r of LAYERS) {
    const has = (offered[r] ?? []).length > 0 && picks[`${r}_in`] !== undefined;
    let on = has && picks[`${r}_in`] === 'yes';
    if (r === 'melody' && has) on = on || !LAYERS.some((x) => x !== 'melody' && picks[`${x}_in`] === 'yes'); // something must sound
    if (r === 'pedal' && has && flags.pedal_underlay) on = true;
    if (r === 'counter' && has && flags.overlap) on = true;
    if (r === 'accents' && has && index === piece.plan.climaxPhrase && piece.plan.climaxArrival === 'hit') on = true;
    const inst = on ? ((r === 'accents' ? null : (picks[`${r}_inst`] as InstrumentId)) ?? null) : null;
    const wasIn = !!last?.layers.find((l) => l.role === r && l.inst);
    chosen[r] = {
      role: r, on, inst, dyn: step(`${r}_dyn`), art: null, detail: '',
      entry: !on ? 'continues' : wasIn || index === 0 ? (wasIn ? 'continues' : 'immediate') : ((picks[`${r}_entry`] ?? 'immediate') as LayerSummary['entry']),
    };
  }

  const push = (layer: LayerRole, inst: InstrumentId, art: Articulation, t: number, dur: number, midi: number, vel: number) => {
    if (t >= beats - 1e-6 || dur <= 0) return;
    notes.push({ t: q(t), dur: q(Math.min(dur, beats - t)), midi, vel: clamp(vel, 0.05, 1), inst, art, layer });
  };

  // ── Melody ──
  const mel = chosen.melody;
  let melodyNotes: { midi: number; t: number; dur: number }[] = [];
  if (mel.on && mel.inst) {
    const reg = picks.melody_register === 'high' ? 1 : picks.melody_register === 'low' ? -1 : 0;
    melodyNotes = placeLine(draft.line, key, mel.inst, reg);
    // The melody waits a beat: the accompaniment starts the phrase.
    if (picks.melody_start === 'late' && melodyNotes.length && melodyNotes[0].t < 1e-6 && melodyNotes[0].dur >= 2) {
      melodyNotes[0] = { ...melodyNotes[0], t: 1, dur: q(melodyNotes[0].dur - 1) };
      remarks.push('the melody enters after the downbeat');
    }
    const wanted = (picks.melody_style ?? 'sustain') as Articulation;
    const art = artFor(mel.inst, wanted === 'pizzicato' && !INSTRUMENTS[mel.inst].arts.includes('pizzicato') ? 'staccato' : wanted);
    mel.art = art;
    const base = velOf(mel.dyn);
    const top = Math.max(...melodyNotes.map((n) => n.midi));
    const responder = flags.call_response ? ((picks.response_inst as InstrumentId) ?? null) : null;
    const partner = picks.melody_double && picks.melody_double !== 'none' && picks.melody_double !== mel.inst && rules.palette.includes(picks.melody_double as InstrumentId)
      ? (picks.melody_double as InstrumentId) : null;
    const partnerShift = picks.melody_double_at === 'octave_above' ? 12 : picks.melody_double_at === 'octave_below' ? -12 : 0;
    for (const n of melodyNotes) {
      const shape = 0.9 + 0.16 * Math.sin((Math.PI * n.t) / beats);
      const strong = rules.meter.strong.includes(q(n.t % bar)) ? 0.03 : 0;
      const vel = base * shape + strong + (n.midi === top ? 0.04 : 0);
      const answering = responder && responder !== mel.inst && n.t >= unit - 1e-6;
      const inst = answering ? responder! : mel.inst;
      const midi = answering ? fold(n.midi + Math.round(((CENTRE[inst] ?? n.midi) - n.midi) / 12) * 12, inst) : n.midi;
      const useArt = answering ? artFor(inst, art) : art;
      push('melody', inst, useArt, n.t, n.dur, midi, vel);
      if (flags.octave_doubling) {
        const other = midi + (picks.doubling === 'below' ? -12 : 12);
        const [lo, hi] = INSTRUMENTS[inst].range;
        if (other >= lo && other <= hi) push('melody', inst, useArt, n.t, n.dur, other, vel * 0.82);
      }
      // A second instrument plays the melody with the first.
      if (partner) push('melody', partner, artFor(partner, art), n.t, n.dur, fold(midi + partnerShift, partner), vel * 0.85);
    }
    // A pickup: two notes step into the first note, before the bar line, from the side the last phrase ended on.
    const firstDeg = draft.line[0]?.deg ?? null;
    if (picks.melody_start === 'pickup' && last && melodyNotes.length && firstDeg !== null) {
      const first = melodyNotes[0];
      const from = melodyFacts(piece).lastEnd;
      const dir = from !== null && from > first.midi ? 1 : -1;
      const g = piece.grid;
      const [lo, hi] = INSTRUMENTS[mel.inst].range;
      [2, 1].forEach((k, i) => {
        const midi = first.midi + degreeToMidi(key, firstDeg + dir * k) - degreeToMidi(key, firstDeg);
        if (midi >= lo && midi <= hi) leadIn.push({ t: q(-k * g), dur: q(g), midi, vel: clamp(base * (0.72 + 0.1 * i), 0.05, 1), inst: mel.inst!, art, layer: 'melody' });
      });
      if (leadIn.length) remarks.push('the melody begins with a pickup');
    }
    mel.detail = `${picks.melody_register ?? 'middle'} register${flags.octave_doubling ? `, doubled ${picks.doubling ?? 'above'}` : ''}${responder && responder !== mel.inst ? `, answered by ${INSTRUMENTS[responder].name}` : ''}${partner ? `, doubled by ${INSTRUMENTS[partner].name}${partnerShift ? ` an octave ${partnerShift > 0 ? 'above' : 'below'}` : ' in unison'}` : ''}`;
  }

  // ── Counter-melody ──
  const ctr = chosen.counter;
  if (ctr.on && ctr.inst) {
    let line: Line = [];
    let startAt = 0;
    let detail = draft.direction.counter.replace(/_/g, ' ');
    const tctx = { grid: piece.grid };
    if (flags.overlap) {
      line = truncate(draft.line, beats - bar, piece.grid);
      startAt = bar;
      detail = 'second entry of the melody, a bar later';
    } else if (draft.direction.counter === 'counter_theme' && piece.theme('B')) {
      line = piece.theme('B')!.line;
      startAt = bar;
      detail = 'counter-theme B';
    } else if (draft.direction.counter === 'theme_augmented') {
      line = applyOps(piece.mainTheme.line, ['fragment_head', 'augmentation'], tctx);
      detail = 'theme A opening, augmented';
    } else if (draft.direction.counter === 'sixths_below') {
      line = draft.line.map((n) => (n.deg === null ? { ...n } : { ...n, deg: n.deg - 5 }));
      detail = 'melody a sixth below';
    } else {
      // A slow stepwise descent from the fifth, stepping aside from any clash with the chord beneath.
      const each = bar / 2;
      let deg = 4;
      for (let t = 0; t < beats - 1e-6; t += each) {
        const slot = chordAt(draft.slots, t);
        if (fitOf(degreeToMidi(key, deg), slot.chord, key) === 'clash') deg -= 1;
        line.push({ deg, dur: q(each) });
        deg -= 1;
      }
      detail = 'stepwise descent from the fifth';
    }
    line = truncate(line, beats - startAt, piece.grid);
    ctr.art = 'sustain';
    ctr.detail = detail;
    const base = velOf(ctr.dyn);
    for (const n of placeLine(line, key, ctr.inst, 0)) push('counter', ctr.inst, 'sustain', n.t + startAt, n.dur, n.midi, base * (0.92 + 0.1 * Math.sin((Math.PI * (n.t + startAt)) / beats)));
  }

  // ── Inner harmony ──
  const inner = chosen.inner;
  if (inner.on && inner.inst) {
    const style = picks.inner_style ?? 'sustain';
    const density = picks.inner_density ?? 'three';
    const art: Articulation = style === 'tremolo' ? artFor(inner.inst, 'tremolo') : style === 'pulsed' ? artFor(inner.inst, 'staccato') : 'sustain';
    inner.art = art;
    inner.detail = `${density.replace('_plus', ', top doubled')} voices, ${style}`;
    const base = velOf(inner.dyn);
    const voicesOf = (slot: Slot) => {
      let v = slot.voices.slice().sort((a, b) => a - b);
      if (density === 'two') v = v.slice(-2);
      if (density === 'three_plus') v = [...v, v[v.length - 1] + 12];
      return [...new Set(v.map((x) => fold(x, inner.inst!)))];
    };
    if (style === 'pulsed') {
      for (const slot of draft.slots) {
        for (let t = slot.t; t < slot.t + slot.dur - 1e-6; t += 1) {
          for (const midi of voicesOf(slot)) push('inner', inner.inst, art, t, 0.5, midi, base * (rules.meter.strong.includes(q(t % bar)) ? 1 : 0.82));
        }
      }
    } else {
      // Tie voices that hold across a chord change.
      const open = new Map<number, { t: number; dur: number }>();
      const flush = (midi: number) => {
        const n = open.get(midi);
        if (n) push('inner', inner.inst!, art, n.t, n.dur, midi, base);
        open.delete(midi);
      };
      for (const slot of draft.slots) {
        const now = voicesOf(slot);
        for (const midi of [...open.keys()]) if (!now.includes(midi)) flush(midi);
        for (const midi of now) {
          const held = open.get(midi);
          if (held) held.dur += slot.dur;
          else open.set(midi, { t: slot.t, dur: slot.dur });
        }
      }
      for (const midi of [...open.keys()]) flush(midi);
    }
  }

  // ── Bass ──
  const bass = chosen.bass;
  const bassNotes: { t: number; dur: number; pc: number }[] = [];
  const scale = MODES[key.mode].map((s) => mod(key.tonic + s, 12));
  draft.slots.forEach((slot, k) => {
    const root = mod(key.tonic + slot.chord.root, 12);
    const next = draft.slots[k + 1];
    const nextRoot = next ? mod(key.tonic + next.chord.root, 12) : root;
    if (slot.bass === 'inversion') bassNotes.push({ t: slot.t, dur: slot.dur, pc: mod(root + slot.chord.intervals[1], 12) });
    else if (slot.bass === 'pedal') {
      const prev = bassNotes[bassNotes.length - 1];
      if (prev && prev.pc === key.tonic && Math.abs(prev.t + prev.dur - slot.t) < 1e-6 && k > 0 && draft.slots[k - 1].bass === 'pedal') prev.dur += slot.dur;
      else bassNotes.push({ t: slot.t, dur: slot.dur, pc: key.tonic });
    } else if (slot.bass === 'walk' && slot.dur >= 2) {
      const walkLen = slot.dur >= 4 ? 2 : 1;
      bassNotes.push({ t: slot.t, dur: slot.dur - walkLen, pc: root });
      // Approach the next root by scale step from the nearer side.
      const idx = scale.indexOf(nextRoot);
      const below = idx >= 0 ? scale[mod(idx - 1, 7)] : mod(nextRoot - 2, 12);
      const below2 = idx >= 0 ? scale[mod(idx - 2, 7)] : mod(nextRoot - 4, 12);
      if (walkLen === 2) bassNotes.push({ t: slot.t + slot.dur - 2, dur: 1, pc: below2 });
      bassNotes.push({ t: slot.t + slot.dur - 1, dur: 1, pc: below });
    } else if (slot.bass === 'octave_drop') {
      bassNotes.push({ t: slot.t, dur: slot.dur / 2, pc: root }, { t: slot.t + slot.dur / 2, dur: slot.dur / 2, pc: -1 - root });
    } else bassNotes.push({ t: slot.t, dur: slot.dur, pc: root });
  });
  const bassMidi = (pc: number, inst: InstrumentId, low: boolean) => {
    const drop = pc < 0;
    const real = drop ? -1 - pc : pc;
    const baseOct = low ? 24 : 36;
    let m = pcIn(real, baseOct);
    const [lo] = INSTRUMENTS[inst].range;
    if (drop) m = m - 12 >= lo ? m - 12 : m;
    return fold(m, inst);
  };
  const pulsePattern = picks.pulse_pattern ?? 'downbeats';
  const pulseIntensity = step('pulse_intensity');
  if (bass.on && bass.inst) {
    const low = picks.bass_octave === 'low';
    const rhythm = picks.bass_rhythm ?? 'held';
    bass.art = 'sustain';
    bass.detail = `${[...new Set(draft.slots.map((s) => s.bass.replace('_', ' ')))].join(', ')}${low ? ', low octave' : ''}${rhythm !== 'held' ? `, ${rhythm.replace(/_/g, ' ')}` : ''}`;
    const base = velOf(bass.dyn);
    if (rhythm === 'held') {
      for (const n of bassNotes) push('bass', bass.inst, 'sustain', n.t, n.dur, bassMidi(n.pc, bass.inst, low), base);
    } else {
      // A rhythmic bass: the chord path still says which note; the rhythm says when it is struck.
      const noteAt = (at: number) => bassNotes.find((n) => at >= n.t - 1e-6 && at < n.t + n.dur - 1e-6) ?? bassNotes[bassNotes.length - 1];
      for (let b = 0; b < bars; b++) {
        let hits: number[];
        if (rhythm === 'eighths') hits = Array.from({ length: Math.round(bar * 2) }, (_x, i) => i * 0.5);
        else if (rhythm === 'syncopated') hits = [0, 0.75, 1.5, 2.5, 3, 3.5].filter((x) => x < bar - 1e-6);
        else {
          hits = drumBar(pulsePattern, pulseIntensity, bar, rules.meter.sub, b === bars - 1, b).filter((h) => h.midi === 36).map((h) => h.t);
          if (!hits.length) hits = [0];
        }
        hits = [...new Set(hits.map(q))].sort((x, y) => x - y);
        hits.forEach((h, i) => {
          const at = b * bar + h;
          const until = b * bar + (hits[i + 1] ?? bar);
          const n = noteAt(at);
          const pc = n.pc < 0 ? -1 - n.pc : n.pc;
          const pop = rhythm === 'syncopated' && (Math.abs(h - 1.5) < 1e-6 || Math.abs(h - 3.5) < 1e-6);
          const dur = rhythm === 'with_kick' ? until - at : Math.min(until - at, rhythm === 'eighths' ? 0.42 : 0.5);
          const midi = bassMidi(pc, bass.inst!, low);
          push('bass', bass.inst!, 'sustain', at, dur, pop && midi + 12 <= INSTRUMENTS[bass.inst!].range[1] ? midi + 12 : midi, base * (i === 0 ? 1 : 0.9));
        });
      }
    }
  }

  // ── Pedal ──
  const ped = chosen.pedal;
  if (ped.on && ped.inst) {
    const pc = picks.pedal_note === 'dominant' ? mod(key.tonic + 7, 12) : key.tonic;
    const span = picks.pedal_span === 'half' ? unit : beats;
    const midi = fold(pcIn(pc, ped.inst === 'horn' ? 48 : 36), ped.inst);
    ped.art = 'sustain';
    ped.detail = `${picks.pedal_note ?? 'tonic'}, ${picks.pedal_span === 'half' ? 'two bars' : 'whole phrase'}`;
    push('pedal', ped.inst, 'sustain', 0, span, midi, velOf(ped.dyn));
  }

  // ── Figuration ──
  const fig = chosen.figuration;
  if (fig.on && fig.inst) {
    const perBeat = Number((picks.figuration_speed ?? 'n2').slice(1));
    const pattern = picks.figuration_pattern ?? 'rising';
    const stepLen = 1 / perBeat;
    const strings = fig.inst === 'violins2' || fig.inst === 'violas';
    const art: Articulation = strings ? artFor(fig.inst, 'pizzicato') : fig.inst === 'pluck' ? 'staccato' : 'sustain';
    fig.art = art;
    fig.detail = `${pattern.replace('_', ' ')}, ${perBeat} per beat`;
    const base = velOf(fig.dyn);
    const floor = fig.inst === 'celesta' ? 72 : strings ? 55 : 48;
    for (const slot of draft.slots) {
      const pcs = chordPcs(slot.chord, key);
      const tones: number[] = [];
      for (let m = floor; tones.length < 6 && m < floor + 30; m++) if (pcs.includes(mod(m, 12))) tones.push(m);
      const rootLow = pcIn(mod(key.tonic + slot.chord.root, 12), floor);
      let seq: number[];
      if (pattern === 'rise_fall') seq = [...tones.slice(0, 5), ...tones.slice(1, 4).reverse()];
      else if (pattern === 'broken') seq = [tones[0], tones[2] ?? tones[0], tones[1] ?? tones[0], tones[3] ?? tones[1] ?? tones[0]];
      else if (pattern === 'ostinato') seq = [rootLow, rootLow + 7, rootLow + 12, rootLow + 7];
      else seq = tones.slice(0, 5);
      let i = 0;
      for (let t = slot.t; t < slot.t + slot.dur - 1e-6; t += stepLen, i++) {
        const midi = fold(seq[i % seq.length], fig.inst);
        const onBeat = Math.abs(t - Math.round(t)) < 1e-6;
        const ring = fig.inst === 'harp' ? Math.min(2, slot.t + slot.dur - t) : fig.inst === 'piano' ? Math.max(stepLen, Math.min(1, slot.t + slot.dur - t)) : stepLen;
        push('figuration', fig.inst, art, t, ring, midi, base * (onBeat ? 1 : 0.8));
      }
    }
  }

  // ── Texture ──
  const tex = chosen.texture;
  if (tex.on && tex.inst) {
    const base = velOf(tex.dyn);
    if (tex.inst === 'noise') {
      tex.art = 'sustain';
      tex.detail = 'water and wave swell';
      push('texture', 'noise', 'sustain', 0, beats, 60, base);
    } else if (tex.inst === 'cymbal') {
      tex.art = 'roll';
      tex.detail = 'roll swelling into the phrase end';
      push('texture', 'cymbal', artFor('cymbal', 'roll'), beats - bar, bar, 49, base * 0.8);
    } else {
      const art: Articulation = tex.inst === 'violins' ? artFor('violins', 'tremolo') : 'sustain';
      tex.art = art;
      tex.detail = tex.inst === 'violins' ? 'high tremolo shimmer' : 'slow pad swell';
      for (const slot of draft.slots) {
        const top = slot.voices.slice().sort((a, b) => a - b).slice(-2);
        for (const v of top) {
          let midi = v + 12;
          while (midi < (tex.inst === 'violins' ? 76 : 60)) midi += 12;
          push('texture', tex.inst, art, slot.t, slot.dur, fold(midi, tex.inst), base * 0.85);
        }
      }
    }
  }

  // ── Pulse ──
  const pul = chosen.pulse;
  if (pul.on && pul.inst) {
    const pattern = pulsePattern;
    const intensity = pulseIntensity;
    const gain = velOf(pul.dyn) / velOf(3);
    pul.art = 'hit';
    pul.detail = `${pattern.replace(/_/g, ' ')}, intensity ${intensity + 1}/7`;
    for (let b = 0; b < bars; b++) {
      const t0 = b * bar;
      const hits = drumBar(pattern, intensity, bar, rules.meter.sub, b === bars - 1, b);
      if (pul.inst === 'drumkit') {
        for (const h of hits) push('pulse', 'drumkit', 'hit', t0 + h.t, 0.25, h.midi, h.vel * gain);
      } else if (pul.inst === 'kick808') {
        for (const h of hits.filter((x) => x.midi === 36)) push('pulse', 'kick808', 'hit', t0 + h.t, 0.5, 36, h.vel * gain);
        // The 808 is only a kick: with a drum kit in the palette, the kit plays the snare and hats around it.
        if (rules.palette.includes('drumkit')) for (const h of hits.filter((x) => x.midi !== 36)) push('pulse', 'drumkit', 'hit', t0 + h.t, 0.25, h.midi, h.vel * gain);
      } else {
        // Timpani: strokes on the kick positions, tonic on the downbeat and the dominant elsewhere; a roll for the last bar.
        const tonic = fold(pcIn(key.tonic, 41), 'timpani');
        const dom = fold(pcIn(mod(key.tonic + 7, 12), 41), 'timpani');
        if (pattern === 'roll_to_downbeat' && b === bars - 1) push('pulse', 'timpani', artFor('timpani', 'roll'), t0, bar, dom, 0.5 * gain);
        else for (const h of hits.filter((x) => x.midi === 36)) push('pulse', 'timpani', 'hit', t0 + h.t, 1, h.t < 1e-6 ? tonic : dom, h.vel * gain * 0.9);
      }
    }
  }

  // ── Accents ──
  const acc = chosen.accents;
  let hitAt: number | null = null;
  if (acc.on) {
    const where = picks.accents_where ?? 'phrase_start';
    const cue = piece.picture?.(index) ?? null;
    const snap = (b: number) => clamp(Math.round(b / piece.grid) * piece.grid, 0, beats - piece.grid);
    let t = where === 'bar_3' ? Math.min(2, bars - 1) * bar : where === 'last_bar' ? (bars - 1) * bar : 0;
    if (where === 'video_peak' && cue?.peak) t = snap(cue.peak.beat);
    if (where === 'video_cut' && cue?.cut) t = snap(cue.cut.beat);
    if (where === 'melody_peak' && melodyNotes.length) {
      const top = Math.max(...melodyNotes.map((n) => n.midi));
      t = Math.floor(melodyNotes.find((n) => n.midi === top)!.t + 1e-6);
    }
    hitAt = t;
    const kind = picks.accents_kind ?? 'bass_drum';
    const vel = velOf(acc.dyn);
    const has = (id: InstrumentId) => rules.palette.includes(id);
    const root = mod(key.tonic + chordAt(draft.slots, t).chord.root, 12);
    const used: InstrumentId[] = [];
    const hit = (id: InstrumentId, art: Articulation, at: number, dur: number, midi: number, v: number) => {
      if (!has(id)) return;
      push('accents', id, artFor(id, art), at, dur, midi, v);
      if (!used.includes(id)) used.push(id);
    };
    const all = kind === 'full_hit';
    if (all || kind === 'bass_drum') hit('bass_drum', 'hit', t, 2, 36, vel);
    if (all || kind === 'timpani') hit('timpani', 'hit', t, 2, fold(pcIn(root, 41), 'timpani'), vel);
    if (all || kind === 'low_piano_octave') {
      hit('piano', 'sustain', t, Math.min(4, beats - t), pcIn(root, 24), vel);
      hit('piano', 'sustain', t, Math.min(4, beats - t), pcIn(root, 24) + 12, vel * 0.9);
    }
    if (all || kind === 'tam_tam') hit('tam_tam', 'hit', t, 4, 52, vel * 0.8);
    if (all || kind === 'crash') { hit('drumkit', 'hit', t, 1, 49, vel); hit('drumkit', 'hit', t, 1, 36, vel); }
    if (all) hit('cymbal', 'hit', t, 3, 49, vel * 0.9);
    if (kind === 'cymbal_swell') {
      const start = Math.max(0, t - bar);
      if (t > 0) hit('cymbal', 'roll', start, t - start, 49, vel * 0.8);
      else hit('cymbal', 'roll', 0, bar, 49, vel * 0.8);
    }
    acc.inst = used[0] ?? null;
    acc.on = used.length > 0;
    acc.art = kind === 'cymbal_swell' ? 'roll' : 'hit';
    acc.detail = `${kind.replace(/_/g, ' ')} at ${where.replace(/_/g, ' ')}`;
  }

  // A pause before the hit: everything falls silent for an instant just before it.
  if (acc.on && hitAt !== null && hitAt >= bar && picks.pause_before_hit === 'yes') {
    const from = hitAt - breathBeats(piece, index);
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.layer === 'accents' && n.art === 'roll') continue; // the swell is what fills the breath
      if (n.t >= from - 1e-6 && n.t < hitAt - 1e-6) notes.splice(i, 1);
      else if (n.t < from && n.t + n.dur > from) n.dur = q(from - n.t);
    }
    acc.detail += ', after a pause';
  }

  // ── A dovetailed join: instruments joining steal in a bar early; instruments leaving linger over the first bar ──
  if (picks.join === 'dovetail' && last) {
    const sustainer = (id: InstrumentId | null | undefined): id is InstrumentId => !!id && !INSTRUMENTS[id].synth && INSTRUMENTS[id].arts.includes('sustain') && !['piano', 'harp', 'celesta', 'glockenspiel', 'vibraphone'].includes(id);
    const wasOn = (r: LayerRole) => last.layers.find((l) => l.role === r)?.inst ?? null;
    const heardBefore = new Set(last.score.notes.map((n) => n.inst));
    const usedNow = new Set(notes.map((n) => n.inst));
    const prevChord = last.score.holdChord; // the last chord of the previous phrase: bass first, then the inner voices
    let stole = false;
    let lingered = false;
    if (inner.on && sustainer(inner.inst) && !heardBefore.has(inner.inst) && picks.inner_style !== 'pulsed') {
      for (const h of prevChord.slice(1)) leadIn.push({ t: -bar, dur: bar, midi: fold(h.midi, inner.inst), vel: clamp(velOf(inner.dyn) * 0.55, 0.05, 1), inst: inner.inst, art: 'sustain', layer: 'inner' });
      stole = prevChord.length > 1;
    }
    if (bass.on && sustainer(bass.inst) && !heardBefore.has(bass.inst) && prevChord[0]) {
      leadIn.push({ t: -bar, dur: bar, midi: fold(prevChord[0].midi, bass.inst), vel: clamp(velOf(bass.dyn) * 0.55, 0.05, 1), inst: bass.inst, art: 'sustain', layer: 'bass' });
      stole = true;
    }
    const oldInner = wasOn('inner');
    if (sustainer(oldInner) && !usedNow.has(oldInner) && draft.slots[0]) {
      for (const v of draft.slots[0].voices) push('inner', oldInner, 'sustain', 0, Math.min(bar, draft.slots[0].dur), fold(v, oldInner), 0.3);
      lingered = true;
    }
    const oldBass = wasOn('bass');
    if (sustainer(oldBass) && !usedNow.has(oldBass) && bassNotes[0]) {
      push('bass', oldBass, 'sustain', 0, Math.min(bar, bassNotes[0].dur), bassMidi(bassNotes[0].pc, oldBass, false), 0.32);
      lingered = true;
    }
    if (stole || lingered) remarks.push(`dovetailed join${stole ? ': new instruments steal in a bar early' : ''}${lingered ? `${stole ? ',' : ':'} the old ones linger a bar` : ''}`);
  }

  // ── Texture inside the phrase: instruments need not play all the way through ──
  const keepOnly = (layers: LayerRole[], from: number, to: number) => {
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (!layers.includes(n.layer)) continue;
      const a = Math.max(n.t, from);
      const b = Math.min(n.t + n.dur, to);
      const struck = n.art !== 'sustain' && n.art !== 'tremolo'; // a short note cut off at the front would move its attack
      if (b - a <= 1e-6 || (struck && n.t < from - 1e-6)) notes.splice(i, 1);
      else { n.t = q(a); n.dur = q(b - a); }
    }
  };
  const ACCOMPANIMENT: LayerRole[] = ['counter', 'inner', 'figuration', 'texture', 'pulse'];
  if (picks.texture_shape === 'late_entry') { keepOnly(ACCOMPANIMENT, unit, beats); remarks.push('accompaniment enters at the half'); }
  else if (picks.texture_shape === 'drop_out') { keepOnly(ACCOMPANIMENT, 0, unit); remarks.push('accompaniment drops out at the half'); }
  else if (picks.texture_shape === 'bare_ending') { keepOnly([...ACCOMPANIMENT, 'bass', 'pedal'], 0, beats - bar); remarks.push('melody alone in the last bar'); }

  // ── Entries ──
  for (const r of LAYERS) {
    const c = chosen[r];
    if (!c.on || r === 'accents') continue;
    if (c.entry === 'delayed') {
      for (let i = notes.length - 1; i >= 0; i--) if (notes[i].layer === r && notes[i].t < bar - 1e-6) {
        const n = notes[i];
        if (n.t + n.dur > bar + 0.5 && INSTRUMENTS[n.inst].arts.includes('sustain') && n.art !== 'hit') { n.dur = q(n.t + n.dur - bar); n.t = bar; }
        else notes.splice(i, 1);
      }
    } else if (c.entry === 'fade_in') {
      for (const n of notes) if (n.layer === r && n.t < 1.5 * bar) n.vel = clamp(n.vel * (0.45 + (0.55 * n.t) / (1.5 * bar)), 0.05, 1);
    }
  }

  // ── Piano sustain pedal: change it with the harmony ──
  const pedal: { t: number; down: boolean }[] = [];
  if (notes.some((n) => n.inst === 'piano' && n.art === 'sustain')) {
    draft.slots.forEach((slot, k) => {
      if (k > 0 || last) pedal.push({ t: q(slot.t), down: false });
      pedal.push({ t: q(slot.t + 0.08), down: true });
    });
  }

  const mix: MixState = {
    dynamics: step('overall_dynamics'),
    lowpass: step('fx_lowpass', 5), reverb: step('fx_reverb'), delay: step('fx_delay', 1), noise: step('fx_noise', 0),
    width: step('fx_width'), saturation: step('fx_saturation', 1),
    chorus: picks.fx_chorus === 'yes',
    sidechain: picks.fx_sidechain === 'yes' && notes.some((n) => n.midi === 36 && (n.inst === 'drumkit' || n.inst === 'kick808')),
  };
  if (tex.on && tex.inst === 'noise') mix.noise = Math.max(mix.noise, 2) as Step7;

  // The chord left sounding if the buffer runs dry: bass and inner voices on sustaining instruments.
  const lastSlot = draft.slots[draft.slots.length - 1];
  const sustainers = (r: LayerRole) => ROLE_INSTRUMENTS[r].filter((id) => rules.palette.includes(id) && id !== 'piano');
  const holdInner = (inner.inst && inner.inst !== 'piano' ? inner.inst : sustainers('inner')[0]) ?? sustainers('counter')[0] ?? rules.palette.find((id) => INSTRUMENTS[id].arts.includes('sustain') && !['noise'].includes(id)) ?? 'pad';
  const holdBass = (bass.inst && bass.inst !== 'piano' ? bass.inst : sustainers('bass')[0]) ?? holdInner;
  const lastBass = bassNotes[bassNotes.length - 1];
  const holdChord: HoldNote[] = [
    { midi: bassMidi(lastBass ? lastBass.pc : mod(key.tonic + lastSlot.chord.root, 12), holdBass, false), vel: 0.34, inst: holdBass, art: 'sustain' },
    ...lastSlot.voices.map((v) => ({ midi: fold(v, holdInner), vel: 0.3, inst: holdInner, art: 'sustain' as Articulation })),
  ];

  const layers: LayerSummary[] = LAYERS.map((r) => {
    const c = chosen[r];
    return { role: r, inst: c.on ? c.inst : null, dynamics: c.dyn, art: c.on ? c.art : null, entry: c.entry, detail: c.on ? c.detail : undefined };
  });
  notes.sort((a, b) => a.t - b.t);
  return { notes, pedal, layers, mix, holdChord, remarks, leadIn };
}

/** Length of a held breath in beats: about half a second, at least one subdivision, at most a beat. */
function breathBeats(piece: Piece, index: number): number {
  return clamp(q((0.55 * piece.bpmOf(index)) / 60), piece.rules.meter.sub === 3 ? 1 / 3 : 0.5, 1);
}

/** A breath at the end of a phrase: the given layers (default all) stop `gap` beats before the bar line. The hall still rings. */
function holdBreath(piece: Piece, index: number, w: Written, gap: number, only?: LayerRole[]): void {
  const from = piece.beatsOf(index) - gap;
  for (let i = w.notes.length - 1; i >= 0; i--) {
    const n = w.notes[i];
    if (only && !only.includes(n.layer)) continue;
    if (n.t >= from - 1e-6) w.notes.splice(i, 1);
    else if (n.t + n.dur > from) n.dur = q(from - n.t);
  }
  if (only) return;
  w.pedal = w.pedal.filter((p) => p.t < from);
  if (w.pedal.length) w.pedal.push({ t: q(from), down: false });
}

// ───────────────────────────── The call ─────────────────────────────

export async function orchestrate(ctx: Ctx, index: number, draft: Draft): Promise<PhraseRecord> {
  const { piece, gw } = ctx;
  const { questions, offered } = buildQuestions(ctx, index, draft);
  const arrival = piece.plan.climaxArrival;
  const wall = index === piece.plan.climaxPhrase && isWall(arrival);
  const drop = index === piece.plan.climaxPhrase && arrival === 'drop';
  const bloom = index === piece.plan.climaxPhrase && arrival === 'bloom';
  const breath = index === piece.plan.climaxPhrase - 1 && arrivesAfterBreath(arrival);
  const played = playedFacts(piece);
  // Song form: what the chorus was last time, so Drex can decide how this one differs.
  const chorus = piece.chorusAt(index);
  const chorusLines: string[] = [];
  if (chorus) {
    const firstChorus = piece.plan.sections.find((s) => s.part === 'chorus')!;
    const before = piece.phrases.filter((ph) => piece.sectionOf(ph.index).part === 'chorus' && piece.sectionOf(ph.index) !== piece.sectionOf(index));
    const biggest = before.sort((a, b) => new Set(b.score.notes.map((n) => n.inst)).size - new Set(a.score.notes.map((n) => n.inst)).size)[0];
    chorusLines.push(
      `CHORUS  this phrase is chorus ${chorus.n} of ${chorus.of}${chorus.source !== null ? `: the hook comes back with the melody and chords of phrase ${chorus.source + 1} (the first chorus began at phrase ${firstChorus.first + 1})` : ': the first time the hook is heard in full'}.` +
      (biggest ? ` The fullest chorus phrase so far was phrase ${biggest.index + 1}: ${biggest.layers.filter((l) => l.inst).map((l) => `${l.role} on ${INSTRUMENTS[l.inst!].name}`).join(', ')}, overall ${DYNAMIC_NAMES[biggest.mix.dynamics]}.` : '') +
      (chorus.of > 1 ? (chorus.n === chorus.of ? ' This is the last chorus: it should be the biggest moment of the piece.' : ' A later chorus still has to top this one.') : ''),
    );
  } else if (piece.chorusAt(index + 1)?.starts) chorusLines.push(`NEXT    chorus ${piece.chorusAt(index + 1)!.n} of ${piece.chorusAt(index + 1)!.of} starts with the next phrase.`);
  const levelBefore = lastLevel(piece);
  const ans = await gw.ask({
    callType: 'orchestration', title: `Phrase ${index + 1}: orchestration and mix`,
    state: piece.state('orchestration', index, [
      `ACCEPTED ${notation(draft.line)}   = ${draft.lineage}`,
      `CHORDS  ${draft.slots.map((s) => `${chordName(s.chord, draft.key)} (bass: ${s.bass.replace('_', ' ')})`).join(' | ')}; key ${keyName(draft.key)}`,
      `PALETTE ${piece.rules.palette.map((id) => INSTRUMENTS[id].name).join(', ')}`,
      ...(wall ? [`ARRIVAL this phrase is the climax, and the plan has it arrive as: ${ARRIVAL_LABEL[arrival]}. Already decided by that choice: overall dynamics fff, filter fully open, no pulse and no figuration, everything sustained.`] : []),
      ...(bloom ? ['ARRIVAL this phrase is the climax, and the plan has it arrive as a held breath, then a still, bright clearing. Already decided by that choice: no pulse, no figuration, no counter-melody, no accent, everything sustained, the filter fully open. What makes the moment is stillness, light and the melody singing above held chords, not volume or the number of notes.'] : []),
      ...chorusLines,
      ...(drop ? ['ARRIVAL this phrase is the climax, and the plan has it arrive as the drop. Already decided by that choice: every layer plays, overall dynamics fff, filter fully open.'] : []),
      ...(breath ? [`ARRIVAL the next phrase is the climax, arriving after a held breath: this phrase stops just before its final bar line${arrival === 'drop' ? ', and only the melody plays through its last bar' : ''}.`] : []),
      ...(played ? [played] : []),
    ]),
    questions, picking: 'top',
  });
  // Melody and counter-melody are separate questions. If Drex gives both to the same instrument,
  // the counter-melody goes to its next most probable choice so the two lines stay distinct.
  const picks = ans.picks[0];
  if (drop) picks.density = '6';
  // Density is a floor, never a cap. Every supporting layer Drex said yes to plays; if that is fewer
  // than the density it chose, the layers it rated next most likely fill the remaining places.
  // Layers the phrase direction already calls for (a pedal underlay, an overlapping entry) are in first.
  if (picks.density !== undefined) {
    const flags = draft.direction.flags;
    const supporting = (['counter', 'inner', 'bass', 'pedal', 'figuration', 'texture', 'pulse'] as LayerRole[]).filter((r) => picks[`${r}_in`] !== undefined);
    const called = supporting.filter((r) => (r === 'pedal' && flags.pedal_underlay) || (r === 'counter' && flags.overlap));
    const rest = supporting.filter((r) => !called.includes(r)).sort((a, b) => ans.values[`${b}_in`] - ans.values[`${a}_in`]);
    const places = Number(picks.density) >= 6 ? supporting.length : Number(picks.density);
    const on = new Set<LayerRole>([...called, ...supporting.filter((r) => ans.values[`${r}_in`] >= 0.5), ...rest.slice(0, Math.max(0, places - called.length))]);
    for (const r of supporting) picks[`${r}_in`] = on.has(r) ? 'yes' : 'no';
  }
  // The melody's instrument and register were one question.
  if (picks.melody_voice) [picks.melody_inst, picks.melody_register] = picks.melody_voice.split('__');
  // A doubling instrument has to be a second instrument: if Drex named the melody's own, take its next choice.
  if (picks.melody_double && picks.melody_double === picks.melody_inst) {
    const next = Object.entries(ans.probabilities.melody_double ?? {}).sort((a, b) => b[1] - a[1]).find(([id]) => id !== picks.melody_inst);
    picks.melody_double = next ? next[0] : 'none';
  }
  if (picks.counter_inst && picks.counter_inst === picks.melody_inst && picks.melody_in === 'yes') {
    const next = Object.entries(ans.probabilities.counter_inst ?? {}).sort((a, b) => b[1] - a[1]).find(([id]) => id !== picks.melody_inst);
    if (next) picks.counter_inst = next[0];
  }
  // The wall is what Drex chose in the plan: full volume, the filter fully open.
  if (wall || drop) {
    picks.overall_dynamics = '6';
    picks.fx_lowpass = '6';
  }
  // Song form: the level Drex planned for this kind of part.
  const song = wall || drop ? null : songLevel(piece, index);
  if (song !== null) picks.overall_dynamics = String(song);
  // The clearing: the filter fully open, and the level Drex chose relative to where the last phrase left off.
  if (bloom) {
    picks.overall_dynamics = String(clamp(Math.round(levelBefore ?? 3) + (picks.bloom_level === 'two' ? 2 : picks.bloom_level === 'same' ? 0 : 1), 0, 6));
    picks.fx_lowpass = '6';
  }
  const w = write(ctx, index, draft, picks, ans.values, offered);
  // How the phrase closes: the breath before a wall, or the close Drex chose.
  const bar = piece.rules.meter.beatsPerBar;
  // Before a drop the beat thins first: only the melody plays through the last bar.
  if (breath && arrival === 'drop') holdBreath(piece, index, w, bar, ['counter', 'inner', 'bass', 'pedal', 'figuration', 'texture', 'pulse', 'accents']);
  if (breath) holdBreath(piece, index, w, breathBeats(piece, index));
  else if (picks.phrase_close === 'melody_breathes') { holdBreath(piece, index, w, 1, ['melody']); w.remarks.push('the melody breathes before the bar line'); }
  else if (picks.phrase_close === 'all_breathe') { holdBreath(piece, index, w, breathBeats(piece, index)); w.remarks.push('everyone breathes before the bar line'); }
  else if (picks.phrase_close === 'long_silence') { holdBreath(piece, index, w, bar / 2); w.remarks.push('a long silence closes the phrase'); }
  else if (picks.phrase_close === 'strip_back') { holdBreath(piece, index, w, bar, ['counter', 'inner', 'bass', 'pedal', 'figuration', 'texture', 'pulse', 'accents']); w.remarks.push('the beat drops out for the last bar'); }
  const dynCurve = dynamicCurve(picks.dynamic_shape ?? 'steady', w.mix.dynamics, levelBefore, piece.beatsOf(index));
  if (dynCurve) w.remarks.push(picks.dynamic_shape);
  const holdSec = piece.phraseHoldSec.get(index) ?? 0;
  const section = piece.sectionOf(index);
  const role = piece.roleOf(index);
  const score: PhraseScore = {
    index, section: section.index, role,
    bars: piece.barsOf(index), beatsPerBar: piece.rules.meter.beatsPerBar, beats: piece.beatsOf(index), bpm: piece.bpmOf(index),
    notes: w.notes, pedal: w.pedal, mix: w.mix, holdChord: w.holdChord,
    ...(dynCurve ? { dynCurve } : {}),
    display: {
      key: keyName(draft.key),
      notation: notation(draft.line),
      lineage: `phrase ${index + 1} = ${draft.lineage}${wall || drop || bloom ? `; the climax arrives: ${ARRIVAL_LABEL[arrival]}` : breath ? '; ends on a held breath' : ''}${w.remarks.length ? `; ${w.remarks.join(', ')}` : ''}`,
      chords: draft.slots.map((s) => chordName(s.chord, draft.key)),
      layers: w.layers,
      tension: piece.tensionOf(index),
    },
  };
  // Fitting to picture: the last chord is held so the next phrase lands on the cut.
  if (holdSec > 0) linger(score, (holdSec * score.bpm) / 60);
  return {
    index, section: section.index, role, key: draft.key, direction: draft.direction, line: draft.line,
    lineage: draft.lineage, depth: draft.depth, slots: draft.slots, themeIntact: draft.intact, related: draft.related,
    layers: w.layers, mix: w.mix, score,
    close: breath ? 'breath' : picks.phrase_close ?? 'run_on', start: picks.melody_start ?? 'downbeat', join: picks.join ?? 'clean',
    ...(w.leadIn.length ? { leadIn: w.leadIn } : {}),
  };
}

export { DYNAMIC_NAMES, lineLength, pitched };
