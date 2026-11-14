// Run with: npx tsx --test web/src/state.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallType, CallView, DraftView, PhraseScore, PlanView, RulesView, ServerEvent,
} from '../../shared/types';
import {
  CALL_LOG_LIMIT, CONNECTION_LOST, initialState, lineageChain, reduce, rejectedPhrases, rejectedRoundCount,
  shouldFeature, soundingScore, type Action, type PanelState,
} from './state';

function run(actions: Action[], from: PanelState = initialState()): PanelState {
  return actions.reduce(reduce, from);
}

const session = (id = 's1', prompt = 'rain on a tin roof', standin = true): ServerEvent => ({
  type: 'session', id, prompt, standin, model: standin ? 'local stand-in' : 'drex-max', seed: 7,
});

const rules: RulesView = {
  style: 'bittersweet_orchestral', styleName: 'Bittersweet orchestral', bpm: 66, meter: '4/4', keyName: 'D',
  mode: 'dorian', harmonicLanguage: 'sevenths', palette: ['piano', 'celli'], soundWorld: 'large_hall',
  lengthSec: 90, form: 'arch', ending: 'suspended', keyPlan: 'relative',
};

const plan = (revised: boolean, departureTension: number, climax: number): PlanView => ({
  sections: [
    { index: 0, role: 'statement', tension: 2, departure: false, phrases: [0, 2], keyName: 'D dorian' },
    { index: 1, role: 'departure', tension: departureTension, departure: true, phrases: [3, 5], keyName: 'F major' },
    { index: 2, role: 'climax', tension: 7, departure: false, phrases: [6, 8], keyName: 'D dorian' },
  ],
  totalPhrases: 9, climaxPhrase: climax, phraseSec: 7.2, revised,
});

const draft = (id: string): DraftView => ({
  id, notation: 'D4q F4e A4e', lineage: `variant ${id}`, notes: [{ midi: 62, t: 0, dur: 1 }],
});

const phraseScore = (index: number, lineage: string, final = false): PhraseScore => ({
  index, section: 0, role: 'statement', bars: 2, beatsPerBar: 4, beats: 8, bpm: 66,
  notes: [{ t: 0, dur: 1, midi: 62, vel: 0.6, inst: 'piano', art: 'sustain', layer: 'melody' }],
  pedal: [],
  mix: { dynamics: 2, lowpass: 5, reverb: 4, delay: 1, noise: 0, width: 3, saturation: 1, chorus: false, sidechain: false },
  holdChord: [{ midi: 50, vel: 0.5, inst: 'celli', art: 'sustain' }],
  final: final || undefined,
  display: { key: 'D dorian', notation: 'D4q F4e A4e', lineage, chords: ['Dm7', 'G7'], layers: [], tension: 2 },
});

const call = (id: number, callType: CallType, at: number, questions = 1): CallView => ({
  id, callType, title: `${callType} ${id}`, at, model: 'drex-max', standin: false, ms: 300,
  questions: Array.from({ length: questions }, (_, i) => ({
    id: `q${i}`, type: 'noul' as const, label: 'q', probabilities: { yes: 0.7 }, picked: ['yes'], picking: 'top' as const,
  })),
});

const phraseDrafts = (phrase: number, round: number, picked: string | null): ServerEvent => ({
  type: 'phrase_drafts', phrase, round, drafts: [draft('a'), draft('b'), draft('c')],
  verdict: { picked, reason: picked ? 'b keeps the motif' : 'all three lose the motif', probabilities: { a: 0.2, b: 0.5, c: 0.1, none: 0.2 } },
});

test('a session starts a run and carries the stand-in flag', () => {
  const s = run([{ type: 'local/compose', prompt: 'rain on a tin roof' }, session()]);
  assert.equal(s.phase, 'running');
  assert.equal(s.session?.standin, true);
  assert.equal(s.pendingPrompt, null);
});

