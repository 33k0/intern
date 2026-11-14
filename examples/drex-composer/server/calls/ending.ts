// Hold and ending calls.
//  - Hold: when the buffer runs dry the last chord sustains, and Drex chooses how it evolves. Nothing loops.
//  - Ending: at the last section Drex chooses how the piece closes; code applies it to the final phrase.

import type { HoldNote, HoldUpdate, MixState, PhraseScore, Step7 } from '../../shared/types.ts';
import { DYNAMIC_LEVELS, type Ctx } from '../context.ts';
import { clamp, mod } from '../core/rng.ts';
import { chordPcs, midiName } from '../core/theory.ts';
import type { ChoiceOption } from '../gateway/gateway.ts';
import { INSTRUMENTS, type PhraseRecord } from '../piece.ts';

const opt = (key: string, label: string, criteria: string, prior = 0): ChoiceOption => ({ key, label, criteria, prior });

// ───────────────────────────── Hold ─────────────────────────────

export interface HoldState {
  notes: HoldNote[];
  mix: MixState;
  history: string[];
  startedAt: number;
}

export function startHold(after: PhraseRecord): HoldState {
  return { notes: after.score.holdChord.map((n) => ({ ...n })), mix: { ...after.mix }, history: [], startedAt: Date.now() };
}

export async function holdStep(ctx: Ctx, hold: HoldState, after: PhraseRecord): Promise<HoldUpdate> {
  const { piece, gw } = ctx;
  const key = after.key;
  const chord = after.slots[after.slots.length - 1].chord;
  const pcs = chordPcs(chord, key);
  const sorted = hold.notes.slice().sort((a, b) => a.midi - b.midi);
  const top = sorted[sorted.length - 1];
  const bottom = sorted[0];
  const recent = (k: string) => (hold.history.slice(-2).includes(k) ? -1.6 : hold.history.includes(k) ? -0.5 : 0);
  const seconds = Math.round((Date.now() - hold.startedAt) / 1000);

  let above = top.midi + 1;
  while (!pcs.includes(mod(above, 12))) above++;
  const canAdd = hold.notes.length < 7 && above <= INSTRUMENTS[top.inst].range[1];
  const canDrop = hold.notes.length > 3;
  const canDeepen = bottom.midi - 12 >= INSTRUMENTS[bottom.inst].range[0];
  const strings = hold.notes.some((n) => INSTRUMENTS[n.inst].arts.includes('tremolo') && n.art !== 'tremolo');
  const loud = Math.max(...hold.notes.map((n) => n.vel));

  const options: ChoiceOption[] = [
    ...(canAdd ? [opt('add_voice_above', 'add a voice above', `add ${midiName(above, key)} above the top voice: the chord opens upward, brighter`, 0.9 + recent('add_voice_above'))] : []),
    ...(canDrop ? [opt('drop_voice', 'drop a voice', 'let a middle voice fall away: thinner, more fragile', 0.5 + recent('drop_voice'))] : []),
    opt('swell', 'swell', 'swell: every voice grows louder, as if drawing breath', (loud < 0.6 ? 0.9 : -0.8) + recent('swell')),
    opt('fade', 'fade', 'fade: every voice recedes', (loud > 0.3 ? 0.6 : -1) + recent('fade')),
    opt('open_filter', 'open the filter', 'open the low-pass filter: the sound surfaces, clearer and brighter', (hold.mix.lowpass < 6 ? 0.7 : -3) + recent('open_filter')),
    opt('close_filter', 'close the filter', 'close the low-pass filter: the sound sinks under water', (hold.mix.lowpass > 1 ? 0.5 : -3) + recent('close_filter')),
    opt('revoice_up', 'revoice upward', 'the lowest inner voice moves up an octave: the same chord in a lighter spacing', 0.6 + recent('revoice_up')),
    ...(strings ? [opt('shimmer', 'tremolo shimmer', 'the upper voices break into tremolo: the stillness starts to tremble', 0.6 + recent('shimmer'))] : []),
    ...(canDeepen ? [opt('deepen', 'deepen the bass', 'the bass drops an octave: more gravity under the chord', 0.5 + recent('deepen'))] : []),
  ];

  const ans = await gw.ask({
    callType: 'hold', title: 'Hold: how the sustain evolves',
    state: piece.state('hold', after.index + 1, [
      `HOLD    playback is holding after phrase ${after.index + 1} while drafts are rejected and redrawn; held for ${seconds} s`,
      `SOUNDING ${sorted.map((n) => `${midiName(n.midi, key)} ${INSTRUMENTS[n.inst].name}${n.art !== 'sustain' ? ` ${n.art}` : ''}`).join(', ')}`,
      `SO FAR  ${hold.history.length ? hold.history.join(', ') : 'nothing yet'}`,
    ]),
    questions: [{
      id: 'evolve', type: 'choice', label: 'How the hold evolves',
      instructions: 'The last chord is being held. How should the sustain change next? It must keep evolving and never loop.',
      options,
    }],
    picking: 'top',
    // Playback is waiting on this answer; it goes ahead of queued drafting calls.
    priority: true,
  });
  const action = ans.picks[0].evolve;
  hold.history.push(action);

  let notes = hold.notes.map((n) => ({ ...n }));
  const mix: Partial<MixState> = {};
  const bump = (v: number, d: number) => clamp(v + d, 0, 6) as Step7;
  switch (action) {
    case 'add_voice_above': notes.push({ ...top, midi: above, vel: top.vel * 0.9 }); break;
    case 'drop_voice': {
      const mid = notes.slice().sort((a, b) => a.midi - b.midi)[Math.floor(notes.length / 2)];
      notes = notes.filter((n) => n !== mid && !(n.midi === mid.midi && n.inst === mid.inst));
      break;
    }
    case 'swell': notes = notes.map((n) => ({ ...n, vel: clamp(n.vel * 1.3, 0.1, 0.8) })); break;
    case 'fade': notes = notes.map((n) => ({ ...n, vel: clamp(n.vel * 0.72, 0.1, 0.8) })); break;
    case 'open_filter': mix.lowpass = bump(hold.mix.lowpass, 1); break;
    case 'close_filter': mix.lowpass = bump(hold.mix.lowpass, -1); break;
    case 'revoice_up': {
      const inner = notes.slice().sort((a, b) => a.midi - b.midi)[1] ?? notes[0];
      inner.midi = Math.min(inner.midi + 12, INSTRUMENTS[inner.inst].range[1]);
      break;
    }
    case 'shimmer': {
      const upper = notes.slice().sort((a, b) => b.midi - a.midi).filter((n) => INSTRUMENTS[n.inst].arts.includes('tremolo')).slice(0, 2);
      for (const n of upper) n.art = 'tremolo';
      break;
    }
    case 'deepen': notes.push({ ...bottom, midi: bottom.midi - 12, vel: bottom.vel * 0.9 }); break;
  }
  hold.notes = notes;
  Object.assign(hold.mix, mix);
  const label = options.find((o) => o.key === action)!.label;
  return { action, label, notes, mix, overSec: 2.5 };
}

