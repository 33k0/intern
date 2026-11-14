// A silent stand-in for the audio engine: same surface, no sound. It walks the queued phrases
// on a wall clock so the playhead, layer meters and hold marker still animate when the real
// engine cannot start (samples missing, no audio device). The panel labels this state clearly.

import {
  beatToSec, phraseSeconds,
  type HoldUpdate, type InstrumentId, type LayerRole, type PhraseScore, type SoundWorld,
} from '../../shared/types';
import { zeroLevels, type EngineLike, type Playhead } from './engineBridge';
import type { EngineEvent } from './state';

export class FakeEngine implements EngineLike {
  private queue: PhraseScore[] = [];
  private cursor = -1;
  private phraseStartMs = 0;
  private playing = false;
  private holding = false;
  private holdLevel = 0;
  private timer: number | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();

  async unlock(): Promise<void> { /* nothing to unlock */ }

  async loadInstruments(ids: InstrumentId[], onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const total = ids.length;
    for (let i = 1; i <= total; i++) {
      await new Promise((r) => window.setTimeout(r, 90));
      onProgress?.(i, total);
    }
  }

  setSoundWorld(_world: SoundWorld): void { /* silent */ }

  enqueue(score: PhraseScore): void {
    this.queue.push(score);
    // No timer running means we are holding, or were started with an empty queue.
    if (this.playing && this.timer === null) this.advance();
  }

  start(): void {
    if (this.playing) return;
    this.playing = true;
    this.advance();
  }

  stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.cursor = -1;
    this.playing = false;
    this.holding = false;
  }

  applyHold(update: HoldUpdate): void {
    const peak = update.notes.reduce((m, n) => Math.max(m, n.vel), 0);
    this.holdLevel = Math.max(0.25, Math.min(1, peak));
  }

  on(cb: (e: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  bufferedAhead(): number {
    return Math.max(0, this.queue.length - 1 - this.cursor);
  }

  playhead(): Playhead {
    const cur = this.queue[this.cursor];
    if (!cur) return { index: -1, beat: 0, beats: 1, holding: false, playing: this.playing };
    if (this.holding) {
      return { index: cur.index, beat: cur.beats, beats: cur.beats, holding: true, playing: this.playing };
    }
    const elapsed = (performance.now() - this.phraseStartMs) / 1000;
    return { index: cur.index, beat: secToBeat(cur, elapsed), beats: cur.beats, holding: false, playing: this.playing };
  }

  levels(): Record<LayerRole, number> {
    const out = zeroLevels();
    const cur = this.queue[this.cursor];
    if (!cur || !this.playing) return out;
    if (this.holding) {
      const wobble = 0.85 + 0.15 * Math.sin(performance.now() / 700);
      for (const n of cur.holdChord) {
        const role: LayerRole = n.inst === 'basses' || n.inst === 'celli' || n.inst === 'sub' ? 'pedal' : 'inner';
        out[role] = Math.max(out[role], (this.holdLevel || n.vel) * wobble);
      }
      return out;
    }
    const beat = this.playhead().beat;
    for (const n of cur.notes) {
      if (beat < n.t) continue;
      const age = beat - n.t;
      const sustained = n.art === 'sustain' || n.art === 'tremolo' || n.art === 'roll';
      let level = 0;
      if (sustained && n.inst !== 'piano' && n.inst !== 'harp') {
        if (age <= n.dur) level = n.vel * Math.min(1, 0.35 + age * 1.6);
        else level = n.vel * Math.max(0, 1 - (age - n.dur) * 2.5);
      } else {
        // struck or plucked: sharp onset, decays over the note
        level = n.vel * Math.exp(-age * 1.6) * (age <= Math.max(n.dur, 0.5) + 0.6 ? 1 : 0);
      }
      if (level > out[n.layer]) out[n.layer] = level;
    }
    return out;
  }

  masterLevel(): number {
    const lv = this.levels();
    let m = 0;
    for (const v of Object.values(lv)) m = Math.max(m, v);
    return m;
  }

  private emit(e: EngineEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }

  private advance(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (!this.playing) return;
    const next = this.queue[this.cursor + 1];
    if (next) {
      this.cursor += 1;
      this.phraseStartMs = performance.now();
      if (this.holding) {
        this.holding = false;
        this.emit({ type: 'hold_ended' });
      }
      this.emit({ type: 'phrase_started', index: next.index });
      this.timer = window.setTimeout(() => this.advance(), phraseSeconds(next) * 1000);
      return;
    }
    const cur = this.queue[this.cursor];
    if (!cur) return; // started with nothing queued: wait for the first phrase
    if (cur.final) {
      this.playing = false;
      this.emit({ type: 'ended' });
    } else if (!this.holding) {
      this.holding = true;
      this.holdLevel = 0;
      this.emit({ type: 'hold_started', afterIndex: cur.index });
    }
  }
}

/** Inverse of beatToSec by bisection (the ritardando makes it non-linear). */
function secToBeat(score: PhraseScore, sec: number): number {
  if (!score.ritardando) return Math.min(score.beats, (sec * score.bpm) / 60);
  let lo = 0;
  let hi = score.beats;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (beatToSec(score, mid) < sec) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