test('run events before a session are ignored', () => {
  const s = run([{ type: 'rules', rules }, { type: 'phrase', score: phraseScore(0, 'A') }]);
  assert.equal(s.rules, null);
  assert.equal(s.composedThrough, -1);
});

test('a rejected round is recorded, then the accepted round follows it', () => {
  const s = run([
    session(),
    phraseDrafts(3, 1, null),
    phraseDrafts(3, 2, 'b'),
    phraseDrafts(4, 1, 'a'),
  ]);
  assert.equal(s.phraseRounds[3].length, 2);
  assert.equal(s.phraseRounds[3][0].rejected, true);
  assert.equal(s.phraseRounds[3][0].verdict.picked, null);
  assert.equal(s.phraseRounds[3][1].rejected, false);
  assert.deepEqual(rejectedPhrases(s), [3]);
  assert.equal(rejectedRoundCount(s), 1);
  // The drafts view follows the newest round.
  assert.equal(s.focusRound?.phrase, 4);
  assert.equal(s.focusRound?.seq, 3);
  // ...but the rejection stays available to point at.
  assert.equal(s.lastRejection?.phrase, 3);
  assert.equal(s.lastRejection?.round, 1);
});

test('the drafts view shows a rejection while it is the latest round', () => {
  const s = run([session(), phraseDrafts(3, 1, null)]);
  assert.equal(s.focusRound?.rejected, true);
  assert.equal(s.focusRound?.verdict.reason, 'all three lose the motif');
});

test('theme rounds and accepted themes are kept separately', () => {
  const s = run([
    session(),
    { type: 'theme_drafts', themeId: 'A', round: 1, drafts: [draft('t1'), draft('t2')], verdict: { picked: null, reason: 'too plain', probabilities: {} } },
    { type: 'theme_drafts', themeId: 'A', round: 2, drafts: [draft('t1'), draft('t2')], verdict: { picked: 't2', reason: 'memorable', probabilities: {} } },
    { type: 'theme', theme: { id: 'A', kind: 'main', notation: 'D4q', contour: 'arch', notes: [] } },
    { type: 'theme', theme: { id: 'A', kind: 'main', notation: 'D4q F4q', contour: 'arch', notes: [] } },
  ]);
  assert.equal(s.themeRounds.length, 2);
  assert.equal(s.themeRounds[0].rejected, true);
  assert.equal(rejectedRoundCount(s), 1);
  assert.equal(s.themes.length, 1);
  assert.equal(s.themes[0].notation, 'D4q F4q');
});

test('a plan revision replaces the plan and keeps the old one for the ghost curve', () => {
  const first = plan(false, 5, 7);
  const second = plan(true, 3, 8);
  const s = run([session(), { type: 'plan', plan: first }, { type: 'plan', plan: second }]);
  assert.equal(s.plan, second);
  assert.equal(s.previousPlan, first);
  assert.equal(s.planRevisions, 1);
  assert.equal(s.plan?.sections[1].tension, 3);
  assert.equal(s.plan?.climaxPhrase, 8);
});

test('the first plan is not a revision, and an identical re-send is not one either', () => {
  const first = plan(false, 5, 7);
  const s = run([session(), { type: 'plan', plan: first }, { type: 'plan', plan: plan(false, 5, 7) }]);
  assert.equal(s.planRevisions, 0);
  assert.equal(s.previousPlan, null);
});

test('phrases are keyed by index, and the now views follow the engine rather than composition', () => {
  let s = run([
    session(),
    { type: 'phrase', score: phraseScore(0, 'A') },
    { type: 'phrase', score: phraseScore(1, 'A, answered a step lower') },
    { type: 'phrase', score: phraseScore(2, 'A, sequenced up a third') },
  ]);
  assert.deepEqual(Object.keys(s.phrases), ['0', '1', '2']);
  assert.equal(s.composedThrough, 2);
  assert.equal(s.nowIndex, null);
  assert.equal(soundingScore(s), null);

  s = run([{ type: 'local/engine', event: { type: 'phrase_started', index: 0 } }], s);
  assert.equal(s.nowIndex, 0);
  assert.equal(soundingScore(s)?.display.lineage, 'A');

  const chain = lineageChain(s);
  assert.deepEqual(chain.map((c) => c.index), [2, 1, 0]);
  assert.equal(chain[2].sounding, true);
  assert.equal(chain[0].ahead, true);
});

