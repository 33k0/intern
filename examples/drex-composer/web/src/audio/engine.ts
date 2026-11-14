// Drex Composer audio engine. Plays PhraseScore objects on a look-ahead scheduler driven by
// the Web Audio clock: phrases back to back, a re-grained hold when the buffer runs dry, a
// video-locked mode for scores pinned to an external clock. See README.md in this folder.

import * as Tone from 'tone';
import type { HoldNote, HoldUpdate, InstrumentId, LayerRole, MixState, NoteEvent, PhraseScore, SoundWorld, Step7 } from '../../../shared/types.ts';
import { beatToSec } from '../../../shared/types.ts';
import { LAYER_ROLES, MixGraph, makeSyntheticIr } from './graph.ts';
import { IR_BASE_URL, IR_INDEX_URL, MANIFEST_URL, SIDECAR_URL, emptyManifest, isSynthId, isUnpitched, joinUrl, normalizeManifest, sampleSourceId } from './manifest.ts';
import type { IrEntry, ManifestSidecar, SampleManifest } from './manifest.ts';
import { DEFAULT_MIX, WORLDS, curveLevel, delayTimeSec, mergeMix, mixToParams } from './mixmap.ts';
import type { MixParams } from './mixmap.ts';
import { dbToGain } from './selection.ts';
import { planPhrase } from './plan.ts';
import type { PhrasePlan, PlannedNote } from './plan.ts';
import { Sampler } from './sampler.ts';
import type { Voice } from './sampler.ts';
import { SynthBank } from './synths.ts';
import { Ticker } from './ticker.ts';
import { LOOKAHEAD_SEC, START_LEAD_SEC, SYNC_DRIFT_SEC, TAIL_SEC, TICK_MS, firstAtOrAfter, holdResumeTime, secToBeat } from './timeline.ts';

export type EngineEvent =
  | { type: 'phrase_started'; index: number }
  | { type: 'hold_started'; afterIndex: number }
  | { type: 'hold_ended' }
  | { type: 'ended' };

export interface EngineOptions {
  /** Which entry of /assets/ir/ir.json to use for the hall (default: the first). */
  irId?: string;
  /** Changes the humanisation; the same seed gives the same performance. */
  seed?: number;
}

export interface SyncClock {
  /** Position of the external clock in seconds (e.g. video.currentTime). */
  now(): number;
  playing(): boolean;
}

/** A live offset layered on top of whatever MixState is current. */
export interface Nudge {
  /** Master level offset, dB. */
  gainDb?: number;
  /** Offset in lowpass steps (negative = darker). */
  lowpassSteps?: number;
  /** Offset in reverb steps. */
  reverbSteps?: number;
}

export interface Playhead {
  index: number;
  beat: number;
  beats: number;
  holding: boolean;
  playing: boolean;
}

/** Mix changes glide over this long at phrase starts. */
const MIX_RAMP_SEC = 0.4;
const HOLD_ATTACK_SEC = 1.5;
const HOLD_RELEASE_SEC = 1.2;
/**
 * The hold is only committed this close to the end of the last phrase; a phrase that arrives
 * any earlier still starts exactly on the downbeat.
 */
const HOLD_DECIDE_SEC = 0.1;
/** Scheduling margin when a phrase resumes out of a hold. */
const RESUME_LEAD_SEC = 0.08;
/** Instruments that are struck or plucked: a missing one is stood in for by the pluck synth, never the pad. */
const STRUCK = new Set<string>(['piano', 'harp', 'celesta', 'glockenspiel', 'vibraphone', 'timpani']);

/** Where the scheduler is within one phrase. */
interface PhraseCursor {
  score: PhraseScore;
  plan: PhrasePlan;
  cursor: number;
  kickCursor: number;
  pedalCursor: number;
  cutDone: boolean;
  /** Synced mode: when pedal-carried piano notes are let go, seconds from phrase start. */
  carryOffSec: number | null;
}

interface ActivePhrase extends PhraseCursor {
  start: number;
  end: number;
}

type HoldEntry =
  | { kind: 'sample'; voice: Voice; vel: number }
  | { kind: 'synth'; inst: 'sub' | 'pad'; layer: LayerRole; midi: number }
  | { kind: 'noise' }
  | { kind: 'none' };

interface HoldState {
  afterIndex: number;
  /** Audio time the previous phrase ended: beat 0 of the grid that runs through the hold. */
  origin: number;
  secPerBeat: number;
  entries: Map<string, HoldEntry>;
  layerOf: Map<InstrumentId, LayerRole>;
  /** hold_started has been emitted. */
  announced: boolean;
  /** The next phrase arrived in time to start exactly at `origin`: no hold events at all. */
  silent: boolean;
}

interface SyncPhrase extends PhraseCursor {
  startSec: number;
  endSec: number;
  entered: boolean;
}

/** A note added with scheduleAt(): its own time on the external clock. */
interface SyncExtra {
  clockSec: number;
  pn: PlannedNote;
}

