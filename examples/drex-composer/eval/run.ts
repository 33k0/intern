// Evaluation harness for the tests in the design doc (section 18).
//
//   npm run eval                       run everything that can run in the current mode
//   npm run eval -- theory             20 hand-written states per call type; pass = top pick right in 16+   (needs a key)
//   npm run eval -- theory --compare drex-v2.0     same, on two models side by side, to pick the model per call type
//   npm run eval -- judge              planted off-theme and copied drafts must be rejected
//   npm run eval -- repetition         similarity across all phrase pairs: none above the copy level
//   npm run eval -- prompts            opposite prompts give different rules; style prompts pick the matching sheet
//   npm run eval -- speed              calls per phrase, round-trip time, and whether the buffer would run dry
//   npm run eval -- listening          writes MIDI pairs (Drex vs random picker, theme vs late phrase) for blind listening
//
// Without NACE_API_KEY these run against the local stand-in. That checks the engine and the facts it
// measures; it says nothing about Drex itself. Each result is labelled with what answered.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallType, ServerEvent } from '../shared/types.ts';
import { phraseSeconds } from '../shared/types.ts';
import { COPY_LEVEL, judgeDrafts, type Draft } from '../server/calls/phrase.ts';
import { runPlan, runSetup } from '../server/calls/setup.ts';
import { writeTheme } from '../server/calls/themes.ts';
import type { Ctx } from '../server/context.ts';
import { similarity } from '../server/core/facts.ts';
import { readMood } from '../server/core/mood.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { apiKey, Gateway, type Question } from '../server/gateway/gateway.ts';
import { modelFor } from '../server/gateway/models.ts';
import { pack, ROOT } from '../server/pack.ts';
import { Piece } from '../server/piece.ts';
import { composePhrase } from '../server/calls/compose.ts';
import { Session } from '../server/session.ts';
import { scoresToMidi } from '../tools/midi.ts';

process.env.STANDIN_LATENCY_MS ??= '0-0';
const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith('--')) ?? 'all';
const compareWith = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;
const live = !!apiKey();
const answeredBy = live ? `Drex (${modelFor('setup')})` : 'the local STAND-IN (no NACE_API_KEY)';
const results: { test: string; pass: boolean | null; detail: string }[] = [];
const record = (test: string, pass: boolean | null, detail: string) => {
  results.push({ test, pass, detail });
  console.log(`${pass === null ? '–' : pass ? '✔' : '✖'} ${test}: ${detail}`);
};

async function compose(prompt: string, seed: number) {
  const events: ServerEvent[] = [];
  const session = new Session({ prompt, seed, paced: false, send: (e) => events.push(e) });
  const t0 = Date.now();
  await session.run();
  return { events, session, ms: Date.now() - t0, scores: events.flatMap((e) => (e.type === 'phrase' ? [e.score] : [])) };
}

// ───────────────────────────── Drex follows theory ─────────────────────────────

interface Case {
  id: string;
  tests: string;
  state: string;
  question: { type: 'choice' | 'noul' | 'score'; instructions: string; criteria?: any };
  accept: string[];
  why: string;
}

function toQuestion(c: Case): Question {
  const q = c.question;
  if (q.type === 'choice') {
    return { id: 'answer', type: 'choice', label: c.tests, instructions: q.instructions, options: Object.entries(q.criteria as Record<string, string>).map(([key, criteria]) => ({ key, label: key, criteria: String(criteria ?? '') })) };
  }
  if (q.type === 'score') return { id: 'answer', type: 'score', label: c.tests, instructions: q.instructions, levels: q.criteria as string[] };
  return { id: 'answer', type: 'noul', label: c.tests, instructions: q.instructions, yes: q.criteria?.true, no: q.criteria?.false };
}

