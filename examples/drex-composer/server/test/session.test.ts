// The live session's pacing and hold loop, driven by a pretend browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerEvent } from '../../shared/types.ts';
import { Session } from '../session.ts';

process.env.STANDIN_LATENCY_MS = '0-0';
delete process.env.NACE_API_KEY;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms: number) {
  const t0 = Date.now();
  while (!check() && Date.now() - t0 < ms) await sleep(20);
  return check();
}

test('composing waits for the player, and a dry buffer gets an evolving hold', async () => {
  const events: ServerEvent[] = [];
  const session = new Session({ prompt: 'rain on a tin roof at 3am, missing someone', seed: 7, paced: true, send: (e) => events.push(e) });
  const run = session.run();
  const phrases = () => events.filter((e) => e.type === 'phrase').length;

  // The look-ahead buffer holds three phrases; nothing more is composed until playback moves on.
  assert.ok(await until(() => phrases() === 3, 5000), 'three phrases buffered');
  await sleep(250);
  assert.equal(phrases(), 3, 'composing pauses while the buffer is full');

  session.onClient({ type: 'phrase_started', index: 0 });
  assert.ok(await until(() => phrases() === 4, 5000), 'one phrase played, one more composed');

  // The browser reports that the buffer ran dry after phrase 1: Drex chooses how the sustain evolves.
  session.onClient({ type: 'hold_started', afterIndex: 0 });
  assert.ok(await until(() => events.some((e) => e.type === 'hold_update'), 6000), 'a hold update arrives');
  const update = events.find((e) => e.type === 'hold_update');
  assert.ok(update && update.type === 'hold_update');
  assert.ok(update.update.notes.length >= 2, 'the hold keeps a chord sounding');
  assert.ok(update.update.label.length > 0 && update.update.overSec > 0);
  assert.ok(events.some((e) => e.type === 'call' && e.call.callType === 'hold'), 'the hold was a Drex call');
  assert.ok(events.some((e) => e.type === 'status' && e.stage === 'holding'));

  session.onClient({ type: 'hold_ended' });
  session.stop();
  await run;
  assert.ok(!events.some((e) => e.type === 'error'), 'stopping is not an error');
});

// ───────────────────────────── Song form, phrase lengths, joins ─────────────────────────────

test('every song layout fills its sections, ends on an outro and has at most four choruses', async () => {
  const { songLayout } = await import('../calls/setup.ts');
  for (const form of ['verse_chorus', 'prechorus', 'hook_first', 'one_groove']) {
    for (let n = 4; n <= 12; n++) {
      const parts = songLayout(form, n);
      assert.equal(parts.length, n, `${form} over ${n} sections`);
      assert.equal(parts[n - 1], 'outro');
      const runs = parts.filter((p, i) => p === 'chorus' && parts[i - 1] !== 'chorus').length;
      assert.ok(runs <= 4, `${form} over ${n}: ${runs} choruses`);
      if (form !== 'one_groove') assert.ok(runs >= 1);
      else assert.equal(runs, 0);
    }
  }
});

async function composeAll(prompt: string, seed: number) {
  const { Session } = await import('../session.ts');
  const events: any[] = [];
  process.env.STANDIN_LATENCY_MS = '0-0';
  const saved = process.env.NACE_API_KEY;
  delete process.env.NACE_API_KEY;
  try {
    const session = new Session({ prompt, seed, paced: false, send: (e: any) => events.push(e) });
    await session.run();
  } finally {
    if (saved !== undefined) process.env.NACE_API_KEY = saved;
  }
  return events;
}

test('a beat piece is a song: the chorus comes back with the same melody and chords', async () => {
  const events = await composeAll('a late-night rap beat with heavy 808s', 5);
  const plan = events.find((e) => e.type === 'plan').plan;
  const scores = events.filter((e) => e.type === 'phrase').map((e) => e.score);
  assert.equal(scores.length, plan.totalPhrases);
  assert.deepEqual(scores.map((s: any) => s.index), scores.map((_s: any, i: number) => i), 'phrases arrive in order');
  assert.ok(scores.every((s: any) => s.bars === 4), 'loop music stays square');
  const again = scores.filter((s: any) => s.display.lineage.includes('the chorus again'));
  assert.ok(again.length >= 2);
  for (const s of again) {
    const src = scores[Number(/the chorus again \(phrase (\d+)\)/.exec(s.display.lineage)![1]) - 1];
    assert.equal(s.display.notation, src.display.notation);
    assert.equal(s.display.chords.length, src.display.chords.length);
  }
});

test('phrases vary in length, and lead-in notes sit inside the phrase before', async () => {
  const events = await composeAll('swimming alone at night', 3);
  const scores = events.filter((e) => e.type === 'phrase').map((e) => e.score);
  assert.ok(new Set(scores.map((s: any) => s.bars)).size >= 2, 'more than one phrase length');
  for (const s of scores) {
    assert.equal(s.beats, s.bars * s.beatsPerBar + (s.final ? s.beats - s.bars * s.beatsPerBar : 0));
    for (const n of s.notes) assert.ok(n.t >= 0 && n.t < s.beats + 1e-6, `phrase ${s.index + 1}: note at ${n.t} of ${s.beats}`);
  }
  assert.ok(scores.some((s: any) => s.display.lineage.includes('pickup')), 'at least one pickup');
});