interface SyncState {
  clock: SyncClock;
  phrases: SyncPhrase[];
  /** Sorted by clockSec; entries are removed as they are scheduled. */
  extras: SyncExtra[];
  /** audio time − clock time, smoothed; null until anchored. */
  offset: number | null;
  running: boolean;
  driftTicks: number;
  lastEnd: number;
  endedEmitted: boolean;
}

interface Timed {
  time: number;
  seq: number;
  run: () => void;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export class AudioEngine {
  private readonly ctx: BaseAudioContext;
  private readonly graph: MixGraph;
  private readonly sampler: Sampler;
  private readonly synths: SynthBank;
  private readonly ticker: Ticker;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly seed: number;
  private readonly warned = new Set<string>();

  private mode: 'idle' | 'free' | 'synced' = 'idle';
  private mix: MixState = { ...DEFAULT_MIX };
  private world: SoundWorld = 'large_hall';
  private offsets: Required<Nudge> = { gainDb: 0, lowpassSteps: 0, reverbSteps: 0 };
  private timed: Timed[] = [];
  private timedSeq = 0;
  private lastTickAt = 0;

  // free-running
  private queue: PhraseScore[] = [];
  private sched: ActivePhrase | null = null;
  private timeline: ActivePhrase[] = [];
  private hold: HoldState | null = null;
  /** The hold that is still audible while the phrase that ends it waits for its beat. */
  private holdTail: { origin: number; until: number } | null = null;
  private finishing = false;
  private pedalDown = false;
  private pedalCarry: Voice[] = [];

  // video-locked
  private sync: SyncState | null = null;

  private constructor(ctx: BaseAudioContext, manifest: SampleManifest, sidecar: ManifestSidecar | null, seed: number) {
    this.ctx = ctx;
    this.seed = seed;
    this.graph = new MixGraph(ctx);
    const busFor = (layer: LayerRole): AudioNode => this.graph.busInput(layer);
    this.sampler = new Sampler(ctx, manifest, busFor, seed ^ 0x5eed, sidecar);
    this.synths = new SynthBank(ctx, busFor, this.graph.noiseBed);
    this.ticker = new Ticker(this.tick, TICK_MS);
  }

  /** Fetches the sample manifest and the IR index and builds the graph. Makes no sound. */
  static async create(opts: EngineOptions = {}): Promise<AudioEngine> {
    const ctx = Tone.getContext().rawContext;
    const [manifest, irs, sidecar] = await Promise.all([
      fetchJson(MANIFEST_URL).then(normalizeManifest).catch((err) => {
        console.warn('[audio] sample manifest unavailable; every sampled instrument will use a synth stand-in', err);
        return emptyManifest();
      }),
      fetchJson(IR_INDEX_URL).then((x) => (Array.isArray(x) ? (x as IrEntry[]) : [])).catch((err) => {
        console.warn('[audio] impulse-response index unavailable', err);
        return [] as IrEntry[];
      }),
      // optional: measured levels per file; without it the levels are measured from the decoded audio
      fetchJson(SIDECAR_URL).then((x) => (x && typeof x === 'object' ? (x as ManifestSidecar) : null)).catch(() => null),
    ]);
    const engine = new AudioEngine(ctx, manifest, sidecar, opts.seed ?? 0);
    await engine.loadImpulse(irs, opts.irId);
    return engine;
  }

  private async loadImpulse(irs: IrEntry[], irId?: string): Promise<void> {
    const entry = (irId ? irs.find((x) => x.id === irId) : undefined) ?? irs[0];
    if (entry?.file) {
      try {
        const res = await fetch(joinUrl(IR_BASE_URL, entry.file));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.graph.setImpulse(await this.ctx.decodeAudioData(await res.arrayBuffer()));
        return;
      } catch (err) {
        console.warn(`[audio] hall impulse response "${entry.id}" failed to load; using a synthetic one`, err);
      }
    } else {
      console.warn('[audio] no hall impulse response listed; using a synthetic one');
    }
    this.graph.setImpulse(makeSyntheticIr(this.ctx));
  }

  // ───────────────────────────── Public API ─────────────────────────────

  /** Resume the audio context. Call from a user gesture. */
  async unlock(): Promise<void> {
    await Tone.start();
    this.ticker.start();
  }

  /** Fetch and decode the samples for these instruments (synth ids and unknown ids are skipped). */
  loadInstruments(ids: InstrumentId[], onProgress?: (loaded: number, total: number) => void): Promise<void> {
    return this.sampler.load(ids, onProgress);
  }

  /** Base reverb / filter character. Scales the MixState mapping; does not replace it. */
  setSoundWorld(world: SoundWorld): void {
    if (!WORLDS[world]) return;
    this.world = world;
    const t = this.ctx.currentTime;
    this.graph.setPreDelay(WORLDS[world].preDelaySec, t);
    this.graph.applyMix(this.params(), t, MIX_RAMP_SEC);
  }

  /** Append a phrase to the play queue (free-running mode). */
  enqueue(score: PhraseScore): void {
    if (this.mode === 'synced') {
      console.warn('[audio] enqueue() ignored in video-locked mode');
      return;
    }
    if (this.finishing) return; // the final phrase is already out
    this.queue.push(score);
    if (this.mode === 'free') this.tick();
  }

  /** Begin playing the queue. If it is empty, playback begins as soon as the first phrase arrives. */
  start(): void {
    if (this.mode === 'synced') this.stop();
    if (this.mode === 'free') return;
    this.mode = 'free';
    this.graph.restore(this.ctx.currentTime);
    this.ticker.start();
    this.tick();
  }

  /** Silence everything, clear the queue, reset. Also leaves video-locked mode. */
  stop(): void {
    const now = this.ctx.currentTime;
    this.mode = 'idle';
    this.queue = [];
    this.sched = null;
    this.timeline = [];
    this.hold = null;
    this.holdTail = null;
    this.finishing = false;
    this.pedalDown = false;
    this.pedalCarry = [];
    this.sync = null;
    this.timed = [];
    this.offsets = { gainDb: 0, lowpassSteps: 0, reverbSteps: 0 };
    this.sampler.killAll(now);
    this.synths.releaseAll(now);
    this.graph.reset(now, true);
  }

  /** While holding: crossfade the held sustain to `update.notes` over `update.overSec` and glide the mix. */
  applyHold(update: HoldUpdate): void {
    const h = this.hold;
    if (!h || this.mode !== 'free') return; // a late update for a hold that is already over
    const t = this.ctx.currentTime + 0.03;
    const over = Math.min(30, Math.max(0.2, Number.isFinite(update.overSec) ? update.overSec : 2));
    const target = new Map<string, HoldNote>();
    for (const n of update.notes ?? []) target.set(holdKey(n), n);
    for (const [key, entry] of [...h.entries]) {
      if (target.has(key)) continue;
      this.holdNoteOff(key, entry, t, Math.max(over, HOLD_RELEASE_SEC)); // removed notes leave slowly
      h.entries.delete(key);
    }
    for (const [key, n] of target) {
      const existing = h.entries.get(key);
      if (!existing) {
        this.holdNoteOn(h, n, t, Math.max(0.4, over));
      } else if (existing.kind === 'sample' && Math.abs(existing.vel - n.vel) > 0.01) {
        this.sampler.setLevel(existing.voice, n.vel, t, over);
        existing.vel = n.vel;
      }
    }
    if (update.mix) {
      this.mix = mergeMix(this.mix, update.mix);
      this.graph.applyMix(this.params(), t, over);
    }
  }

  /** Subscribe to engine events; returns the unsubscribe function. */
  on(cb: (e: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Phrases queued (or scheduled) that have not audibly started. */
  bufferedAhead(): number {
    if (this.mode === 'synced' && this.sync) {
      const c = this.sync.clock.now();
      return this.sync.phrases.filter((p) => p.startSec > c).length;
    }
    const now = this.audibleNow();
    let n = this.queue.length;
    for (const p of this.timeline) if (p.start > now) n++;
    return n;
  }

  playhead(): Playhead {
    if (this.mode === 'synced' && this.sync) {
      const s = this.sync;
      const c = s.clock.now();
      let cur: SyncPhrase | null = null;
      for (const p of s.phrases) {
        if (p.startSec <= c) cur = p;
        else break;
      }
      const playing = s.clock.playing();
      if (!cur) return { index: -1, beat: 0, beats: 0, holding: false, playing };
      const beat = Math.min(cur.score.beats, Math.max(0, secToBeat(cur.score, c - cur.startSec)));
      return { index: cur.score.index, beat, beats: cur.score.beats, holding: false, playing };
    }
    const now = this.audibleNow();
    const playing = this.mode === 'free';
    let cur: ActivePhrase | null = null;
    for (const p of this.timeline) if (p.start <= now) cur = p;
    if (!cur) return { index: -1, beat: 0, beats: 0, holding: false, playing };
    const tail = this.holdTail;
    const holding = (!!this.hold && now >= this.hold.origin) || (!!tail && now >= tail.origin && now < tail.until);
    const beat = holding || now >= cur.end ? cur.score.beats : Math.max(0, secToBeat(cur.score, now - cur.start));
    return { index: cur.score.index, beat, beats: cur.score.beats, holding, playing };
  }

  /** Smoothed 0..1 meter per layer bus. */
  levels(): Record<LayerRole, number> {
    return this.graph.levels();
  }

  masterLevel(): number {
    return this.graph.masterLevel();
  }

  /**
   * Video-locked mode: every phrase is known up front and carries `startSec` on the external
   * clock. Follows play / pause / seek of the clock. Leave with stop().
   */
  playSynced(scores: PhraseScore[], clock: SyncClock): void {
    this.stop();
    const list = scores
      .filter((s) => typeof s.startSec === 'number' && Number.isFinite(s.startSec))
      .sort((a, b) => (a.startSec as number) - (b.startSec as number));
    if (list.length < scores.length) console.warn(`[audio] playSynced: ${scores.length - list.length} phrase(s) without startSec were dropped`);
    const phrases: SyncPhrase[] = [];
    let pedalDown = false;
    let prevEnd = -Infinity;
    for (const score of list) {
      const startSec = score.startSec as number;
      const contiguous = Math.abs(startSec - prevEnd) < 0.08;
      const plan = planPhrase(score, {
        pedalInitiallyDown: contiguous && pedalDown && (score.pedal?.length ?? 0) > 0, seed: this.seed, swellPeaks: this.sampler.swellPeaks(),
      });
      phrases.push({ score, plan, startSec, endSec: startSec + plan.seconds, cursor: 0, kickCursor: 0, pedalCursor: 0, cutDone: false, carryOffSec: plan.seconds, entered: false });
      pedalDown = plan.pedalEndsDown;
      prevEnd = startSec + plan.seconds;
    }
    // notes the pedal carries past a phrase end are let go at the next phrase's first pedal lift (or its start)
    for (let i = 0; i + 1 < phrases.length; i++) {
      const a = phrases[i];
      const b = phrases[i + 1];
      if (Math.abs(b.startSec - a.endSec) < 0.08) a.carryOffSec = b.startSec - a.startSec + (b.plan.firstPedalUpSec ?? 0);
    }
    this.sync = {
      clock, phrases, extras: [], offset: null, running: false, driftTicks: 0,
      lastEnd: phrases.reduce((m, p) => Math.max(m, p.endSec), 0), endedEmitted: false,
    };
    this.mode = 'synced';
    this.graph.restore(this.ctx.currentTime);
    this.ticker.start();
    this.tick();
  }

  /**
   * Video-locked mode: play extra notes (accent hits) whose `t` is in beats, at `bpm`, counted
   * from `clockSec` on the external clock. Ignored outside video-locked mode, and when
   * `clockSec` is already more than 50 ms in the past. Played exactly as written (no humanising).
   */
  scheduleAt(clockSec: number, notes: NoteEvent[], bpm: number): void {
    const s = this.sync;
    if (this.mode !== 'synced' || !s || !Number.isFinite(clockSec) || !(bpm > 0)) return;
    if (s.clock.now() - clockSec > 0.05) return;
    const spb = 60 / bpm;
    notes.forEach((n, i) => {
      if (!(n.vel > 0) || !Number.isFinite(n.t) || !Number.isFinite(n.midi)) return;
      const durSec = Math.max(0.02, (n.dur || 0) * spb);
      const pn: PlannedNote = { i, note: n, onSec: 0, offSec: durSec, durSec, vel: Math.min(1, n.vel), detuneCents: 0, legato: false, pedalAtOnset: false, kick: false };
      const at = clockSec + n.t * spb;
      const idx = firstAtOrAfter(s.extras, (x) => x.clockSec, at + 1e-9);
      s.extras.splice(idx, 0, { clockSec: at, pn });
    });
    this.tick();
  }

  /**
   * A live offset on top of the current MixState, glided in over `overSec`. Fields left out keep
   * their previous offset. Later phrase mixes are applied with the offset still in place;
   * stop() clears it.
   */
  nudge(change: Nudge, overSec: number): void {
    const num = (x: number | undefined, lo: number, hi: number, prev: number): number =>
      typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : prev;
    this.offsets = {
      gainDb: num(change.gainDb, -60, 12, this.offsets.gainDb),
      lowpassSteps: num(change.lowpassSteps, -6, 6, this.offsets.lowpassSteps),
      reverbSteps: num(change.reverbSteps, -6, 6, this.offsets.reverbSteps),
    };
    const over = Math.min(60, Math.max(0.02, Number.isFinite(overSec) ? overSec : 0.4));
    this.graph.applyMix(this.params(), this.ctx.currentTime, over);
  }

  /** The current MixState with the sound world and the live nudge applied. */
  private params(): MixParams {
    const o = this.offsets;
    const clampStep = (x: number): number => Math.min(6, Math.max(0, x));
    // fractional steps are fine: the mapping interpolates
    const mix = { ...this.mix, lowpass: clampStep(this.mix.lowpass + o.lowpassSteps), reverb: clampStep(this.mix.reverb + o.reverbSteps) } as MixState;
    const p = mixToParams(mix, this.world);
    return o.gainDb ? { ...p, master: p.master * dbToGain(o.gainDb) } : p;
  }

  /** Stop and release the timer and the synth nodes. The engine is not usable afterwards. */
  dispose(): void {
    this.stop();
    this.ticker.stop();
    this.synths.dispose();
    this.graph.dispose();
    this.listeners.clear();
  }

  // ───────────────────────────── Timing plumbing ─────────────────────────────

  private latency(): number {
    const l = (this.ctx as AudioContext).outputLatency;
    return typeof l === 'number' && Number.isFinite(l) ? Math.min(0.3, Math.max(0, l)) : 0;
  }

  /** The audio-clock time of what is leaving the speakers right now. */
  private audibleNow(): number {
    return this.ctx.currentTime - this.latency();
  }

  private emit(e: EngineEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch (err) {
        console.error('[audio] event listener threw', err);
      }
    }
  }

  /** Run `run` when audio time `time` is being heard. */
  private at(time: number, run: () => void): void {
    const item: Timed = { time, seq: this.timedSeq++, run };
    let i = this.timed.length;
    while (i > 0 && this.timed[i - 1].time > time) i--;
    this.timed.splice(i, 0, item);
  }

  private flushTimed(): void {
    const now = this.audibleNow();
    while (this.timed.length && this.timed[0].time <= now) {
      const item = this.timed.shift() as Timed;
      try {
        item.run();
      } catch (err) {
        console.error('[audio] timed callback threw', err);
      }
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  private tick = (): void => {
    const now = this.ctx.currentTime;
    const gap = this.lastTickAt > 0 ? now - this.lastTickAt : 0;
    this.lastTickAt = now;
    // if ticks are arriving late (throttled tab, busy main thread) look further ahead to cover the gap
    const horizon = now + Math.min(1.5, Math.max(LOOKAHEAD_SEC, gap * 2 + 0.1));
    try {
      if (this.mode === 'free') this.tickFree(now, horizon);
      else if (this.mode === 'synced') this.tickSynced(now, horizon);
    } catch (err) {
      console.error('[audio] scheduler error', err);
    }
    try {
      this.sampler.service(now, horizon);
      this.synths.service(now);
    } catch (err) {
      console.error('[audio] voice service error', err);
    }
    this.flushTimed();
  };

  // ───────────────────────────── Scheduling shared by both modes ─────────────────────────────

  /** `phraseStart` differs from `time` only when playback lands inside a phrase. */
  private applyPhraseMix(score: PhraseScore, time: number, rampSec: number, phraseStart = time): void {
    const curve = score.dynCurve && score.dynCurve.length > 1 ? score.dynCurve : null;
    this.mix = { ...DEFAULT_MIX, ...score.mix };
    if (curve) this.mix.dynamics = curveLevel(curve, secToBeat(score, Math.max(0, time - phraseStart))) as Step7;
    this.graph.applyMix(this.params(), time, rampSec);
    this.graph.setDelayTime(delayTimeSec(score.bpm), time);
    if (!curve) return;
    // A crescendo, diminuendo or swell: the level moves through the phrase in short eased steps.
    // Every step starts before the phrase ends, so the next phrase's mix cancels nothing it should keep.
    const STEP_BEATS = 0.5;
    const lastBeat = Math.min(score.beats, curve[curve.length - 1].beat);
    for (let b = STEP_BEATS; b <= lastBeat + 1e-6; b += STEP_BEATS) {
      const from = phraseStart + beatToSec(score, b - STEP_BEATS);
      if (from < time + rampSec) continue;
      this.mix.dynamics = curveLevel(curve, b) as Step7;
      this.graph.easeMaster(this.params().master, from, (beatToSec(score, b) - beatToSec(score, b - STEP_BEATS)) / 2);
    }
    // Where the phrase leaves the level: a hold that follows carries on from there.
    this.mix.dynamics = curveLevel(curve, lastBeat) as Step7;
  }

  /** Schedule everything in the phrase that starts before `horizon` (audio time). */
  private schedulePhrase(p: PhraseCursor, start: number, horizon: number): void {
    const plan = p.plan;
    const limit = horizon - start;
    while (p.cursor < plan.notes.length && plan.notes[p.cursor].onSec < limit) {
      this.scheduleNote(p, plan.notes[p.cursor], start);
      p.cursor++;
    }
    while (p.kickCursor < plan.kickSecs.length && plan.kickSecs[p.kickCursor] < limit) {
      if (p.score.mix?.sidechain) this.graph.duck(start + plan.kickSecs[p.kickCursor]);
      p.kickCursor++;
    }
    while (p.pedalCursor < plan.pedal.length && plan.pedal[p.pedalCursor].sec < limit) {
      const m = plan.pedal[p.pedalCursor++];
      if (this.sampler.ready('piano')) this.sampler.pedalNoise(m.down, start + m.sec, plan.layerOfInst.get('piano') ?? 'melody');
    }
    if (plan.cutSec !== null && !p.cutDone && plan.cutSec < limit) {
      // sudden stop: dry signal muted within ~25 ms, voices killed, reverb and delay tails left ringing
      const t = start + plan.cutSec;
      this.graph.scheduleCut(t);
      this.sampler.killAll(t);
      this.synths.releaseAll(t);
      this.pedalCarry = [];
      p.cutDone = true;
    }
  }

  private scheduleNote(p: PhraseCursor, pn: PlannedNote, start: number): void {
    const n = pn.note;
    const t = start + pn.onSec;
    if (isSynthId(n.inst)) {
      if (n.inst === 'noise') this.synths.noiseSwell(n.layer, t, pn.durSec, pn.vel);
      else this.synths.trigger(n.inst, n.layer, n.midi, pn.vel, t, pn.durSec);
      return;
    }
    if (pn.swell && this.sampler.ready('cymbal') && this.sampler.cymbalSwell(start + pn.swell.peakSec, pn.swell.leadSec, pn.vel, n.layer)) return;
    const off = pn.offSec !== null ? start + pn.offSec : p.carryOffSec !== null ? start + p.carryOffSec : null;
    const v = this.sampler.ready(n.inst)
      ? this.sampler.play({ inst: n.inst, midi: n.midi, vel: pn.vel, art: n.art, layer: n.layer, time: t, offTime: off, detuneCents: pn.detuneCents, legato: pn.legato })
      : null;
    if (!v) {
      this.fallbackNote(n.inst, n.layer, n.midi, pn.vel, n.art, t, pn.durSec);
      return;
    }
    if (n.inst === 'piano') {
      if (off === null) {
        this.pedalCarry.push(v);
      } else if (pn.offSec !== null && pn.offSec <= pn.onSec + pn.durSec + 0.05) {
        // released by the key, not by the pedal: the damper is heard (a pedal lift has its own noise)
        this.sampler.pianoReleaseNoise(n.midi, pn.vel, off, n.layer);
      }
    }
  }

  /** An instrument with no playable samples: pad for sustained lines, pluck for short or struck ones. */
  private fallbackNote(inst: InstrumentId, layer: LayerRole, midi: number, vel: number, art: string, time: number, durSec: number): void {
    this.warnOnce(`missing:${inst}`, `[audio] no samples loaded for "${inst}"; using a synth stand-in`);
    this.sampler.ensureLoading(inst);
    const src = sampleSourceId(inst);
    if (isUnpitched(src)) {
      if (src === 'drumkit' && midi === 36) this.synths.trigger('kick808', layer, 36, vel, time, 0.4);
      return;
    }
    const sustained = (art === 'sustain' || art === 'tremolo' || art === 'roll') && durSec >= 0.35 && !STRUCK.has(src);
    if (sustained) this.synths.trigger('pad', layer, midi, vel * 0.9, time, durSec, 'fallback');
    else this.synths.trigger('pluck', layer, midi, vel, time, Math.min(durSec, 0.5));
  }

  // ───────────────────────────── Free-running mode ─────────────────────────────

  private tickFree(now: number, horizon: number): void {
    for (let guard = 0; guard < 16; guard++) {
      const cur = this.sched;
      if (!cur) {
        if (this.finishing || !this.queue.length) return;
        const next = this.queue.shift() as PhraseScore;
        if (this.hold) this.resumeFromHold(next, now);
        else this.activate(next, now + START_LEAD_SEC);
        continue;
      }
      this.schedulePhrase(cur, cur.start, horizon);
      if (cur.end > horizon) return;
      // scheduled through to its last beat (plus anything written past the end)
      this.schedulePhrase(cur, cur.start, Infinity);
      if (cur.score.final) {
        this.finish(cur);
        return;
      }
      if (this.queue.length) {
        this.activate(this.queue.shift() as PhraseScore, cur.end);
        continue;
      }
      // nothing queued: wait until the last moment a new phrase could still make the downbeat
      if (cur.end - now > HOLD_DECIDE_SEC) return;
      this.beginHold(cur, now);
      return;
    }
  }

  private activate(score: PhraseScore, start: number): void {
    const hasMarks = (score.pedal?.length ?? 0) > 0;
    // a phrase with no pedal marks at all implies a pedal change on its downbeat
    const plan = planPhrase(score, { pedalInitiallyDown: hasMarks && this.pedalDown, seed: this.seed, swellPeaks: this.sampler.swellPeaks() });
    const ap: ActivePhrase = { score, plan, start, end: start + plan.seconds, cursor: 0, kickCursor: 0, pedalCursor: 0, cutDone: false, carryOffSec: null };
    this.sched = ap;
    const now = this.ctx.currentTime;
    // keep what is still sounding, and always the phrase before this one (the playhead sits on it until `start`)
    const last = this.timeline[this.timeline.length - 1];
    this.timeline = this.timeline.filter((p) => p === last || p.end > now - 2).slice(-4);
    this.timeline.push(ap);

    this.graph.restore(start);
    this.applyPhraseMix(score, start, MIX_RAMP_SEC);
    if (plan.fade) this.graph.scheduleFade(start + plan.fade.fromSec, start + plan.fade.toSec);

    if (this.pedalCarry.length && (!hasMarks || plan.firstPedalUpSec !== null)) {
      const liftAt = start + (plan.firstPedalUpSec ?? 0);
      for (const v of this.pedalCarry) this.sampler.release(v, liftAt, v.relSec);
      this.pedalCarry = [];
    }
    this.pedalDown = plan.pedalEndsDown;

    this.at(start, () => this.emit({ type: 'phrase_started', index: score.index }));
  }

  private finish(cur: ActivePhrase): void {
    this.sched = null;
    this.finishing = true;
    this.queue = [];
    this.at(cur.end + TAIL_SEC, () => {
      this.finishing = false;
      this.mode = 'idle';
      this.emit({ type: 'ended' });
    });
  }

  private beginHold(cur: ActivePhrase, now: number): void {
    const h: HoldState = {
      afterIndex: cur.score.index,
      origin: cur.end,
      secPerBeat: 60 / cur.score.bpm,
      entries: new Map(),
      layerOf: cur.plan.layerOfInst,
      announced: false,
      silent: false,
    };
    this.hold = h;
    this.sched = null;
    // let the phrase's last sustains fall away slowly under the hold as it fades in: no gap
    this.sampler.extendReleases(cur.end - 0.4, cur.end + 0.15, 1.6);
    const tOn = Math.max(now + 0.02, cur.end - 0.15);
    if (!cur.cutDone) for (const n of cur.score.holdChord ?? []) this.holdNoteOn(h, n, tOn, HOLD_ATTACK_SEC);
    this.at(cur.end, () => {
      if (h.silent) return;
      h.announced = true;
      this.emit({ type: 'hold_started', afterIndex: h.afterIndex });
    });
  }

  private holdNoteOn(h: HoldState, n: HoldNote, time: number, attackSec: number): void {
    const key = holdKey(n);
    if (h.entries.has(key) || !(n.vel > 0)) return;
    const layer = h.layerOf.get(n.inst) ?? 'pedal';
    if (isSynthId(n.inst)) {
      if (n.inst === 'sub' || n.inst === 'pad') {
        this.synths.holdOn(n.inst, layer, n.midi, n.vel, time, attackSec);
        h.entries.set(key, { kind: 'synth', inst: n.inst, layer, midi: n.midi });
      } else if (n.inst === 'noise') {
        this.synths.noiseHoldOn(key, layer, n.vel, time, attackSec);
        h.entries.set(key, { kind: 'noise' });
      } else {
        if (n.inst === 'pluck') this.synths.trigger('pluck', layer, n.midi, n.vel, time, 0.5);
        h.entries.set(key, { kind: 'none' }); // pluck rings once; a kick has no place in a held chord
      }
      return;
    }
    const v = this.sampler.ready(n.inst)
      ? this.sampler.play({ inst: n.inst, midi: n.midi, vel: n.vel, art: n.art, layer, time, offTime: null, attackSec, held: true })
      : null;
    if (v) {
      // sustains are re-grained for as long as the hold lasts; piano / harp get one strike and ring out
      h.entries.set(key, { kind: 'sample', voice: v, vel: n.vel });
      return;
    }
    this.warnOnce(`missing:${n.inst}`, `[audio] no samples loaded for "${n.inst}"; using a synth stand-in`);
    this.sampler.ensureLoading(n.inst);
    const src = sampleSourceId(n.inst);
    if (isUnpitched(src)) {
      h.entries.set(key, { kind: 'none' });
    } else if (STRUCK.has(src)) {
      this.synths.trigger('pluck', layer, n.midi, n.vel, time, 0.5);
      h.entries.set(key, { kind: 'none' });
    } else {
      this.synths.holdOn('pad', layer, n.midi, n.vel * 0.9, time, attackSec);
      h.entries.set(key, { kind: 'synth', inst: 'pad', layer, midi: n.midi });
    }
  }

  private holdNoteOff(key: string, entry: HoldEntry, time: number, releaseSec: number): void {
    if (entry.kind === 'sample') this.sampler.release(entry.voice, time, releaseSec);
    else if (entry.kind === 'synth') this.synths.holdOff(entry.inst, entry.layer, entry.midi, time, releaseSec);
    else if (entry.kind === 'noise') this.synths.noiseHoldOff(key, time, releaseSec);
  }

  /** A phrase arrived during the hold: start it on the next whole beat of the grid, held notes fall away under it. */
  private resumeFromHold(next: PhraseScore, now: number): void {
    const h = this.hold as HoldState;
    const { time } = holdResumeTime(h.origin, h.secPerBeat, now + RESUME_LEAD_SEC);
    for (const [key, entry] of h.entries) this.holdNoteOff(key, entry, time, HOLD_RELEASE_SEC);
    if (time <= h.origin + 1e-6) {
      h.silent = true; // made it in time for the downbeat: there was no hold
    } else {
      this.holdTail = { origin: h.origin, until: time };
      this.at(time, () => this.emit({ type: 'hold_ended' }));
    }
    this.hold = null;
    this.activate(next, time);
  }

  // ───────────────────────────── Video-locked mode ─────────────────────────────

  private tickSynced(now: number, horizon: number): void {
    const s = this.sync as SyncState;
    const c = s.clock.now();
    if (!s.clock.playing() || !Number.isFinite(c)) {
      if (s.running) {
        // paused: let go of everything quickly
        this.sampler.releaseAll(now, 0.08);
        this.synths.releaseAll(now);
        this.timed = [];
        s.running = false;
      }
      s.offset = null;
      return;
    }
    const measured = now - c;
    let resync = s.offset === null;
    if (s.offset !== null) {
      const err = measured - s.offset;
      if (Math.abs(err) > SYNC_DRIFT_SEC) {
        // one bad reading is tolerated; a jump (seek) or a second one in a row is not
        s.driftTicks++;
        if (Math.abs(err) > 0.25 || s.driftTicks >= 2) resync = true;
      } else {
        s.driftTicks = 0;
        s.offset += err * 0.1;
      }
    }
    if (resync) this.resync(s, now, c);
    const offset = s.offset as number;
    if (this.sync !== s) return;
    for (const p of s.phrases) {
      const start = p.startSec + offset;
      if (start >= horizon) break;
      if (p.entered && p.cursor >= p.plan.notes.length && p.endSec < c) continue;
      if (!p.entered) {
        p.entered = true;
        this.graph.restore(start);
        this.applyPhraseMix(p.score, start, MIX_RAMP_SEC);
        if (p.plan.fade) this.graph.scheduleFade(start + p.plan.fade.fromSec, start + p.plan.fade.toSec);
        const index = p.score.index;
        this.at(start, () => this.emit({ type: 'phrase_started', index }));
      }
      this.schedulePhrase(p, start, horizon);
    }
    // notes added with scheduleAt()
    const loose: PhraseCursor = { score: EXTRA_SCORE, plan: EXTRA_PLAN, cursor: 0, kickCursor: 0, pedalCursor: 0, cutDone: false, carryOffSec: null };
    while (s.extras.length && s.extras[0].clockSec + offset < horizon) {
      const x = s.extras.shift() as SyncExtra;
      if (x.clockSec < c - 0.05) continue; // its moment has passed (seek, or a long stall)
      this.scheduleNote(loose, x.pn, x.clockSec + offset);
    }
    if (!s.endedEmitted && c > s.lastEnd + TAIL_SEC) {
      s.endedEmitted = true;
      this.emit({ type: 'ended' });
    }
  }

  /** (Re)anchor to the external clock at position `c`: after a seek, a pause, or too much drift. */
  private resync(s: SyncState, now: number, c: number): void {
    if (s.running) {
      this.sampler.killAll(now);
      this.synths.releaseAll(now);
    }
    this.timed = [];
    this.pedalCarry = [];
    this.graph.reset(now, false);
    s.offset = now - c;
    s.driftTicks = 0;
    s.running = true;
    if (c < s.lastEnd) s.endedEmitted = false;
    let current: SyncPhrase | null = null;
    for (const p of s.phrases) {
      const rel = c - p.startSec;
      p.cursor = firstAtOrAfter(p.plan.notes, (x) => x.onSec, rel);
      p.kickCursor = firstAtOrAfter(p.plan.kickSecs, (x) => x, rel);
      p.pedalCursor = firstAtOrAfter(p.plan.pedal, (x) => x.sec, rel);
      p.cutDone = p.plan.cutSec !== null && p.plan.cutSec <= rel;
      p.entered = p.startSec <= c;
      if (p.startSec <= c && c < p.endSec) current = p;
    }
    if (!current) return;
    // landing inside a phrase: its mix at once, the fade / cut where it would be, and the notes already sounding
    const start = current.startSec + s.offset;
    const rel = c - current.startSec;
    this.applyPhraseMix(current.score, now, 0.08, start);
    const fade = current.plan.fade;
    if (fade) {
      if (rel <= fade.fromSec) {
        this.graph.scheduleFade(start + fade.fromSec, start + fade.toSec);
      } else {
        const x = Math.min(1, (rel - fade.fromSec) / Math.max(1e-3, fade.toSec - fade.fromSec));
        const level = x < 0.55 ? 1 - (0.68 / 0.55) * x : 0.32 * (1 - (x - 0.55) / 0.45);
        this.graph.fadeFrom(level, now, start + fade.toSec);
      }
    }
    if (current.cutDone) this.graph.scheduleCut(now);
    else this.joinMidPhrase(current, start, rel, now);
    const index = current.score.index;
    this.at(now, () => this.emit({ type: 'phrase_started', index }));
  }

  /** After a seek: bring in the long notes that would already be sounding at this point. */
  private joinMidPhrase(p: SyncPhrase, start: number, rel: number, now: number): void {
    const t = now + 0.02;
    for (const pn of p.plan.notes) {
      if (pn.onSec >= rel) break;
      const n = pn.note;
      const offSec = pn.offSec ?? p.carryOffSec ?? pn.onSec + pn.durSec;
      const remaining = offSec - rel;
      if (remaining < 0.3) continue;
      const elapsed = rel - pn.onSec;
      if (isSynthId(n.inst)) {
        if (n.inst === 'pad' || n.inst === 'sub') this.synths.trigger(n.inst, n.layer, n.midi, pn.vel, t, remaining);
        continue;
      }
      const sustained = n.art === 'sustain' || n.art === 'tremolo' || n.art === 'roll';
      if (!sustained || !this.sampler.ready(n.inst)) continue;
      this.sampler.play({
        inst: n.inst, midi: n.midi, vel: pn.vel, art: n.art, layer: n.layer, time: t, offTime: start + offSec,
        detuneCents: pn.detuneCents, attackSec: 0.12, startOffsetSec: elapsed,
      });
    }
  }
}

/** Stand-in phrase context for notes that belong to no phrase (scheduleAt). */
const EXTRA_SCORE: PhraseScore = {
  index: -1, section: 0, role: 'statement', bars: 0, beatsPerBar: 4, beats: 0, bpm: 60, notes: [], pedal: [], mix: { ...DEFAULT_MIX }, holdChord: [],
  display: { key: '', notation: '', lineage: '', chords: [], layers: [], tension: 0 },
};
const EXTRA_PLAN: PhrasePlan = planPhrase(EXTRA_SCORE, { humanize: false });

function holdKey(n: Pick<HoldNote, 'inst' | 'midi'>): string {
  return `${n.inst}|${n.midi}`;
}

export { LAYER_ROLES };