// ───────────────────────────── Ending ─────────────────────────────

export async function chooseEnding(ctx: Ctx, phrase: number): Promise<void> {
  const { piece, gw } = ctx;
  const { ending, style } = piece.rules;
  const m = piece.mood;
  const ans = await gw.ask({
    callType: 'ending', title: 'Ending: how the piece closes',
    state: piece.state('ending', phrase, [`ENDING  the rules set at the start say the piece ends: ${ending.replace(/_/g, ' ')}`]),
    questions: [
      {
        id: 'slow_down', type: 'choice', label: 'Slowing down',
        instructions: 'How should the tempo behave in the final bars?',
        options: [
          opt('none', 'in tempo', 'in tempo to the last note: matter-of-fact, or a clean cut', ending === 'sudden_stop' ? 2.5 : style === 'beat_driven' ? 1.2 : 0),
          opt('slight', 'slight', 'a slight easing over the last bar: a natural breath', ending === 'fade' ? 1 : 0.8),
          opt('broad', 'broad', 'a broad slowing across the last two bars: weight, finality or reluctance', ending === 'resolved' || ending === 'suspended' ? 1.1 + (1 - m.energy) * 0.6 : -0.5),
        ],
      },
      {
        id: 'final_gesture', type: 'choice', label: 'Final gesture',
        instructions: 'What should be left sounding in the last bar?',
        options: [
          opt('full', 'full texture', 'everything that is playing: a full close', ending === 'sudden_stop' ? 1.5 : 0.6 + m.size * 0.6),
          opt('melody_and_bass', 'melody and bass', 'only melody and bass: the outline of the piece, bare', 0.6),
          opt('melody_alone', 'melody alone', 'the melody alone: a single voice has the last word', ending === 'suspended' ? 1.1 : 0.4 + (1 - m.size) * 0.6),
        ],
      },
      {
        id: 'linger', type: 'choice', label: 'Last chord',
        instructions: 'How long should the last sound be held?',
        options: [
          opt('short', 'short', 'short: it ends and is gone', ending === 'sudden_stop' ? 3 : 0),
          opt('bar', 'one extra bar', 'held for an extra bar', 1),
          opt('long', 'two extra bars', 'held for two extra bars: a long fermata', ending === 'suspended' || ending === 'fade' ? 1.2 : 0.6),
        ],
      },
      {
        id: 'final_dynamic', type: 'score', label: 'Final dynamic',
        instructions: 'How loud is the very end?',
        levels: DYNAMIC_LEVELS,
        prior: ending === 'sudden_stop' ? 4.5 : ending === 'fade' ? 0.5 : ending === 'suspended' ? 1.2 : 2 + m.size * 2,
        spread: 0.7,
      },
    ],
    picking: 'top',
  });
  piece.endingPlan = ans.picks[0];
}

