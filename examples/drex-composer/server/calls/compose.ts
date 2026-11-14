// The phrase loop's outer shell, shared by every way of running the engine.

import type { Ctx } from '../context.ts';
import { notation, q } from '../core/line.ts';
import { chordName } from '../core/theory.ts';
import type { PhraseRecord } from '../piece.ts';
import { applyEnding } from './ending.ts';
import { orchestrate } from './orchestrate.ts';
import { draftRound, type Draft } from './phrase.ts';

/** A chorus that has been heard before is not composed again: the hook comes back with the melody and chords of the first chorus. */
function chorusDraft(ctx: Ctx, index: number): Draft | null {
  const { piece } = ctx;
  const src = piece.chorusAt(index)?.source;
  const from = src === null || src === undefined ? undefined : piece.phrases[src];
  if (!from) return null;
  const key = piece.sectionOf(index).key;
  // Chords are stored relative to the key; the inner voices are real pitches, so they move with a change of key.
  let shift = (((key.tonic - from.key.tonic) % 12) + 12) % 12;
  if (shift > 6) shift -= 12;
  piece.phraseBars.set(index, from.score.bars);
  const lineage = `the chorus again (phrase ${from.index + 1}): ${from.lineage}`;
  const draft: Draft = {
    id: 'chorus', direction: from.direction, key, line: from.line.map((n) => ({ ...n })), lineage, depth: from.depth, intact: from.themeIntact,
    related: from.related, slots: from.slots.map((s) => ({ ...s, voices: s.voices.map((v) => v + shift) })), facts: [], quality: 0, failure: '',
  };
  ctx.emit({
    type: 'phrase_drafts', phrase: index, round: 1,
    drafts: [{ id: 'chorus', notation: notation(draft.line), lineage, chords: draft.slots.map((s) => chordName(s.chord, key)), notes: [], facts: [{ label: 'chorus', value: `same melody and chords as phrase ${from.index + 1}` }] }],
    verdict: { picked: 'chorus', reason: 'The chorus returns: composed once, played again. Only its orchestration is decided anew.', probabilities: { chorus: 1 } },
  });
  return draft;
}

/**
 * Compose one phrase: redraft until the judge accepts (no cap), orchestrate, and add it to the piece.
 * `onReject` is called after each rejected round; return false from `keepGoing` to abandon.
 *
 * A phrase may begin before its own bar line (a pickup, instruments stealing in early): those notes
 * are written into the end of the phrase before it, so that phrase is only final once this one exists.
 */
export async function composePhrase(ctx: Ctx, index: number, onReject?: () => void, keepGoing: () => boolean = () => true): Promise<PhraseRecord | null> {
  const { piece } = ctx;
  let accepted = chorusDraft(ctx, index);
  for (let round = 1; !accepted && keepGoing(); round++) {
    accepted = await draftRound(ctx, index, round);
    if (!accepted) onReject?.();
  }
  if (!accepted) return null;
  const record = await orchestrate(ctx, index, accepted);
  if (index === piece.plan.totalPhrases - 1) applyEnding(ctx, record);
  const prev = piece.phrases[piece.phrases.length - 1];
  if (prev && record.leadIn?.length) {
    const end = prev.score.beats;
    const start = end + Math.min(...record.leadIn.map((n) => n.t));
    for (const lead of record.leadIn) {
      // The instrument that leads in lets go of whatever it was still holding.
      for (const n of prev.score.notes) if (n.inst === lead.inst && n.t < start && n.t + n.dur > start) n.dur = q(start - n.t);
      if (end + lead.t >= 0) prev.score.notes.push({ ...lead, t: q(end + lead.t) });
    }
    prev.score.notes.sort((a, b) => a.t - b.t);
  }
  piece.phrases.push(record);
  piece.voices = record.slots[record.slots.length - 1].voices.slice();
  piece.lastChord = record.slots[record.slots.length - 1].chord;
  piece.lastReject = '';
  return record;
}
