// Tone.js synths: sub, pad, pluck, kick808 and the water / wave noise texture.
// One instance per (synth, layer bus), built on first use. Events are queued here and handed
// to Tone just inside its look-ahead, so a stop / seek can drop what has not sounded yet.

import * as Tone from 'tone';
import type { LayerRole } from '../../../shared/types.ts';
import { dbToGain, midiToHz } from './selection.ts';

export type TonalSynth = 'sub' | 'pad' | 'pluck' | 'kick808' | 'keys' | 'lead' | 'supersaw' | 'synth_bass' | 'bell' | 'brass';
/** note = written notes; fallback = standing in for a missing sampled instrument; hold = hold chord. */
export type Variant = 'note' | 'fallback' | 'hold';

/** Tone runs PolySynth events at once only when they are within its look-ahead (0.1 s). */
const HANDOFF_SEC = 0.09;

// Set against the sampled instruments by bus-meter readings (not by ear): at -8 dB the sub read ~17 dB
// hotter than sampled basses at the same velocity, and the kick ~10 dB over the drum kit.
// The six production sounds below were levelled by reasoning from the pluck and pad figures, not yet by meter or ear.
const LEVEL_DB: Record<TonalSynth, number> = { sub: -18, pad: -13, pluck: -7, kick808: -9, keys: -9, lead: -14, supersaw: -19, synth_bass: -15, bell: -11, brass: -15 };
const NOISE_SWELL_DB = -13;

interface Instance {
  out: Tone.Gain;
  attack(hz: number, time: number, vel: number): void;
  release(hz: number, time: number): void;
  setEnvelope?(attack: number | null, release: number | null): void;
  releaseAll(time: number): void;
  dispose(): void;
}

interface Queued {
  time: number;
  seq: number;
  run: () => void;
}

interface Swell {
  gain: GainNode;
  end: number;
}

function polyInstance(synths: Tone.PolySynth[], post: Tone.ToneAudioNode[], levelDb: number): Instance {
  const out = new Tone.Gain(dbToGain(levelDb));
  if (post.length) {
    for (const s of synths) s.connect(post[0]);
    for (let i = 0; i < post.length - 1; i++) post[i].connect(post[i + 1]);
    post[post.length - 1].connect(out);
  } else {
    for (const s of synths) s.connect(out);
  }
  return {
    out,
    attack: (hz, time, vel) => {
      for (const s of synths) s.triggerAttack(hz, time, vel);
    },
    release: (hz, time) => {
      for (const s of synths) s.triggerRelease(hz, time);
    },
    setEnvelope: (attack, release) => {
      const envelope: { attack?: number; release?: number } = {};
      if (attack !== null) envelope.attack = attack;
      if (release !== null) envelope.release = release;
      for (const s of synths) s.set({ envelope });
    },
    releaseAll: (time) => {
      for (const s of synths) s.releaseAll(time);
    },
    dispose: () => {
      for (const s of synths) s.dispose();
      for (const p of post) p.dispose();
      out.dispose();
    },
  };
}

function makeSub(variant: Variant): Instance {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: variant === 'hold' ? 1.2 : 0.02, decay: 0.3, sustain: 0.88, release: variant === 'hold' ? 1.2 : 0.4 },
  });
  synth.maxPolyphony = 8;
  // gentle tanh: adds low odd harmonics so the sub still reads on small speakers
  const k = 2.4;
  const shaper = new Tone.WaveShaper((x: number) => Math.tanh(k * x) / Math.tanh(k), 2048);
  return polyInstance([synth], [shaper], LEVEL_DB.sub);
}

function makePad(variant: Variant): Instance {
  const attack = variant === 'hold' ? 1.5 : variant === 'fallback' ? 0.14 : 0.5;
  const release = variant === 'hold' ? 1.5 : variant === 'fallback' ? 0.7 : 1.9;
  const envelope = { attack, decay: 1.4, sustain: 0.82, release };
  const saw = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'fatsawtooth', count: 3, spread: 22 }, envelope });
  const tri = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'fattriangle', count: 2, spread: 12 }, envelope });
  saw.maxPolyphony = 16;
  tri.maxPolyphony = 16;
  saw.volume.value = -9;
  tri.volume.value = -3;
  const filter = new Tone.Filter({ type: 'lowpass', frequency: 1500, rolloff: -24, Q: 0.6 });
  const lfo = new Tone.LFO({ frequency: 0.09, min: 1050, max: 2100 }).start();
  lfo.connect(filter.frequency);
  const inst = polyInstance([saw, tri], [filter], LEVEL_DB.pad);
  const dispose = inst.dispose;
  inst.dispose = () => {
    lfo.dispose();
    dispose();
  };
  return inst;
}