async function theory() {
  const dir = join(ROOT, 'eval/cases');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  if (!files.length) return record('Drex follows theory', null, 'no case files in eval/cases yet');
  const total = files.reduce((n, f) => n + JSON.parse(readFileSync(join(dir, f), 'utf8')).cases.length, 0);
  if (!live) {
    return record('Drex follows theory', null, `${total} hand-written cases in ${files.length} call types are ready; this test only means something against the real Drex, so it needs NACE_API_KEY`);
  }
  const models = compareWith ? [modelFor('setup'), compareWith] : [modelFor('setup')];
  const gw = new Gateway({ seed: 1 });
  const table: Record<string, Record<string, number>> = {};
  for (const file of files) {
    const { call, cases } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { call: CallType; cases: Case[] };
    table[call] = {};
    for (const model of models) {
      let right = 0;
      const misses: string[] = [];
      await Promise.all(cases.map(async (c) => {
        const theoryBlock = pack.theory(call);
        const ans = await gw.ask({ callType: call, title: c.id, state: theoryBlock ? `${c.state}\n${theoryBlock}` : c.state, questions: [toQuestion(c)], picking: 'top', quiet: true, model });
        if (c.accept.includes(ans.picks[0].answer)) right++;
        else misses.push(`${c.id} (picked ${ans.picks[0].answer}, wanted ${c.accept.join('/')})`);
      }));
      table[call][model] = right;
      record(`Drex follows theory: ${call} on ${model}`, right >= Math.ceil(cases.length * 0.8), `${right}/${cases.length} top picks right${misses.length ? `; missed ${misses.join(', ')}` : ''}`);
    }
  }
  if (compareWith) {
    console.log('\nModel per call type (paste the winners into server/gateway/models.ts):');
    for (const [call, scores] of Object.entries(table)) {
      const [a, b] = models;
      console.log(`  ${call.padEnd(18)} ${a}: ${scores[a]}   ${b}: ${scores[b]}   → ${scores[b] > scores[a] ? b : a}`);
    }
  }
}

// ───────────────────────────── Judge works ─────────────────────────────

async function judge() {
  const prompt = 'a slow goodbye at a train station';
  const piece = new Piece(prompt, readMood(prompt));
  const events: ServerEvent[] = [];
  const gw = new Gateway({ seed: 42 });
  const ctx: Ctx = { gw, piece, rng: mulberry32(42), emit: (e) => events.push(e) };
  await runSetup(ctx);
  await runPlan(ctx);
  await writeTheme(ctx, 'A', 'main');
  // Compose a few phrases so there is a "last four" to copy from; stay inside development territory.
  let index = 0;
  while (index < 4 && index < piece.plan.totalPhrases - 2) await composePhrase(ctx, index++);
  while (piece.roleOf(index) !== 'development' && index < piece.plan.totalPhrases - 2) await composePhrase(ctx, index++);
  const last = piece.phrases[piece.phrases.length - 1];
  const before = piece.phrases[piece.phrases.length - 2];
  const planted = (id: string, from: typeof last, lineage: string, line = from.line): Draft => ({
    id, direction: from.direction, key: from.key, line, lineage, depth: 6, intact: false, related: 0,
    slots: from.slots, facts: [], quality: 0, failure: '',
  });
  const unit = piece.rules.meter.beatsPerBar;
  // Off-theme: one droning pitch in equal notes, sharing nothing with the theme's contour, intervals or rhythm.
  const drone = Array.from({ length: 4 }, () => ({ deg: 3, dur: unit }));
  const stats = [{ leaps: 0, nonChord: 0, motion: 0 }, { leaps: 0, nonChord: 0, motion: 0 }, { leaps: 0, nonChord: 0, motion: 0 }];
  const verdict = await judgeDrafts(ctx, index, 1, [
    planted('draft_a', last, `copy of phrase ${last.index + 1}`),
    planted('draft_b', before, `copy of phrase ${before.index + 1}`),
    planted('draft_c', last, 'unrelated drone', drone),
  ], stats);
  const reason = [...events].reverse().find((e) => e.type === 'phrase_drafts');
  record('Judge works: planted copies and an off-theme draft', verdict === null,
    `${verdict === null ? 'all rejected' : `ACCEPTED ${verdict.id} (${verdict.lineage})`}${reason && reason.type === 'phrase_drafts' ? `; reason given: ${reason.verdict.reason}` : ''} [answered by ${answeredBy}]`);

  // Control: honest drafts for the same phrase should normally get through within a few rounds.
  piece.lastReject = '';
  let rounds = 0;
  await composePhrase(ctx, index, () => rounds++);
  record('Judge works: control (real drafts are accepted)', rounds <= 4, `accepted after ${rounds} rejected round${rounds === 1 ? '' : 's'}`);
}

