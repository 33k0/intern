// The mix graph: one metered bus per layer → low-pass → saturation → chorus → widener →
// dry + hall convolution + tempo delay → master → compressor → limiter → destination.
// Raw Web Audio nodes from Tone's context, with Tone's Chorus and StereoWidener in the chain.

import * as Tone from 'tone';
import type { LayerRole } from '../../../shared/types.ts';
import { DEFAULT_MIX, DUCK_GAIN, DUCK_RECOVERY_SEC, mixToParams } from './mixmap.ts';
import type { MixParams } from './mixmap.ts';
import { mulberry32 } from './prng.ts';

export const LAYER_ROLES: LayerRole[] = ['melody', 'counter', 'inner', 'bass', 'pedal', 'figuration', 'texture', 'pulse', 'accents'];

/** Buses the sidechain leaves alone. */
const NO_DUCK = new Set<LayerRole>(['pulse', 'accents']);

/** Headroom into the effect chain (many voices sum here) and make-up after it. */
const PRE_TRIM = 0.5;
const MASTER_TRIM = 1.6;
const REVERB_SEND_TRIM = 1.0;
/** The shaper curve covers ±SHAPER_RANGE of drive so a hot signal is not clipped at the table edge. */
const SHAPER_RANGE = 6;
const DELAY_FEEDBACK = 0.36;

interface Meter {
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  level: number;
  lastMs: number;
}

interface Bus {
  input: GainNode;
  duck: GainNode;
  meter: Meter;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** A plain decaying-noise impulse, used only if the recorded hall IR cannot be loaded. */
export function makeSyntheticIr(ctx: BaseAudioContext, seconds = 2.4): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(seconds * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(0x1f00 + ch);
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const white = rng() * 2 - 1;
      // highs die away sooner than lows
      const k = 0.25 + 0.7 * Math.exp(-t * 2.2);
      lp += k * (white - lp);
      data[i] = lp * Math.exp(-t * (6.9 / seconds)) * (t < 0.004 ? t / 0.004 : 1);
    }
  }
  return buf;
}

export class MixGraph {
  readonly ctx: BaseAudioContext;
  readonly buses: Record<LayerRole, Bus>;
  /** Noise bed enters here; its gain is the bed level from MixState.noise. */
  readonly noiseBed: GainNode;

  private readonly noiseDuck: GainNode;
  private readonly preSum: GainNode;
  private readonly lp1: BiquadFilterNode;
  private readonly lp2: BiquadFilterNode;
  private readonly satPre: GainNode;
  private readonly shaper: WaveShaperNode;
  private readonly satPost: GainNode;
  private readonly chorus: Tone.Chorus;
  private readonly widener: Tone.StereoWidener;
  private readonly cut: GainNode;
  private readonly dry: GainNode;
  private readonly revSend: GainNode;
  private readonly preDelay: DelayNode;
  private readonly convolver: ConvolverNode;
  private readonly revReturn: GainNode;
  private readonly delaySend: GainNode;
  private readonly delay: DelayNode;
  private readonly delayReturn: GainNode;
  private readonly master: GainNode;
  private readonly fade: GainNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly masterMeter: Meter;
  private fadeDirty = false;
  private cutDirty = false;
  private returnsMuted = false;
  private delayTime = 0.4;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    const p = mixToParams(DEFAULT_MIX, 'large_hall');

    this.preSum = ctx.createGain();
    this.preSum.gain.value = PRE_TRIM;

    const buses = {} as Record<LayerRole, Bus>;
    for (const role of LAYER_ROLES) {
      const input = ctx.createGain();
      const duck = ctx.createGain();
      input.connect(duck);
      duck.connect(this.preSum);
      buses[role] = { input, duck, meter: this.makeMeter(input) };
    }
    this.buses = buses;

    this.noiseBed = ctx.createGain();
    this.noiseBed.gain.value = p.noiseGain;
    this.noiseDuck = ctx.createGain();
    this.noiseBed.connect(this.noiseDuck);
    this.noiseDuck.connect(this.preSum);

    // 4th-order low-pass (two biquads; for low-pass the Q param is in dB)
    this.lp1 = ctx.createBiquadFilter();
    this.lp1.type = 'lowpass';
    this.lp1.Q.value = -5.33;
    this.lp1.frequency.value = p.lowpassHz;
    this.lp2 = ctx.createBiquadFilter();
    this.lp2.type = 'lowpass';
    this.lp2.Q.value = 2.32;
    this.lp2.frequency.value = p.lowpassHz;