function makePluck(): Instance {
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 2,
    modulationIndex: 7,
    oscillator: { type: 'sine' },
    modulation: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 0.3 },
    modulationEnvelope: { attack: 0.002, decay: 0.13, sustain: 0.04, release: 0.2 },
  });
  synth.maxPolyphony = 16;
  return polyInstance([synth], [], LEVEL_DB.pluck);
}

// ── Production sounds for beat-driven music ──

/** Electric piano: a soft FM tine with a bell-like attack that mellows as it rings. */
function makeKeys(): Instance {
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 1, modulationIndex: 2.6, oscillator: { type: 'sine' }, modulation: { type: 'sine' },
    envelope: { attack: 0.004, decay: 1.6, sustain: 0.28, release: 0.5 },
    modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0.12, release: 0.3 },
  });
  synth.maxPolyphony = 20;
  const tremolo = new Tone.Tremolo({ frequency: 4.2, depth: 0.22, spread: 120 }).start();
  return polyInstance([synth], [tremolo], LEVEL_DB.keys);
}

/** Synth lead: two detuned saws through a bright low-pass, with a little vibrato. */
function makeLead(): Instance {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 2, spread: 14 },
    envelope: { attack: 0.012, decay: 0.2, sustain: 0.75, release: 0.18 },
  });
  synth.maxPolyphony = 8;
  const vibrato = new Tone.Vibrato({ frequency: 5.2, depth: 0.06 });
  const filter = new Tone.Filter({ type: 'lowpass', frequency: 4200, rolloff: -12, Q: 1.2 });
  return polyInstance([synth], [vibrato, filter], LEVEL_DB.lead);
}

/** Supersaw: seven detuned saws per note, wide and bright: the chord wall of a dance-pop chorus. */
function makeSupersaw(): Instance {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 7, spread: 38 },
    envelope: { attack: 0.03, decay: 0.4, sustain: 0.8, release: 0.45 },
  });
  synth.maxPolyphony = 12;
  const filter = new Tone.Filter({ type: 'lowpass', frequency: 6500, rolloff: -12, Q: 0.5 });
  const chorus = new Tone.Chorus({ frequency: 0.8, delayTime: 3.5, depth: 0.5, spread: 180 }).start();
  return polyInstance([synth], [filter, chorus], LEVEL_DB.supersaw);
}

/** Synth bass: a saw with a filter that snaps shut after each attack: punch, then body. */
function makeSynthBass(): Instance {
  const synth = new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.004, decay: 0.25, sustain: 0.7, release: 0.12 },
    filter: { type: 'lowpass', rolloff: -24, Q: 2.2 },
    filterEnvelope: { attack: 0.002, decay: 0.16, sustain: 0.25, release: 0.15, baseFrequency: 110, octaves: 3.4 },
  });
  synth.maxPolyphony = 4;
  return polyInstance([synth], [], LEVEL_DB.synth_bass);
}

/** Bell: an inharmonic FM strike with a long glassy ring. */
function makeBell(): Instance {
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3.5, modulationIndex: 9, oscillator: { type: 'sine' }, modulation: { type: 'sine' },
    envelope: { attack: 0.001, decay: 1.8, sustain: 0, release: 1.2 },
    modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0.05, release: 0.6 },
  });
  synth.maxPolyphony = 16;
  return polyInstance([synth], [], LEVEL_DB.bell);
}

/** Synth brass: saws whose filter opens with each note, the "blat" of a horn stab. */
function makeBrass(): Instance {
  const synth = new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 16 },
    envelope: { attack: 0.03, decay: 0.2, sustain: 0.8, release: 0.16 },
    filter: { type: 'lowpass', rolloff: -24, Q: 1 },
    filterEnvelope: { attack: 0.05, decay: 0.3, sustain: 0.55, release: 0.2, baseFrequency: 320, octaves: 3 },
  });
  synth.maxPolyphony = 10;
  return polyInstance([synth], [], LEVEL_DB.brass);
}

const MAKERS: Record<Exclude<TonalSynth, 'sub' | 'pad' | 'pluck' | 'kick808'>, () => Instance> = {
  keys: makeKeys, lead: makeLead, supersaw: makeSupersaw, synth_bass: makeSynthBass, bell: makeBell, brass: makeBrass,
};

function makeKick(): Instance {
  const synth = new Tone.MembraneSynth({
    pitchDecay: 0.045,
    octaves: 5.5,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.55, sustain: 0, release: 0.35 },
  });
  const out = new Tone.Gain(dbToGain(LEVEL_DB.kick808));
  synth.connect(out);
  return {
    out,
    attack: (hz, time, vel) => synth.triggerAttack(hz, time, vel),
    release: (_hz, time) => synth.triggerRelease(time),
    releaseAll: (time) => synth.triggerRelease(time),
    dispose: () => {
      synth.dispose();
      out.dispose();
    },
  };
}