test('holds are tracked from the engine, with the sustain updates from the server', () => {
  let s = run([
    session(),
    { type: 'phrase', score: phraseScore(0, 'A') },
    { type: 'local/engine', event: { type: 'phrase_started', index: 0 } },
    { type: 'local/engine', event: { type: 'hold_started', afterIndex: 0 } },
    { type: 'hold_update', update: { action: 'add_ninth', label: 'Add the ninth above', notes: [], overSec: 2 } },
  ]);
  assert.equal(s.hold.active, true);
  assert.equal(s.hold.afterIndex, 0);
  assert.equal(s.hold.updates.length, 1);
  assert.deepEqual(s.holdsAfter, [0]);

  s = run([{ type: 'local/engine', event: { type: 'hold_ended' } }], s);
  assert.equal(s.hold.active, false);
  assert.equal(s.hold.count, 1);
});

test('the call log is capped and a judge call keeps the big view over quick note calls', () => {
  const events: Action[] = [session()];
  for (let i = 1; i <= CALL_LOG_LIMIT + 15; i++) events.push({ type: 'call', call: call(i, 'theme_note', i * 400) });
  let s = run(events);
  assert.equal(s.calls.length, CALL_LOG_LIMIT);
  assert.equal(s.calls[s.calls.length - 1].id, CALL_LOG_LIMIT + 15);

  const judge = call(500, 'phrase_judge', 100000);
  s = run([{ type: 'call', call: judge }], s);
  assert.equal(s.featured?.id, 500);
  // 400 ms later a note-level call arrives: logged, but the verdict stays featured.
  s = run([{ type: 'call', call: call(501, 'voice_leading', 100400) }], s);
  assert.equal(s.featured?.id, 500);
  assert.equal(s.calls[s.calls.length - 1].id, 501);
  // Once the verdict has had its moment, the next call takes over.
  s = run([{ type: 'call', call: call(502, 'voice_leading', 103000) }], s);
  assert.equal(s.featured?.id, 502);

  assert.equal(shouldFeature(null, judge), true);
  // Another top-rank call is never skipped, however soon it comes.
  assert.equal(shouldFeature(judge, call(503, 'setup', 100100)), true);
  // Routine calls of equal rank take turns: each gets time to be read.
  const direction = call(600, 'phrase_direction', 200000);
  assert.equal(shouldFeature(direction, call(601, 'chord_path', 200500)), false);
  assert.equal(shouldFeature(direction, call(602, 'chord_path', 201300)), true);
  assert.equal(shouldFeature(direction, call(603, 'phrase_judge', 200100)), true);
});

test('the run finishes only when the server is done and the engine has played out', () => {
  let s = run([
    session(),
    { type: 'phrase', score: phraseScore(0, 'A', true) },
    { type: 'local/engine', event: { type: 'phrase_started', index: 0 } },
    { type: 'done' },
  ]);
  assert.equal(s.phase, 'running');
  s = run([{ type: 'local/engine', event: { type: 'ended' } }], s);
  assert.equal(s.phase, 'finished');

  // Order reversed: engine ends first, then the server says done.
  s = run([
    session(),
    { type: 'phrase', score: phraseScore(0, 'A', true) },
    { type: 'local/engine', event: { type: 'ended' } },
  ]);
  assert.equal(s.phase, 'running');
  s = run([{ type: 'done' }], s);
  assert.equal(s.phase, 'finished');
});