// ───────────────────────────── No repetition ─────────────────────────────

async function repetition() {
  let worst = { sim: 0, a: 0, b: 0, prompt: '' };
  let pairs = 0;
  let over = 0;
  for (const [prompt, seed] of [['rain on a tin roof at 3am, missing someone', 7], ['boss fight in a neon arcade', 11], ['a kitten chasing a butterfly, silly and bright', 3]] as const) {
    const { session } = await compose(prompt, seed);
    const ph = session.piece.phrases;
    for (let i = 0; i < ph.length; i++) {
      for (let j = i + 1; j < ph.length; j++) {
        const sim = similarity(ph[i].line, ph[j].line, ph[i].slots.map((s) => s.chord.id), ph[j].slots.map((s) => s.chord.id));
        pairs++;
        // A planned return states the theme again on purpose; it must differ in harmony or instruments instead.
        const plannedReturn = ph[j].role === 'return' && ph[j].themeIntact;
        if (sim > COPY_LEVEL && !plannedReturn) over++;
        if (sim > worst.sim && !plannedReturn) worst = { sim, a: i + 1, b: j + 1, prompt };
      }
    }
  }
  record('No repetition: similarity across all phrase pairs', over === 0,
    `${pairs} pairs in 3 pieces, ${over} above the copy level (${Math.round(COPY_LEVEL * 100)}%); closest pair ${Math.round(worst.sim * 100)}% (phrases ${worst.a} and ${worst.b} of "${worst.prompt}") [${answeredBy}]`);
}

// ───────────────────────────── Prompt matters, style choice ─────────────────────────────

async function prompts() {
  const rulesOf = async (prompt: string, seed = 9) => {
    const piece = new Piece(prompt, readMood(prompt));
    const ctx: Ctx = { gw: new Gateway({ seed }), piece, rng: mulberry32(seed), emit: () => {} };
    const t0 = Date.now();
    await runSetup(ctx);
    return { rules: piece.rules, ms: Date.now() - t0 };
  };
  const a = await rulesOf('a lullaby for a sleeping child, soft snow outside');
  const b = await rulesOf('a furious chase through a burning city at night');
  const keys = ['style', 'bpm', 'meter', 'key', 'harmonicLanguage', 'soundWorld', 'form', 'ending'] as const;
  const differ = keys.filter((k) => JSON.stringify((a.rules as any)[k]) !== JSON.stringify((b.rules as any)[k]));
  record('Prompt matters: two opposite prompts', differ.length >= 3,
    `${differ.length} of ${keys.length} rules differ (${differ.join(', ')}); lullaby = ${a.rules.bpm} BPM ${a.rules.key.mode}, chase = ${b.rules.bpm} BPM ${b.rules.key.mode}; rules arrived in ${a.ms} ms and ${b.ms} ms [${answeredBy}]`);

  const aimed: [string, string][] = [
    ['two people who never said goodbye, an orchestra swelling', 'bittersweet_orchestral'],
    ['the last light over an empty ocean, strings and piano', 'bittersweet_orchestral'],
    ['a winter funeral, slow and enormous', 'bittersweet_orchestral'],
    ['a warehouse rave at 2am, bass shaking the walls', 'beat_driven'],
    ['neon city drive, synths and a hard kick drum', 'beat_driven'],
    ['robots in a dance battle', 'beat_driven'],
    ['a puppy stealing socks and running away', 'playful'],
    ['a clumsy circus clown on a unicycle', 'playful'],
    ['children playing hide and seek in a garden', 'playful'],
  ];
  let right = 0;
  const misses: string[] = [];
  for (const [prompt, want] of aimed) {
    const got = (await rulesOf(prompt)).rules.style;
    if (got === want) right++;
    else misses.push(`"${prompt}" → ${got}`);
  }
  record('Style choice: prompts aimed at each style', right >= 8, `${right}/${aimed.length} picked the matching sheet${misses.length ? `; missed ${misses.join('; ')}` : ''} [${answeredBy}]`);
}