export class SynthBank {
  private readonly ctx: BaseAudioContext;
  private readonly busFor: (layer: LayerRole) => AudioNode;
  private readonly instances = new Map<string, Instance>();
  private queue: Queued[] = [];
  private seq = 0;
  private swells: Swell[] = [];
  private noiseHolds = new Map<string, Swell>();
  private readonly noiseCore: Tone.Gain;
  private readonly noiseParts: { dispose(): void }[] = [];

  constructor(ctx: BaseAudioContext, busFor: (layer: LayerRole) => AudioNode, noiseBed: AudioNode) {
    this.ctx = ctx;
    this.busFor = busFor;

    // Water / wave texture: two decorrelated pink-noise streams, each through a band-pass whose
    // centre drifts on a slow LFO, under a slow amplitude swell.
    this.noiseCore = new Tone.Gain(1);
    const sides: [pan: number, sweepHz: number, swellHz: number, phase: number][] = [
      [-0.6, 0.071, 0.113, 0],
      [0.6, 0.053, 0.087, 140],
    ];
    for (const [pan, sweepHz, swellHz, phase] of sides) {
      const noise = new Tone.Noise('pink').start();
      const filter = new Tone.Filter({ type: 'bandpass', frequency: 700, Q: 0.9 });
      const sweep = new Tone.LFO({ frequency: sweepHz, min: 300, max: 1500, phase }).start();
      sweep.connect(filter.frequency);
      const amp = new Tone.Gain(0.7);
      const swell = new Tone.LFO({ frequency: swellHz, min: 0.4, max: 1, phase: phase / 2 }).start();
      swell.connect(amp.gain);
      const panner = new Tone.Panner(pan);
      noise.chain(filter, amp, panner, this.noiseCore);
      this.noiseParts.push(noise, filter, sweep, amp, swell, panner);
    }
    Tone.connect(this.noiseCore, noiseBed);
  }

  private instance(inst: TonalSynth, layer: LayerRole, variant: Variant): Instance {
    const key = `${inst}|${layer}|${variant}`;
    let it = this.instances.get(key);
    if (!it) {
      it = inst === 'sub' ? makeSub(variant) : inst === 'pad' ? makePad(variant) : inst === 'pluck' ? makePluck() : inst === 'kick808' ? makeKick() : MAKERS[inst]();
      Tone.connect(it.out, this.busFor(layer));
      this.instances.set(key, it);
    }
    return it;
  }

