// Whole pieces composed headlessly on the stand-in: structural invariants of what the browser receives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PhraseScore, ServerEvent } from '../../shared/types.ts';
import { INSTRUMENTS } from '../piece.ts';
import { Session } from '../session.ts';

process.env.STANDIN_LATENCY_MS = '0-0';
delete process.env.NACE_API_KEY;

async function compose(prompt: string, seed: number) {
  const events: ServerEvent[] = [];
  const session = new Session({ prompt, seed, paced: false, send: (e) => events.push(e) });
  await session.run();
  return { events, session, scores: events.flatMap((e) => (e.type === 'phrase' ? [e.score] : [])) };
}

function checkScore(s: PhraseScore) {
  assert.ok(s.notes.length > 0, `phrase ${s.index} has notes`);
  for (const n of s.notes) {
    assert.ok(Number.isFinite(n.t) && Number.isFinite(n.dur) && Number.isFinite(n.midi) && Number.isFinite(n.vel), 'finite numbers');
    assert.ok(n.t >= 0 && n.t < s.beats, `note starts inside phrase ${s.index}: t=${n.t} of ${s.beats}`);
    assert.ok(n.dur > 0, 'positive duration');
    assert.ok(n.vel > 0 && n.vel <= 1, 'velocity in range');
    const info = INSTRUMENTS[n.inst];
    assert.ok(info, `known instrument ${n.inst}`);
    assert.ok(n.midi >= info.range[0] && n.midi <= info.range[1], `${n.inst} note ${n.midi} inside its range ${info.range}`);
  }
  assert.ok(s.holdChord.length >= 2, 'a chord to hold if the buffer runs dry');
  assert.equal(s.display.layers.length, 9);
}

for (const [prompt, seed] of [
  ['rain on a tin roof at 3am, missing someone', 7],
  ['boss fight in a neon arcade', 11],
  ['a kitten chasing a butterfly, silly and bright', 3],
] as const) {
  test(`composes a complete piece: "${prompt}"`, async () => {
    const { events, scores, session } = await compose(prompt, seed);
    assert.ok(!events.some((e) => e.type === 'error'), 'no errors');
    const plan = events.filter((e) => e.type === 'plan').pop();
    assert.ok(plan && plan.type === 'plan');
    assert.equal(scores.length, plan.plan.totalPhrases, 'every planned phrase was composed');
    scores.forEach((s, i) => {
      assert.equal(s.index, i);
      checkScore(s);
    });
    assert.equal(scores[scores.length - 1].final, true);
    assert.equal(events[events.length - 1].type, 'done');
    assert.equal(plan.plan.sections[0].role, 'statement');
    // The theme is stated intact first.
    assert.match(scores[0].display.lineage, /A intact/);
    const perPhrase = session.gw.calls / scores.length;
    assert.ok(perPhrase > 12 && perPhrase < 60, `calls per phrase plausible: ${perPhrase.toFixed(1)}`);
  });
}

test('the same seed gives the same piece; a different prompt gives different rules', async () => {
  const a = await compose('sunrise over a frozen lake', 5);
  const b = await compose('sunrise over a frozen lake', 5);
  assert.deepEqual(a.scores.map((s) => s.display.notation), b.scores.map((s) => s.display.notation));
  const c = await compose('boss fight in a neon arcade', 5);
  const rules = (x: typeof a) => x.events.find((e) => e.type === 'rules');
  assert.notDeepEqual(rules(a), rules(c));
});

test('no accepted phrase is a copy of any of the four before it', async () => {
  const { events } = await compose('a slow goodbye at a train station', 21);
  for (const e of events) {
    if (e.type !== 'phrase_drafts' || !e.verdict.picked) continue;
    const draft = e.drafts.find((d) => d.id === e.verdict.picked)!;
    const sims = draft.facts?.find((f) => f.label === 'similarity to last four')?.value ?? '';
    const worst = Math.max(0, ...[...sims.matchAll(/(\d+)%/g)].map((m) => Number(m[1])));
    assert.ok(worst <= 80 || /theme returns intact/.test(JSON.stringify(draft.facts)), `phrase ${e.phrase + 1} similarity ${worst}%`);
  }
});
