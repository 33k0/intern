// Dev-only harness behind smoke.html: drives the engine with the hand-written demo score so
// it can be heard (and its events and meters watched) without the composer server.

import * as Tone from 'tone';
import type { InstrumentId, LayerRole, NoteEvent, PhraseScore } from '../../../shared/types.ts';
import { asFinal, demoHoldUpdate, demoPalette, demoScores } from './demoScore.ts';
import { AudioEngine, LAYER_ROLES } from './engine.ts';
import type { EngineEvent } from './engine.ts';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const t0 = performance.now();
const lines: string[] = [];
const events: { at: number; audio: number; event: EngineEvent }[] = [];
const peaks: Record<string, number> = { master: 0 };

function say(msg: string): void {
  lines.push(`${((performance.now() - t0) / 1000).toFixed(2).padStart(7)}  ${msg}`);
  $('log').textContent = lines.slice(-80).join('\n');
  $('log').scrollTop = 1e9;
}

let engine: AudioEngine | null = null;
let loaded = false;

async function ensureEngine(): Promise<AudioEngine> {
  if (engine) return engine;
  if (new URLSearchParams(location.search).has('silent')) {
    // render to nowhere: the context still runs in real time, nothing reaches the speakers
    const native = (Tone.getContext().rawContext as unknown as { _nativeAudioContext?: { setSinkId?: (s: unknown) => Promise<void> } })._nativeAudioContext;
    if (native?.setSinkId) {
      await native.setSinkId({ type: 'none' });
      say('silent mode: audio sink set to none');
    } else {
      say('silent mode requested but setSinkId is not available; sound WILL play');
    }
  }
  engine = await AudioEngine.create();
  engine.on((event) => {
    events.push({ at: performance.now() - t0, audio: Tone.getContext().rawContext.currentTime, event });
    say(`event ${JSON.stringify(event)}  (audio clock ${Tone.getContext().rawContext.currentTime.toFixed(3)})`);
  });
  say('engine created');
  return engine;
}

async function load(extra: InstrumentId[] = []): Promise<void> {
  const e = await ensureEngine();
  await e.unlock();
  say(`context ${Tone.getContext().state}, sample rate ${Tone.getContext().sampleRate}`);
  let last = 0;
  await e.loadInstruments([...demoPalette, ...extra], (done, total) => {
    if (done === total || done - last >= 40) {
      last = done;
      say(`samples ${done}/${total}`);
    }
  });
  loaded = true;
  say('instruments ready');
}

/** Two phrases, let the queue run dry (hold), change the hold after 4 s, end it with a final phrase after 9 s. */
async function demo(): Promise<void> {
  const e = await ensureEngine();
  if (!loaded) await load();
  e.stop();
  e.setSoundWorld('large_hall');
  for (const s of demoScores) e.enqueue(s);
  e.start();
  say('started: 2 phrases queued');
  const off = e.on((event) => {
    if (event.type === 'hold_started') {
      window.setTimeout(() => {
        say('applyHold: ' + demoHoldUpdate.label);
        e.applyHold(demoHoldUpdate);
      }, 4000);
      window.setTimeout(() => {
        const [last] = asFinal([{ ...demoScores[0], index: 2, fadeOut: { fromBeat: 5, toBeat: 8 } }]);
        say('enqueue final phrase (fades out over its last three beats)');
        e.enqueue(last);
      }, 9000);
    }
    if (event.type === 'ended') off();
  });
}

function mk(t: number, dur: number, midi: number, vel: number, inst: InstrumentId, layer: LayerRole, art: NoteEvent['art'] = 'sustain'): NoteEvent {
  return { t, dur, midi, vel, inst, art, layer };
}

/** Every synth, the sidechain, drums, and instruments that are deliberately not loaded (fallback path). */
function synthScore(): PhraseScore {
  const notes: NoteEvent[] = [];
  for (let b = 0; b < 8; b++) {
    notes.push(mk(b, 0.25, 36, 0.9, 'kick808', 'pulse', 'hit'));
    notes.push(mk(b + 0.5, 0.1, 42, 0.5, 'drumkit', 'pulse', 'hit'));
    if (b % 2 === 1) notes.push(mk(b, 0.1, 38, 0.7, 'drumkit', 'pulse', 'hit'));
    notes.push(mk(b, 0.5, 62 + [0, 3, 7, 10][b % 4], 0.6, 'pluck', 'figuration', 'staccato'));
  }
  notes.push(mk(0, 4, 38, 0.8, 'sub', 'bass'), mk(4, 4, 34, 0.8, 'sub', 'bass'));
  for (const m of [50, 57, 62, 65]) notes.push(mk(0, 8, m, 0.5, 'pad', 'texture'));
  notes.push(mk(0, 8, 60, 0.7, 'noise', 'texture'));
  // not loaded on purpose → pad / pluck stand-ins, warned once each
  notes.push(mk(0, 4, 74, 0.6, 'flute', 'melody'), mk(4, 0.3, 77, 0.6, 'flute', 'melody', 'staccato'));
  notes.push(mk(4, 4, 69, 0.5, 'violins', 'counter', 'tremolo'), mk(4, 4, 69, 0.5, 'violins2', 'counter', 'tremolo'));
  return {
    index: 100, section: 0, role: 'statement', bars: 2, beatsPerBar: 4, beats: 8, bpm: 100, notes, pedal: [],
    mix: { dynamics: 4, lowpass: 5, reverb: 2, delay: 3, noise: 3, width: 4, saturation: 3, chorus: true, sidechain: true },
    holdChord: [{ midi: 38, vel: 0.5, inst: 'sub', art: 'sustain' }, { midi: 57, vel: 0.4, inst: 'pad', art: 'sustain' }],
    cutAtBeat: undefined,
    display: { key: 'D minor', notation: '', lineage: '', chords: [], layers: [], tension: 4 },
  };
}