test('a new prompt and its session reset every run view', () => {
  const full = run([
    { type: 'local/conn', conn: 'open' },
    { type: 'local/audio', mode: 'real' },
    session('s1', 'rain on a tin roof', false),
    { type: 'rules', rules },
    { type: 'plan', plan: plan(false, 5, 7) },
    { type: 'backdrop', id: 'b', file: 'rain.jpg', mood: 'rain' },
    { type: 'call', call: call(1, 'setup', 100, 12) },
    phraseDrafts(0, 1, null),
    { type: 'phrase', score: phraseScore(0, 'A') },
    { type: 'local/instruments', loaded: 2, total: 2, ready: true },
    { type: 'local/engine', event: { type: 'phrase_started', index: 0 } },
    { type: 'stats', calls: 40, callsLastMinute: 40, rejects: 1, holds: 0, composed: 1 },
    { type: 'error', message: 'boom' },
  ]);
  assert.equal(full.stats.calls, 40);
  assert.equal(full.audio.instrumentsReady, true);

  const composing = run([{ type: 'local/compose', prompt: 'a robot learning to dance' }], full);
  assert.equal(composing.phase, 'starting');
  assert.equal(composing.pendingPrompt, 'a robot learning to dance');
  assert.equal(composing.rules, null);
  assert.equal(composing.plan, null);
  assert.equal(composing.backdrop, null);
  assert.equal(composing.calls.length, 0);
  assert.equal(composing.featured, null);
  assert.deepEqual(composing.phrases, {});
  assert.deepEqual(composing.phraseRounds, {});
  assert.equal(composing.focusRound, null);
  assert.equal(composing.lastRejection, null);
  assert.equal(composing.nowIndex, null);
  assert.equal(composing.error, null);
  assert.equal(composing.stats.calls, 0);
  assert.equal(composing.audio.instrumentsReady, false);
  // Connection and engine state belong to the page, not the run.
  assert.equal(composing.conn, 'open');
  assert.equal(composing.audio.mode, 'real');

  // A straggler from the old run arrives before the new session: it must not leak in.
  const straggler = run([{ type: 'phrase', score: phraseScore(1, 'old run') }], composing);
  assert.deepEqual(straggler.phrases, {});

  const next = run([session('s2', 'a robot learning to dance', false)], straggler);
  assert.equal(next.phase, 'running');
  assert.equal(next.session?.id, 's2');
  assert.equal(next.composedThrough, -1);
});

test('stop freezes the run and ignores what the server sends afterwards', () => {
  let s = run([session(), { type: 'phrase', score: phraseScore(0, 'A') }, { type: 'local/stopped' }]);
  assert.equal(s.phase, 'stopped');
  s = run([{ type: 'phrase', score: phraseScore(1, 'late') }, { type: 'done' }], s);
  assert.equal(s.composedThrough, 0);
  assert.equal(s.phase, 'stopped');
});

test('losing the socket mid-run is reported, and the note clears on reconnect', () => {
  let s = run([{ type: 'local/conn', conn: 'open' }, session(), { type: 'local/conn', conn: 'reconnecting' }]);
  assert.equal(s.error, CONNECTION_LOST);
  assert.equal(s.phase, 'running');
  s = run([{ type: 'local/conn', conn: 'open' }], s);
  assert.equal(s.error, null);
  // Idle page: a reconnect is not an error.
  const idle = run([{ type: 'local/conn', conn: 'open' }, { type: 'local/conn', conn: 'reconnecting' }]);
  assert.equal(idle.error, null);
});

test('a fatal status ends the run and keeps its message', () => {
  const s = run([session(), { type: 'error', message: 'gateway refused the key' }, { type: 'status', stage: 'error', message: 'stopped' }]);
  assert.equal(s.phase, 'error');
  assert.equal(s.error, 'gateway refused the key');
});

test('a non-fatal error shows until the next status update', () => {
  let s = run([session(), { type: 'error', message: 'one call timed out, retrying' }]);
  assert.equal(s.error, 'one call timed out, retrying');
  assert.equal(s.phase, 'running');
  s = run([{ type: 'status', stage: 'composing', message: 'Composing phrase 3' }], s);
  assert.equal(s.error, null);
  assert.equal(s.message, 'Composing phrase 3');
});