// ───────────────────────────── Speed ─────────────────────────────

async function speed() {
  for (const [prompt, seed] of [['rain on a tin roof at 3am, missing someone', 7], ['boss fight in a neon arcade', 11]] as const) {
    const callMs: number[] = [];
    const events: ServerEvent[] = [];
    const session = new Session({ prompt, seed, paced: false, send: (e) => { events.push(e); if (e.type === 'call') callMs.push(e.call.ms); } });
    await session.run();
    const scores = events.flatMap((e) => (e.type === 'phrase' ? [e.score] : []));
    const perPhrase = session.gw.calls / scores.length;
    const phraseSec = scores.reduce((s, x) => s + phraseSeconds(x), 0) / scores.length;
    const sorted = callMs.slice().sort((x, y) => x - y);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const perMinute = (perPhrase * 60) / phraseSec;
    const style = session.piece.rules.style;
    record(`Speed: ${style}`, null,
      `${perPhrase.toFixed(1)} calls per phrase; phrases last ${phraseSec.toFixed(1)} s, so real-time playback needs ${Math.round(perMinute)} calls a minute ` +
      `(free tier allows 120, paid 1,200); ${session.rejects} rejected rounds; round trip p50 ${p50} ms, p95 ${p95} ms [${answeredBy}]` +
      (live ? '' : '. Round-trip times here are the stand-in\'s; measure again with a key before trusting the buffer.'));
  }
}

// ───────────────────────────── Listening material ─────────────────────────────

async function listening() {
  const out = join(ROOT, 'eval/listening');
  mkdirSync(out, { recursive: true });
  const prompt = 'rain on a tin roof at 3am, missing someone';
  const drex = await compose(prompt, 7);
  writeFileSync(join(out, 'A.mid'), scoresToMidi(drex.scores));
  process.env.DREX_PICKER = 'random';
  const random = await compose(prompt, 7);
  delete process.env.DREX_PICKER;
  writeFileSync(join(out, 'B.mid'), scoresToMidi(random.scores));
  writeFileSync(join(out, 'theme.mid'), scoresToMidi([drex.scores[0]]));
  const late = drex.scores[Math.max(1, drex.scores.length - 3)];
  writeFileSync(join(out, 'late-phrase.mid'), scoresToMidi([late]));
  writeFileSync(join(out, 'KEY.txt'), [
    'Blind listening material. Do not show this file to listeners.',
    `Prompt: "${prompt}"`,
    `A.mid = ${live ? 'Drex' : 'the stand-in (no key was set, so this is NOT Drex)'}; B.mid = random picker in its place.`,
    'Not random: play A and B without saying which is which; pass if listeners clearly prefer A.',
    `Theme survives: play theme.mid, then late-phrase.mid (phrase ${late.index + 1}, ${late.role}); pass if most say it is the same piece.`,
    'MIDI carries the notes only. For the real sound (samples, hall, mix) run the app; set DREX_PICKER=random in .env for the control run.',
  ].join('\n') + '\n');
  record('Listening material (not random, theme survives)', null, `wrote A.mid, B.mid, theme.mid, late-phrase.mid and KEY.txt to eval/listening; these two tests need human ears`);
}

const all: Record<string, () => Promise<void>> = { theory, judge, repetition, prompts, speed, listening };
console.log(`Drex Composer evaluation; answers come from ${answeredBy}\n`);
for (const [name, run] of Object.entries(all)) if (which === 'all' || which === name) await run();
const failed = results.filter((r) => r.pass === false).length;
console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed} failed, ${results.filter((r) => r.pass === null).length} informational or need a key / ears`);
mkdirSync(join(ROOT, 'eval/results'), { recursive: true });
writeFileSync(join(ROOT, 'eval/results/latest.json'), JSON.stringify({ at: new Date().toISOString(), answeredBy, results }, null, 2));
process.exit(failed ? 1 : 0);
