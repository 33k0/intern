// Scripted stand-in for the server, used when the URL has ?mock=1 (add &speed=3 to hurry it).
// It emits the same ServerEvents the real composer does, on timers: session, rules, plan,
// backdrop, six theme drafts and a verdict, then twelve phrases with bursts of calls, two
// rejected judge rounds, a hold while it redrafts, a plan revision, and done.
// Every session it reports standin: true, so the panel never passes this off as the real Drex.

import type {
  CallType, CallView, ClientEvent, DraftView, QuestionView, ServerEvent, VerdictView,
} from '../../../shared/types';
import { mockBackdropUrl } from './backdropArt';
import {
  ALTERNATIVES, RECIPES, TOTAL_PHRASES, buildScore, draftFromRecipe, holdNotes, planView,
  presetForPrompt, themeDraftViews, themeView, type Preset, type Recipe,
} from './music';

export interface MockFeed {
  start(prompt: string, seed?: number): void;
  stop(): void;
  /** Playback reports from the panel (phrase_started, hold_started, hold_ended). */
  client(event: ClientEvent): void;
}

class Cancelled extends Error {}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Phrase whose first judge round is rejected (the buffer covers it: no hold). */
const REJECT_ONCE_AT = 4;
/** Phrase that is rejected twice, long enough for playback to catch up and hold. */
const HOLD_AT = 8;
/** The plan is revised once this phrase (the end of section 2) is composed. */
const REVISE_AFTER = 4;