    this.satPre = ctx.createGain();
    this.satPre.gain.value = p.satPre / SHAPER_RANGE;
    this.shaper = ctx.createWaveShaper();
    const n = 8193;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * SHAPER_RANGE);
    this.shaper.curve = curve;
    this.satPost = ctx.createGain();
    this.satPost.gain.value = p.satPost;

    this.chorus = new Tone.Chorus({ frequency: 0.6, delayTime: 4.5, depth: 0.45, spread: 180, wet: p.chorusWet }).start();
    this.widener = new Tone.StereoWidener(p.width);

    this.cut = ctx.createGain();
    this.dry = ctx.createGain();
    this.dry.gain.value = p.dry;

    this.revSend = ctx.createGain();
    this.revSend.gain.value = p.reverbWet * REVERB_SEND_TRIM;
    this.preDelay = ctx.createDelay(0.25);
    this.preDelay.delayTime.value = 0.024;
    this.convolver = ctx.createConvolver();
    this.revReturn = ctx.createGain();

    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = p.delayWet;
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = this.delayTime;
    const fbHp = ctx.createBiquadFilter();
    fbHp.type = 'highpass';
    fbHp.frequency.value = 220;
    const fbLp = ctx.createBiquadFilter();
    fbLp.type = 'lowpass';
    fbLp.frequency.value = 3400;
    const fb = ctx.createGain();
    fb.gain.value = DELAY_FEEDBACK;
    this.delayReturn = ctx.createGain();
    const delayToReverb = ctx.createGain();
    delayToReverb.gain.value = 0.25;

    this.master = ctx.createGain();
    this.master.gain.value = p.master * MASTER_TRIM;
    this.fade = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20;
    this.comp.knee.value = 14;
    this.comp.ratio.value = 2.2;
    this.comp.attack.value = 0.025;
    this.comp.release.value = 0.28;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.09;

    // wiring
    this.preSum.connect(this.lp1);
    this.lp1.connect(this.lp2);
    this.lp2.connect(this.satPre);
    this.satPre.connect(this.shaper);
    this.shaper.connect(this.satPost);
    Tone.connect(this.satPost, this.chorus);
    this.chorus.connect(this.widener);
    Tone.connect(this.widener, this.cut);

    this.cut.connect(this.dry);
    this.dry.connect(this.master);

    this.cut.connect(this.revSend);
    this.revSend.connect(this.preDelay);
    this.preDelay.connect(this.convolver);
    this.convolver.connect(this.revReturn);
    this.revReturn.connect(this.master);

    this.cut.connect(this.delaySend);
    this.delaySend.connect(this.delay);
    this.delay.connect(fbHp);
    fbHp.connect(fbLp);
    fbLp.connect(fb);
    fb.connect(this.delay);
    fbLp.connect(this.delayReturn);
    this.delayReturn.connect(this.master);
    this.delayReturn.connect(delayToReverb);
    delayToReverb.connect(this.preDelay);

    this.master.connect(this.fade);
    this.fade.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.masterMeter = this.makeMeter(this.limiter);
  }

  private makeMeter(src: AudioNode): Meter {
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    return { analyser, buf: new Float32Array(analyser.fftSize), level: 0, lastMs: nowMs() };
  }

  busInput(role: LayerRole): GainNode {
    return (this.buses[role] ?? this.buses.inner).input;
  }

  hasImpulse(): boolean {
    return this.convolver.buffer !== null;
  }

  setImpulse(buffer: AudioBuffer): void {
    this.convolver.buffer = buffer;
  }

  setPreDelay(sec: number, time: number): void {
    this.preDelay.delayTime.cancelScheduledValues(time);
    this.preDelay.delayTime.setTargetAtTime(Math.min(0.24, Math.max(0, sec)), time, 0.05);
  }

  setDelayTime(sec: number, time: number): void {
    if (Math.abs(sec - this.delayTime) < 1e-4) return;
    this.delayTime = sec;
    this.delay.delayTime.cancelScheduledValues(time);
    this.delay.delayTime.setTargetAtTime(sec, time, 0.12);
  }

  /** Glide every mix parameter to `p`, starting at `time`, arriving (95 %) after `rampSec`. */
  applyMix(p: MixParams, time: number, rampSec: number): void {
    const tc = Math.max(0.005, rampSec / 3);
    const to = (param: AudioParam, v: number): void => {
      param.cancelScheduledValues(time);
      param.setTargetAtTime(v, time, tc);
    };
    to(this.lp1.frequency, p.lowpassHz);
    to(this.lp2.frequency, p.lowpassHz);
    to(this.satPre.gain, p.satPre / SHAPER_RANGE);
    to(this.satPost.gain, p.satPost);
    to(this.dry.gain, p.dry);
    to(this.revSend.gain, p.reverbWet * REVERB_SEND_TRIM);
    to(this.delaySend.gain, p.delayWet);
    to(this.noiseBed.gain, p.noiseGain);
    to(this.master.gain, p.master * MASTER_TRIM);
    this.chorus.wet.cancelScheduledValues(time);
    this.chorus.wet.setTargetAtTime(p.chorusWet, time, tc);
    this.widener.width.cancelScheduledValues(time);
    this.widener.width.setTargetAtTime(p.width, time, tc);
  }

  /** Move the master level toward `master` from `time` (dynamics changing inside a phrase). */
  easeMaster(master: number, time: number, tc: number): void {
    this.master.gain.setTargetAtTime(master * MASTER_TRIM, time, Math.max(0.005, tc));
  }

  /** Sidechain: dip every bus except pulse / accents to about -9 dB at `time`, recovering in ~180 ms. */
  duck(time: number): void {
    const dip = (g: AudioParam): void => {
      g.setTargetAtTime(DUCK_GAIN, Math.max(0, time - 0.004), 0.005);
      g.setTargetAtTime(1, time + 0.03, DUCK_RECOVERY_SEC / 3);
    };
    for (const role of LAYER_ROLES) if (!NO_DUCK.has(role)) dip(this.buses[role].duck.gain);
    dip(this.noiseDuck.gain);
  }

  /** Master fade to silence between two times (gentle knee rather than a straight line). */
  scheduleFade(t0: number, t1: number): void {
    const g = this.fade.gain;
    const a = Math.max(t0, this.ctx.currentTime);
    const b = Math.max(t1, a + 0.05);
    g.cancelScheduledValues(a);
    g.setValueAtTime(1, a);
    g.linearRampToValueAtTime(0.32, a + (b - a) * 0.55);
    g.linearRampToValueAtTime(0, b);
    this.fadeDirty = true;
  }

  /** Pick a fade up part-way through (video seek into a fade): from `level` now to silence at `tEnd`. */
  fadeFrom(level: number, time: number, tEnd: number): void {
    const g = this.fade.gain;
    const t = Math.max(time, this.ctx.currentTime);
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.min(1, Math.max(0, level)), t);
    g.linearRampToValueAtTime(0, Math.max(tEnd, t + 0.05));
    this.fadeDirty = true;
  }

  /** Sudden stop: everything before the reverb / delay sends is muted within ~25 ms; the tails ring on. */
  scheduleCut(time: number): void {
    const g = this.cut.gain;
    const t = Math.max(time, this.ctx.currentTime);
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0, t + 0.025);
    this.cutDirty = true;
  }

  /** Undo a fade / cut at `time` (start of the next phrase). */
  restore(time: number): void {
    const t = Math.max(time, this.ctx.currentTime);
    if (this.fadeDirty) {
      this.fade.gain.cancelScheduledValues(t);
      this.fade.gain.setValueAtTime(1, t);
      this.fadeDirty = false;
    }
    if (this.cutDirty) {
      this.cut.gain.cancelScheduledValues(t);
      this.cut.gain.setValueAtTime(1, t);
      this.cutDirty = false;
    }
    if (this.returnsMuted) {
      for (const g of [this.revReturn.gain, this.delayReturn.gain]) {
        g.cancelScheduledValues(t);
        g.setTargetAtTime(1, t, 0.02);
      }
      this.returnsMuted = false;
    }
  }

  /** stop(): clear all automation; optionally choke the reverb / delay tails as well. */
  reset(time: number, muteTails: boolean): void {
    const t = Math.max(time, this.ctx.currentTime);
    const flat = (g: AudioParam): void => {
      g.cancelScheduledValues(t);
      g.setValueAtTime(1, t);
    };
    for (const role of LAYER_ROLES) flat(this.buses[role].duck.gain);
    flat(this.noiseDuck.gain);
    this.fadeDirty = true;
    this.cutDirty = true;
    this.restore(t);
    if (muteTails) {
      for (const g of [this.revReturn.gain, this.delayReturn.gain]) {
        g.cancelScheduledValues(t);
        g.setTargetAtTime(0, t, 0.03);
      }
      this.returnsMuted = true;
    }
  }

  private readMeter(m: Meter): number {
    m.analyser.getFloatTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
    const rms = Math.sqrt(sum / m.buf.length);
    // -54 dBFS → 0, -6 dBFS → 1
    const raw = rms > 1e-5 ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 54) / 48)) : 0;
    const t = nowMs();
    const dt = Math.max(0, (t - m.lastMs) / 1000);
    m.lastMs = t;
    m.level = Math.max(raw, m.level - dt * 1.6);
    return m.level;
  }

  levels(): Record<LayerRole, number> {
    const out = {} as Record<LayerRole, number>;
    for (const role of LAYER_ROLES) out[role] = this.readMeter(this.buses[role].meter);
    return out;
  }

  masterLevel(): number {
    return this.readMeter(this.masterMeter);
  }

  dispose(): void {
    try {
      this.limiter.disconnect();
      this.chorus.dispose();
      this.widener.dispose();
    } catch {
      /* best effort */
    }
  }
}