/** Hold the last sounds of a phrase for `extra` beats past its bar line. */
export function linger(score: PhraseScore, extra: number): void {
  if (extra <= 0) return;
  const end = score.beats;
  for (const n of score.notes) {
    const sustains = n.art === 'sustain' || n.art === 'tremolo';
    if (sustains && n.layer !== 'pulse' && Math.abs(n.t + n.dur - end) < 0.02) n.dur += extra;
  }
  score.beats = end + extra;
}

/** Apply the ending to the last phrase. */
export function applyEnding(ctx: Ctx, record: PhraseRecord): void {
  const { piece } = ctx;
  const plan = piece.endingPlan ?? { slow_down: 'slight', final_gesture: 'full', linger: 'bar', final_dynamic: '2' };
  const score: PhraseScore = record.score;
  const bar = score.beatsPerBar;
  const end = score.beats;
  const lastBar = end - bar;
  const ending = piece.rules.ending;
  score.final = true;

  // Final gesture: thin the last bar.
  if (plan.final_gesture !== 'full') {
    const keep = plan.final_gesture === 'melody_alone' ? ['melody'] : ['melody', 'bass'];
    score.notes = score.notes.filter((n) => n.t < lastBar - 1e-6 || keep.includes(n.layer));
    for (const n of score.notes) if (!keep.includes(n.layer) && n.t + n.dur > lastBar) n.dur = Math.max(0.25, lastBar - n.t);
  }

  // Final dynamic: scale the last bar toward it.
  const target = 0.2 + Number(plan.final_dynamic) * 0.118;
  for (const n of score.notes) {
    if (n.t >= lastBar - 1e-6) n.vel = clamp(n.vel * 0.4 + target * 0.6, 0.05, 1);
  }

  if (ending === 'sudden_stop') {
    const cut = lastBar + 1;
    score.notes = score.notes.filter((n) => n.t < cut - 1e-6);
    for (const n of score.notes) if (n.t + n.dur > cut) n.dur = cut - n.t;
    score.cutAtBeat = cut;
    score.pedal.push({ t: cut, down: false });
    return;
  }

  // Lingering: the last sounds are held past the bar line.
  const extra = plan.linger === 'long' ? 2 * bar : plan.linger === 'bar' ? bar : 0;
  linger(score, extra);
  if (plan.slow_down !== 'none') {
    score.ritardando = plan.slow_down === 'broad'
      ? { fromBeat: end - 2 * bar, toBpm: Math.round(score.bpm * 0.6) }
      : { fromBeat: lastBar, toBpm: Math.round(score.bpm * 0.8) };
  }
  if (ending === 'fade') score.fadeOut = { fromBeat: Math.max(0, end - 2 * bar), toBeat: score.beats };
  score.pedal.push({ t: score.beats, down: false });
}