  private at(time: number, run: () => void): void {
    if (time <= this.ctx.currentTime + HANDOFF_SEC) {
      run();
      return;
    }
    const q: Queued = { time, seq: this.seq++, run };
    // insertion sort from the back: events mostly arrive in order
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1].time > q.time || (this.queue[i - 1].time === q.time && this.queue[i - 1].seq > q.seq))) i--;
    this.queue.splice(i, 0, q);
  }

  /** A written note: attack at `time`, release after `durSec`. */
  trigger(inst: TonalSynth, layer: LayerRole, midi: number, vel: number, time: number, durSec: number, variant: Variant = 'note'): void {
    const v = Math.min(1, Math.max(0.02, vel));
    if (inst === 'kick808') {
      // 808s live around 40–65 Hz whatever octave was written
      let m = midi;
      while (m > 38) m -= 12;
      while (m < 27) m += 12;
      const hz = midiToHz(m);
      const it = this.instance('kick808', layer, 'note');
      // the envelope has no sustain, so the hit decays by itself: no release event that could clip the next kick
      this.at(time, () => it.attack(hz, Math.max(time, this.ctx.currentTime), v));
      return;
    }
    const hz = midiToHz(midi);
    // only the pad has a distinct quick-speaking variant for standing in for missing samples
    const it = this.instance(inst, layer, inst === 'pad' && variant === 'fallback' ? 'fallback' : 'note');
    const len = inst === 'pluck' ? Math.min(0.5, Math.max(0.06, durSec)) : Math.max(0.05, durSec);
    this.at(time, () => it.attack(hz, Math.max(time, this.ctx.currentTime), v));
    this.at(time + len, () => it.release(hz, Math.max(time + len, this.ctx.currentTime)));
  }

  /** Hold chord: an open-ended sub / pad note fading in over `attackSec`. */
  holdOn(inst: 'sub' | 'pad', layer: LayerRole, midi: number, vel: number, time: number, attackSec: number): void {
    const it = this.instance(inst, layer, 'hold');
    const hz = midiToHz(midi);
    const v = Math.min(1, Math.max(0.02, vel));
    this.at(time, () => {
      it.setEnvelope?.(Math.max(0.05, attackSec), null);
      it.attack(hz, Math.max(time, this.ctx.currentTime), v);
    });
  }

  holdOff(inst: 'sub' | 'pad', layer: LayerRole, midi: number, time: number, releaseSec: number): void {
    const it = this.instance(inst, layer, 'hold');
    const hz = midiToHz(midi);
    this.at(time, () => {
      it.setEnvelope?.(null, Math.max(0.05, releaseSec));
      it.release(hz, Math.max(time, this.ctx.currentTime));
    });
  }

  private tap(layer: LayerRole): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    Tone.connect(this.noiseCore, g);
    g.connect(this.busFor(layer));
    return g;
  }

  /** A noise note: a rise and fall shaped by its duration and velocity. */
  noiseSwell(layer: LayerRole, time: number, durSec: number, vel: number): void {
    const t = Math.max(time, this.ctx.currentTime);
    const dur = Math.max(0.3, durSec);
    const peak = dbToGain(NOISE_SWELL_DB) * Math.pow(Math.min(1, Math.max(0.02, vel)), 1.3);
    const g = this.tap(layer);
    g.gain.setValueAtTime(0, t);
    g.gain.setTargetAtTime(peak, t, dur * 0.16);
    g.gain.setTargetAtTime(0, t + dur * 0.5, dur * 0.17);
    this.swells.push({ gain: g, end: t + dur * 1.7 });
  }

  /** Noise as a hold note: a sustained level until released. */
  noiseHoldOn(key: string, layer: LayerRole, vel: number, time: number, attackSec: number): void {
    const t = Math.max(time, this.ctx.currentTime);
    let s = this.noiseHolds.get(key);
    if (!s) {
      s = { gain: this.tap(layer), end: Infinity };
      this.noiseHolds.set(key, s);
    }
    const level = dbToGain(NOISE_SWELL_DB) * Math.pow(Math.min(1, Math.max(0.02, vel)), 1.3);
    s.gain.gain.cancelScheduledValues(t);
    s.gain.gain.setTargetAtTime(level, t, Math.max(0.05, attackSec / 3));
  }

  noiseHoldOff(key: string, time: number, releaseSec: number): void {
    const s = this.noiseHolds.get(key);
    if (!s) return;
    const t = Math.max(time, this.ctx.currentTime);
    s.gain.gain.cancelScheduledValues(t);
    s.gain.gain.setTargetAtTime(0, t, Math.max(0.02, releaseSec / 3));
    s.end = t + releaseSec * 2.5;
    this.swells.push(s);
    this.noiseHolds.delete(key);
  }

  /** Release everything sounding at `time` and drop every event after it. */
  releaseAll(time: number): void {
    const t = Math.max(time, this.ctx.currentTime);
    // notes due before `t` still sound (and are released at `t`); everything later is dropped
    this.queue = this.queue.filter((q) => q.time < t);
    this.at(t, () => {
      const when = Math.max(t, this.ctx.currentTime);
      for (const it of this.instances.values()) {
        try {
          it.releaseAll(when);
        } catch (err) {
          console.warn('[audio] synth release failed', err);
        }
      }
    });
    for (const s of this.swells) {
      s.gain.gain.cancelScheduledValues(t);
      s.gain.gain.setTargetAtTime(0, t, 0.03);
      s.end = Math.min(s.end, t + 0.3);
    }
    for (const key of [...this.noiseHolds.keys()]) this.noiseHoldOff(key, t, 0.1);
  }

  /** Every scheduler tick: hand due events to Tone, drop finished swell taps. */
  service(now: number): void {
    const due = now + HANDOFF_SEC;
    let n = 0;
    while (n < this.queue.length && this.queue[n].time <= due) n++;
    if (n) {
      const batch = this.queue.splice(0, n);
      for (const q of batch) {
        try {
          q.run();
        } catch (err) {
          console.warn('[audio] synth event failed', err);
        }
      }
    }
    if (this.swells.length) {
      this.swells = this.swells.filter((s) => {
        if (s.end > now) return true;
        try {
          Tone.disconnect(this.noiseCore, s.gain);
          s.gain.disconnect();
        } catch {
          /* best effort */
        }
        return false;
      });
    }
  }

  dispose(): void {
    this.queue = [];
    for (const it of this.instances.values()) it.dispose();
    this.instances.clear();
    for (const p of this.noiseParts) p.dispose();
    this.noiseCore.dispose();
  }
}