async function synths(): Promise<void> {
  const e = await ensureEngine();
  await e.unlock();
  await e.loadInstruments(['drumkit']);
  e.stop();
  e.setSoundWorld('electronic_hybrid');
  e.enqueue(synthScore());
  e.enqueue({ ...synthScore(), index: 101, final: true, cutAtBeat: 7 });
  e.start();
  say('started: synths, sidechain, drums, fallbacks; second phrase is final with a sudden stop at beat 7');
}

// video-locked demo on a fake clock
const fake = { base: 0, startedAt: 0, running: false };
const clock = {
  now: (): number => (fake.running ? fake.base + (performance.now() - fake.startedAt) / 1000 : fake.base),
  playing: (): boolean => fake.running,
};

async function synced(): Promise<void> {
  const e = await ensureEngine();
  if (!loaded) await load();
  const scores: PhraseScore[] = [];
  let at = 1;
  for (const s of asFinal(demoScores)) {
    scores.push({ ...s, startSec: at });
    at += (s.beats * 60) / s.bpm + (s.ritardando ? 1.5 : 0);
  }
  fake.base = 0;
  fake.startedAt = performance.now();
  fake.running = true;
  e.playSynced(scores, clock);
  say(`video-locked: phrases at ${scores.map((s) => (s.startSec as number).toFixed(2)).join(', ')} s on the fake clock`);
}

function pause(): void {
  if (fake.running) {
    fake.base = clock.now();
    fake.running = false;
  } else {
    fake.startedAt = performance.now();
    fake.running = true;
  }
  say(`clock ${fake.running ? 'playing' : 'paused'} at ${clock.now().toFixed(2)} s`);
}

function seek(to = 4): void {
  fake.base = to;
  fake.startedAt = performance.now();
  say(`clock seek → ${to} s`);
}

function stop(): void {
  fake.running = false;
  engine?.stop();
  say('stop()');
}

const wrap = (fn: () => void | Promise<void>) => (): void => {
  Promise.resolve()
    .then(fn)
    .catch((err) => say('ERROR ' + (err instanceof Error ? err.stack ?? err.message : String(err))));
};
$('load').onclick = wrap(() => load());
$('demo').onclick = wrap(demo);
$('synths').onclick = wrap(synths);
$('synced').onclick = wrap(synced);
$('pause').onclick = wrap(pause);
$('seek').onclick = wrap(() => seek());
$('stop').onclick = wrap(stop);

// meters
const meterEl = $('meters');
const rows = new Map<string, { bar: HTMLElement; num: HTMLElement }>();
for (const name of [...LAYER_ROLES, 'master']) {
  const label = document.createElement('span');
  label.textContent = name;
  const bar = document.createElement('span');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.append(fill);
  const num = document.createElement('span');
  meterEl.append(label, bar, num);
  rows.set(name, { bar: fill, num });
}
function paint(): void {
  if (engine) {
    const lv: Record<string, number> = { ...engine.levels(), master: engine.masterLevel() };
    for (const [name, row] of rows) {
      const v = lv[name] ?? 0;
      peaks[name] = Math.max(peaks[name] ?? 0, v);
      row.bar.style.width = `${Math.round(v * 100)}%`;
      row.num.textContent = v.toFixed(2);
    }
    const ph = engine.playhead();
    $('status').textContent = `phrase ${ph.index}  beat ${ph.beat.toFixed(2)} / ${ph.beats}  ${ph.holding ? 'HOLDING' : ''}  ${ph.playing ? 'playing' : 'stopped'}  buffered ${engine.bufferedAhead()}`;
  }
}
// a timer as well as rAF, so the meters keep sampling when the tab is not in front
setInterval(paint, 100);
const frame = (): void => {
  paint();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

// for poking at from the console
Object.assign(window, {
  smoke: { load, demo, synths, synced, pause, seek, stop, events, lines, peaks, clock, get engine() { return engine; }, Tone },
});