export function createMockFeed(emit: (event: ServerEvent) => void): MockFeed {
  let generation = 0;
  let nowIndex = -1;
  let holding = false;
  const speedParam = Number(new URLSearchParams(location.search).get('speed'));
  const speed = Number.isFinite(speedParam) && speedParam > 0 ? speedParam : 1;

  function stop(): void {
    generation += 1;
  }

  function start(prompt: string, seed?: number): void {
    generation += 1;
    nowIndex = -1;
    holding = false;
    const mine = generation;
    runScript(prompt, seed ?? Math.floor(Math.random() * 1e6), mine).catch((err) => {
      if (!(err instanceof Cancelled)) console.error('[mock] script failed:', err);
    });
  }

  function client(event: ClientEvent): void {
    if (event.type === 'phrase_started') {
      nowIndex = event.index;
      holding = false;
    } else if (event.type === 'hold_started') {
      holding = true;
    } else if (event.type === 'hold_ended') {
      holding = false;
    }
  }

  async function runScript(prompt: string, seed: number, mine: number): Promise<void> {
    const rng = mulberry32(seed);
    const preset = presetForPrompt(prompt);
    const t0 = performance.now();
    let callId = 0;
    const callTimes: number[] = [];
    let rejects = 0;
    let holds = 0;
    let composed = 0;

    const send = (event: ServerEvent): void => {
      if (mine !== generation) throw new Cancelled();
      emit(event);
    };
    const sleep = (ms: number): Promise<void> => new Promise((resolve, reject) => {
      window.setTimeout(() => (mine === generation ? resolve() : reject(new Cancelled())), ms / speed);
    });
    const stats = (): void => {
      const now = performance.now();
      send({
        type: 'stats',
        calls: callId,
        callsLastMinute: callTimes.filter((t) => now - t < 60000).length,
        rejects, holds, composed,
      });
    };

    // ── question builders ──
    const spread = (keys: string[], top: string, sharpness: number): Record<string, number> => {
      const raw = keys.map((k) => Math.exp((k === top ? sharpness : 0) + rng() * 1.6));
      const sum = raw.reduce((a, b) => a + b, 0);
      const out: Record<string, number> = {};
      keys.forEach((k, i) => { out[k] = raw[i] / sum; });
      return out;
    };
    const choice = (id: string, label: string, options: [string, string][], top: string, sharpness = 1.9): QuestionView => ({
      id, type: 'choice', label,
      options: options.map(([key, l]) => ({ key, label: l })),
      probabilities: spread(options.map((o) => o[0]), top, sharpness),
      picked: [top], picking: 'top',
    });
    const sampled = (id: string, label: string, options: [string, string][], drafts: number): QuestionView => {
      const probabilities = spread(options.map((o) => o[0]), options[Math.floor(rng() * options.length)][0], 0.9);
      const keys = Object.keys(probabilities);
      const picked: string[] = [];
      for (let d = 0; d < drafts; d++) {
        let r = rng();
        let pick = keys[keys.length - 1];
        for (const k of keys) {
          r -= probabilities[k];
          if (r <= 0) { pick = k; break; }
        }
        picked.push(pick);
      }
      return { id, type: 'choice', label, options: options.map(([key, l]) => ({ key, label: l })), probabilities, picked, picking: 'sampled' };
    };
    const noul = (id: string, label: string, pYes: number): QuestionView => ({
      id, type: 'noul', label, probabilities: { yes: pYes }, picked: [pYes >= 0.5 ? 'yes' : 'no'], picking: 'top',
    });
    const score = (id: string, label: string, levels: string[], peak: number): QuestionView => {
      const raw = levels.map((_, i) => Math.exp(-((i - peak) ** 2) / 1.6) + rng() * 0.08);
      const sum = raw.reduce((a, b) => a + b, 0);
      const probabilities: Record<string, number> = {};
      raw.forEach((v, i) => { probabilities[String(i)] = v / sum; });
      return {
        id, type: 'score', label, options: levels.map((l, i) => ({ key: String(i), label: l })),
        probabilities, picked: [String(peak)], picking: 'top',
      };
    };
    const call = async (callType: CallType, title: string, questions: QuestionView[], ms?: number): Promise<void> => {
      const took = ms ?? Math.round(260 + rng() * 240);
      await sleep(took);
      callId += 1;
      callTimes.push(performance.now());
      const view: CallView = {
        id: callId, callType, title, at: Math.round(performance.now() - t0),
        model: 'local stand-in', standin: true, ms: took, questions,
      };
      send({ type: 'call', call: view });
      if (callId % 3 === 0) stats();
    };

    const SEVEN = ['1', '2', '3', '4', '5', '6', '7'];
    const short = prompt.length > 34 ? `${prompt.slice(0, 32)}...` : prompt;

    // ── session and rules ──
    send({ type: 'session', id: `mock-${seed}`, prompt, standin: true, model: 'local stand-in', seed });
    send({ type: 'status', stage: 'setup', message: 'Reading the prompt and setting the rules' });
    const r = preset.rules;
    await call('setup', `Rules for "${short}"`, [
      choice('style', 'Which style fits the prompt?', [
        ['bittersweet_orchestral', 'Bittersweet orchestral'], ['beat_driven', 'Beat driven'], ['playful', 'Playful'],
      ], r.style, 2.4),
      choice('tempo', 'Tempo', [
        ['56', 'very slow, 56'], ['66', 'slow, 66'], ['84', 'walking, 84'], ['104', 'moving, 104'],
        ['118', 'driving, 118'], ['132', 'quick, 132'], ['148', 'fast, 148'],
      ], String(r.bpm)),
      choice('meter', 'Meter', [['4/4', '4/4'], ['3/4', '3/4'], ['6/8', '6/8'], ['12/8', '12/8'], ['5/4', '5/4'], ['7/8', '7/8']], r.meter),
      choice('key', 'Key', [['C', 'C'], ['D', 'D'], ['E', 'E'], ['F', 'F'], ['F#', 'F#'], ['G', 'G'], ['A', 'A'], ['Bb', 'Bb']], r.keyName),
      choice('mode', 'Mode', [
        ['major', 'major'], ['natural_minor', 'natural minor'], ['harmonic_minor', 'harmonic minor'], ['dorian', 'dorian'],
        ['phrygian', 'phrygian'], ['lydian', 'lydian'], ['mixolydian', 'mixolydian'],
      ], r.mode),
      choice('harmony', 'Harmonic language', [
        ['triads', 'triads'], ['sevenths', 'sevenths'], ['extended', 'extended'], ['suspended', 'suspended'], ['chromatic', 'chromatic'],
      ], r.harmonicLanguage),
      choice('world', 'Sound world', [
        ['close_dry', 'close and dry'], ['large_hall', 'large hall'], ['submerged', 'submerged'], ['electronic_hybrid', 'electronic hybrid'],
      ], r.soundWorld),
      choice('form', 'Form', [
        ['arch', 'arch'], ['slow_build', 'slow build'], ['theme_development_return', 'theme, development, return'],
        ['through_composed', 'through composed'], ['verse_like', 'verse like'],
      ], r.form),
      choice('ending', 'Ending', [['resolved', 'resolved'], ['suspended', 'suspended'], ['fade', 'fade'], ['sudden_stop', 'sudden stop']], r.ending),
      choice('keyplan', 'Key plan', [
        ['none', 'stay home'], ['relative', 'visit the relative key'], ['step_up_at_climax', 'step up at the climax'], ['distant_dark_turn', 'distant dark turn'],
      ], r.keyPlan),
      score('length', 'How long should it run?', ['0:45', '1:00', '1:30', '2:00', '2:30', '3:00', '4:00'], 2),
      ...(['piano', 'violins', 'celli', 'harp', 'flute', 'horn', 'celesta', 'pad', 'sub', 'kick808', 'pluck', 'timpani'] as const).map((inst) =>
        noul(`pal_${inst}`, `Use ${inst.replace('808', ' 808')}?`, r.palette.includes(inst) ? 0.72 + rng() * 0.24 : 0.06 + rng() * 0.25)),
    ], 620);
    await sleep(350);
    send({ type: 'rules', rules: r });

    // ── plan ──
    send({ type: 'status', stage: 'plan', message: 'Planning sections and the tension curve' });
    let plan = planView(preset, false);
    await call('plan', 'Section plan and tension curve', [
      choice('sections', 'How many sections?', [['3', 'three'], ['4', 'four'], ['5', 'five'], ['6', 'six']], '5'),
      ...plan.sections.map((s) => score(`tension_${s.index}`, `Tension of section ${s.index + 1} (${s.role})`, SEVEN, s.tension - 1)),
      choice('climax', 'Where does the climax fall?', [['7', 'phrase 8'], ['8', 'phrase 9'], ['9', 'phrase 10'], ['10', 'phrase 11']], String(plan.climaxPhrase)),
      noul('departure', 'Does section 3 leave the home key?', 0.83),
    ], 540);
    send({ type: 'plan', plan });

    // ── backdrop ──
    await call('backdrop', 'Backdrop', [
      choice('backdrop', 'Which image sits behind the music?', [
        ['a', preset.backdropMood], ['b', 'empty concert hall'], ['c', 'open water at dusk'], ['d', 'forest in fog'], ['e', 'city from above'],
      ], 'a'),
    ]);
    send({ type: 'backdrop', id: `mock-${preset.id}`, file: mockBackdropUrl(preset.backdropHues, seed), mood: preset.backdropMood });

    // ── themes ──
    send({ type: 'status', stage: 'themes', message: 'Drafting six themes' });
    const contours: [string, string][] = [
      ['rise', 'rising line'], ['fall', 'falling sigh'], ['arch', 'arch'], ['repeat', 'repeated note, then leap'], ['wave', 'wave'], ['leaps', 'wide leaps'],
    ];
    await call('theme_shape', 'Theme shapes for six drafts', [
      sampled('shape', 'What contour should this draft take?', contours, 6),
      sampled('rhythm', 'Rhythmic character', [['even', 'even'], ['dotted', 'dotted'], ['long_short', 'long then short'], ['syncopated', 'syncopated']], 6),
    ]);
    for (let d = 0; d < 6; d++) {
      await call('theme_note', `Theme draft ${d + 1}: notes`, [
        sampled(`n${d}`, 'Next note, relative to the last', [
          ['-3', 'down a fourth'], ['-2', 'down a third'], ['-1', 'down a step'], ['0', 'repeat'], ['1', 'up a step'], ['2', 'up a third'], ['4', 'up a fifth'],
        ], 1),
        noul(`end${d}`, 'End the theme here?', 0.1 + rng() * 0.3),
      ], 200);
    }
    const themeDrafts = themeDraftViews(preset);
    const themeProb = spread([...themeDrafts.map((t) => t.id), 'none'], 't3', 2.2);
    await call('theme_judge', 'Judge the six theme drafts', [{
      id: 'pick', type: 'choice', label: 'Which draft is the theme?',
      options: [...themeDrafts.map((t, i) => ({ key: t.id, label: `draft ${i + 1}: ${t.lineage}` })), { key: 'none', label: 'none of these' }],
      probabilities: themeProb, picked: ['t3'], picking: 'top',
    }, noul('memorable', 'Could you hum it back after one hearing?', 0.81)], 700);
    send({
      type: 'theme_drafts', themeId: 'A', round: 1, drafts: themeDrafts,
      verdict: {
        picked: 't3',
        reason: 'Draft 3 has a clear arch and a falling fourth that is easy to recognise when it returns.',
        probabilities: themeProb,
      },
    });
    await sleep(500);
    send({ type: 'theme', theme: themeView(preset, 'main') });
    await call('theme_derive', 'Derive a contrast theme from A', [
      choice('derive', 'How should B differ from A?', [
        ['longer', 'longer notes, falling'], ['faster', 'shorter notes, rising'], ['inverted', 'A upside down'], ['unrelated', 'unrelated'],
      ], 'longer'),
    ]);
    send({ type: 'theme', theme: themeView(preset, 'contrast') });
    stats();

    // ── phrases ──
    const directions: [string, string][] = [
      ['restate', 'restate'], ['seq_up', 'sequence up'], ['seq_down', 'sequence down'], ['invert', 'invert'],
      ['fragment', 'fragment the head'], ['augment', 'augment'], ['extend', 'extend the tail'], ['contrast', 'bring in B'],
    ];
    const altFor = (i: number, k: number): Recipe => ALTERNATIVES[(i * 3 + k) % ALTERNATIVES.length];

    const judge = async (i: number, round: number, drafts: DraftView[], pickId: string | null, reason: string): Promise<void> => {
      const keys = [...drafts.map((d) => d.id), 'none'];
      const probabilities = spread(keys, pickId ?? 'none', pickId ? 2.1 : 1.7);
      await call('phrase_judge', `Judge phrase ${i + 1}, round ${round}`, [{
        id: 'pick', type: 'choice', label: `Which draft becomes phrase ${i + 1}?`,
        options: [...drafts.map((d) => ({ key: d.id, label: `draft ${d.id.toUpperCase()}: ${d.lineage}` })), { key: 'none', label: 'none: redraft' }],
        probabilities, picked: [pickId ?? 'none'], picking: 'top',
      },
      noul('fits', 'Does the best draft fit the planned tension?', pickId ? 0.7 + rng() * 0.25 : 0.12 + rng() * 0.2),
      score('quality', 'How strong is the best draft?', SEVEN, pickId ? 4 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 2)),
      ], 520);
      const verdict: VerdictView = { picked: pickId, reason, probabilities };
      if (!pickId) rejects += 1;
      send({ type: 'phrase_drafts', phrase: i, round, drafts, verdict });
      stats();
    };

    const draftBurst = async (i: number): Promise<void> => {
      await call('phrase_direction', `Phrase ${i + 1}: direction`, [
        sampled('dir', 'What should this phrase do with the theme?', directions, 4),
        sampled('register', 'Register', [['low', 'lower'], ['same', 'stay'], ['high', 'higher']], 4),
      ]);
      await call('chord_path', `Phrase ${i + 1}: chord path`, [
        choice('path', 'Which chord path?', [['a', 'i to IV'], ['b', 'VI to V'], ['c', 'i to VI'], ['d', 'IV to V'], ['e', 'ii to V']], ['a', 'b', 'c', 'd', 'e'][i % 5]),
        noul('cadence', 'Close with a cadence?', i % 3 === 2 ? 0.78 : 0.24),
      ]);
      for (let v = 0; v < 2; v++) {
        await call('voice_leading', `Phrase ${i + 1}: voice leading`, [
          choice(`vl${v}`, 'Inner voice moves', [['hold', 'hold'], ['step_up', 'step up'], ['step_down', 'step down'], ['leap', 'leap to chord tone']], ['hold', 'step_down', 'step_up'][Math.floor(rng() * 3)]),
        ], 190);
      }
    };

    const rejectedDrafts = (i: number, round: number): DraftView[] =>
      ['a', 'b', 'c', 'd'].map((id, k) => draftFromRecipe(preset, id, altFor(i + round, k + round), i));

    const acceptedDrafts = (i: number): { drafts: DraftView[]; pick: string } => {
      const ids = ['a', 'b', 'c', 'd'];
      const slot = Math.floor(rng() * ids.length);
      const drafts = ids.map((id, k) => draftFromRecipe(preset, id, k === slot ? RECIPES[i] : altFor(i, k), i));
      return { drafts, pick: ids[slot] };
    };

    for (let i = 0; i < TOTAL_PHRASES; i++) {
      // Stay two or three phrases ahead of playback, as the real composer does.
      // (One closer before the scripted hold, so the buffer drains in reasonable time.)
      const lead = i === HOLD_AT ? 2 : 3;
      for (let waited = 0; i - nowIndex > lead && waited < 80; waited++) await sleep(250);

      const section = plan.sections.find((s) => i >= s.phrases[0] && i <= s.phrases[1]) ?? plan.sections[0];
      send({ type: 'status', stage: 'composing', message: `Composing phrase ${i + 1} of ${TOTAL_PHRASES} (${section.role})` });
      await draftBurst(i);

      let round = 1;
      if (i === REJECT_ONCE_AT) {
        await judge(i, round, rejectedDrafts(i, round), null, 'Every draft loses the falling fourth that makes A recognisable. Redrafting.');
        round += 1;
        await draftBurst(i);
      }
      if (i === HOLD_AT) {
        await judge(i, round, rejectedDrafts(i, round), null, 'None of these reaches the tension the climax needs. Redrafting.');
        round += 1;
        await draftBurst(i);
        await judge(i, round, rejectedDrafts(i, round), null, 'Closer, but the line peaks too early and sags before the bar ends. Redrafting.');
        round += 1;
        send({ type: 'status', stage: 'composing', message: `Phrase ${i + 1}: two rounds rejected, drafting again` });
        // Keep drafting until playback runs out of music and the engine holds.
        for (let waited = 0; !holding && waited < 18; waited++) await draftBurst(i);
        if (holding) {
          holds += 1;
          send({ type: 'status', stage: 'holding', message: 'Out of accepted music: holding the last chord while redrafting' });
          const holdOptions: [string, string][] = [
            ['add_ninth', 'add the ninth above'], ['thin', 'thin to an open fifth'], ['swell', 'swell and darken'], ['tremolo', 'bring in tremolo'], ['still', 'leave it still'],
          ];
          await call('hold', 'Hold: how should the sustain evolve?', [choice('hold', 'What happens to the held chord?', holdOptions, 'add_ninth')], 380);
          send({
            type: 'hold_update',
            update: { action: 'add_ninth', label: 'Add the ninth above', notes: holdNotes(preset, [0, 2, 4, 8]), mix: { reverb: 5 }, overSec: 1.8 },
          });
          await sleep(2600);
          await draftBurst(i);
          await call('hold', 'Hold: how should the sustain evolve?', [choice('hold', 'What happens to the held chord?', holdOptions, 'swell')], 380);
          send({
            type: 'hold_update',
            update: { action: 'swell', label: 'Swell and darken', notes: holdNotes(preset, [0, 4, 7, 8]), mix: { lowpass: 2, dynamics: 4 }, overSec: 2.4 },
          });
          await sleep(2400);
        }
      }

      const { drafts, pick } = acceptedDrafts(i);
      await judge(i, round, drafts, pick, acceptReason(i, drafts.find((d) => d.id === pick)!));

      const sc = buildScore(preset, i, plan);
      await call('orchestration', `Phrase ${i + 1}: orchestration`, [
        score('dyn', 'Overall dynamic', ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'], sc.mix.dynamics),
        ...sc.display.layers.map((l) => noul(`layer_${l.role}`, `Is the ${l.role} layer playing?`, l.inst ? 0.74 + rng() * 0.22 : 0.05 + rng() * 0.22)),
        score('reverb', 'Reverb', SEVEN, sc.mix.reverb),
      ]);
      send({ type: 'phrase', score: sc });
      composed += 1;
      stats();

      if (i === REVISE_AFTER) {
        await call('plan_revision', 'Revise the plan after section 2?', [
          noul('revise', 'Should the plan change, given what was just composed?', 0.74),
          score('tension_2', 'Tension of section 3 (departure), revised', SEVEN, 2),
          choice('climax', 'Where should the climax fall now?', [['7', 'phrase 8'], ['8', 'phrase 9'], ['9', 'phrase 10'], ['10', 'phrase 11']], '9'),
          choice('last', 'Role of the last section', [['return', 'return'], ['coda', 'coda'], ['development', 'development']], 'coda'),
        ], 600);
        plan = planView(preset, true);
        send({ type: 'plan', plan });
        send({ type: 'status', stage: 'composing', message: 'Plan revised: quieter departure, later climax, a coda to close' });
        await sleep(900);
      }
    }

    await call('ending', 'Ending', [
      choice('ending', 'How does the last chord leave?', [['resolved', 'resolved'], ['suspended', 'suspended'], ['fade', 'fade'], ['sudden_stop', 'sudden stop']], r.ending),
      noul('rit', 'Slow down into the last bar?', r.ending === 'sudden_stop' ? 0.12 : 0.88),
    ]);
    stats();
    send({ type: 'status', stage: 'ending', message: 'All phrases composed. Playing out.' });
    send({ type: 'done' });
  }

  return { start, stop, client };
}

function acceptReason(i: number, draft: DraftView): string {
  const reasons = [
    'states the theme plainly, which the opening needs',
    'answers the first phrase without repeating it',
    'lifts the line while keeping the falling fourth intact',
    'builds momentum from the head of the theme',
    'turns the theme over, so it sounds fresh but related',
    'gives the ear something new for the departure',
    'continues B downward and prepares the way home',
    'slows the theme so the climax has room to grow',
    'reaches the highest point of the piece on the long last note',
    'keeps the height of the climax and lets the tail ring',
    'brings the theme home, lower and calmer',
    'lets the last note stretch into the final chord',
  ];
  return `Draft ${draft.id.toUpperCase()} ${reasons[i % reasons.length]}.`;
}

export type { Preset };
