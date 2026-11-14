// Custom sampler on raw AudioBufferSourceNodes: velocity layers with dynamic crossfade, round
// robin, articulation fallbacks, shaped envelopes, re-grained sustains (long notes and holds),
// piano dampers and extras, voice cap with oldest-quietest stealing.

import type { Articulation, InstrumentId, LayerRole } from '../../../shared/types.ts';
import { cymbalSwellFiles, instrumentFiles, isAlias, isSynthId, isUnpitched, joinUrl, sampleSourceId } from './manifest.ts';
import type { ArticulationDef, InstrumentDef, ManifestSidecar, SampleManifest } from './manifest.ts';
import { bipolar, mulberry32 } from './prng.ts';
import type { Rng } from './prng.ts';
import {
  DEFAULT_SWELL_PEAKS, RoundRobin, centsToRate, dbToGain, decayRelease, grainOffset, grainTiming, keyCompDb, layerGains, layerMakeupDb,
  legatoOffsetSec, median, panFor, pickKeyInRange, resolveArticulation, stealIndex, sustainEnvelope, velocityCutoffHz, velocityGain, voiceMode,
} from './selection.ts';
import type { VoiceMode } from './selection.ts';

export const MAX_VOICES = 96;
const LOAD_CONCURRENCY = 8;
/** Detune of an alias section (violins2) against the section it borrows samples from, cents. */
const ALIAS_DETUNE_CENTS = 6;
const KILL_SEC = 0.03;
/**
 * The sample build (tools/samples/build.mjs) bakes each articulation's gain into the files and
 * records it in the manifest as `gainDb`. Applying it again at playback would double it, so it
 * is not applied. Flip this if the manifest ever carries a playback gain instead.
 */
const APPLY_MANIFEST_GAIN_DB = false;
/** After make-up no sample may sit more than this above the loudest layer's median level (dB). */
const OUTLIER_HEADROOM_DB = 5;
/** Struck / plucked strings and bars: a note struck again replaces its own earlier ring. */
const RESTRIKE = new Set<string>(['piano', 'harp', 'celesta', 'glockenspiel', 'vibraphone', 'timpani']);

/** Level of a decoded buffer in dB, measured over its first seconds (decimated): the fallback when the side-car has no entry. */
function measureDb(buf: AudioBuffer): { rmsDb: number; peakDb: number } {
  const n = Math.min(buf.length, Math.floor(buf.sampleRate * 4));
  let sum = 0;
  let peak = 0;
  let count = 0;
  for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i += 4) {
      const x = d[i];
      sum += x * x;
      if (x > peak) peak = x;
      else if (-x > peak) peak = -x;
      count++;
    }
  }
  const rms = count ? Math.sqrt(sum / count) : 0;
  return { rmsDb: rms > 1e-7 ? 20 * Math.log10(rms) : -140, peakDb: peak > 1e-7 ? 20 * Math.log10(peak) : -140 };
}

/** Seconds from the start of a buffer to its loudest 50 ms (for swell recordings without side-car data). */
function loudestAt(buf: AudioBuffer): number {
  const d = buf.getChannelData(0);
  const win = Math.max(1, Math.floor(buf.sampleRate * 0.05));
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i + win <= d.length; i += win) {
    let sum = 0;
    for (let k = i; k < i + win; k += 8) sum += d[k] * d[k];
    if (sum > best) {
      best = sum;
      bestAt = i;
    }
  }
  return (bestAt + win / 2) / buf.sampleRate;
}

interface Take {
  buffer: AudioBuffer;
  /** Level make-up for this sample in this layer (layer make-up × per-key trim), linear. */
  gain: number;
}

interface LoadedLayer {
  velMax: number;
  keys: number[];
  takes: Map<number, Take[]>;
}

interface LoadedArt {
  name: string;
  def: ArticulationDef;
  layers: LoadedLayer[];
}

interface LoadedInstrument {
  def: InstrumentDef;
  arts: Map<string, LoadedArt>;
}

interface Chosen {
  buffer: AudioBuffer;
  rate: number;
  gain: number;
}

interface Grain {
  sources: AudioBufferSourceNode[];
  gain: GainNode;
  nodes: AudioNode[];
  start: number;
  /** When the recorded audio of this grain runs out. */
  naturalEnd: number;
  /** When to begin crossfading into the next grain. */
  handoverAt: number;
  xfade: number;
  /** Set once the grain has been faded out and told to stop. */
  retiredAt: number | null;
}

interface Regrain {
  art: LoadedArt;
  layerPicks: { layer: number; gain: number }[];
  rrBase: string;
  alias: boolean;
  unpitched: boolean;
}

export interface Voice {
  readonly id: number;
  readonly inst: InstrumentId;
  /** Instrument whose samples are playing (violins for violins2). */
  readonly source: string;
  readonly midi: number;
  readonly layer: LayerRole;
  readonly mode: VoiceMode;
  readonly start: number;
  /** Target level (linear). */
  peak: number;
  /** Level per unit of velocityGain, for later level changes. */
  readonly unitGain: number;
  /** Release start time, or null while the note is open-ended. */
  off: number | null;
  /** Release time in use. */
  relSec: number;
  /** When the voice is completely over (Infinity while an open-ended sustain). */
  end: number;
  readonly held: boolean;
  /** Stolen or killed: no longer counted. */
  dead: boolean;
  /** @internal */ env: GainNode;
  /** @internal */ grainDest: AudioNode;
  /** @internal */ tail: AudioNode;
  /** @internal */ extra: AudioNode[];
  /** @internal */ lfo: OscillatorNode | null;
  /** @internal */ grains: Grain[];
  /** @internal */ regrain: Regrain | null;
  /** @internal */ detune: number;
}

export interface PlayRequest {
  inst: InstrumentId;
  midi: number;
  vel: number;
  art: Articulation;
  layer: LayerRole;
  /** Audio-clock start. */
  time: number;
  /** Audio-clock release; null = open-ended (hold, pedal carry). Ignored by one-shots. */
  offTime: number | null;
  detuneCents?: number;
  legato?: boolean;
  /** Overrides the computed attack (sustain voices). */
  attackSec?: number;
  gainScale?: number;
  /** Hold-chord voice: protected from stealing, plain slow attack. */
  held?: boolean;
  /** Start this far into the sample (joining a note mid-flight after a seek). */
  startOffsetSec?: number;
}

function curve(fn: (x: number) => number, n = 33): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn(i / (n - 1));
  return c;
}
const FADE_IN = curve((x) => Math.sin((x * Math.PI) / 2));
const FADE_OUT = curve((x) => Math.cos((x * Math.PI) / 2));

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const item = items[next++];
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

export class Sampler {
  private readonly ctx: BaseAudioContext;
  private readonly manifest: SampleManifest;
  private readonly busFor: (layer: LayerRole) => AudioNode;
  private readonly rng: Rng;
  private readonly rr = new RoundRobin();
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly loaded = new Map<string, LoadedInstrument>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly channels = new Map<string, AudioNode>();
  private readonly voices = new Map<number, Voice>();
  private nextId = 1;
  private readonly sidecar: ManifestSidecar | null;
  private readonly warned = new Set<string>();
  private extras: {
    pedalDown: AudioBuffer[];
    pedalUp: AudioBuffer[];
    release: (AudioBuffer | null)[];
  } = { pedalDown: [], pedalUp: [], release: [] };
  /** Cymbal crescendo recordings, ascending by time-to-peak. */
  private swells: { buffer: AudioBuffer; peakSec: number }[] = [];

  constructor(
    ctx: BaseAudioContext,
    manifest: SampleManifest,
    busFor: (layer: LayerRole) => AudioNode,
    seed = 0x5eed,
    sidecar: ManifestSidecar | null = null,
  ) {
    this.ctx = ctx;
    this.manifest = manifest;
    this.busFor = busFor;
    this.rng = mulberry32(seed);
    this.sidecar = sidecar;
  }

  // ───────────────────────────── Loading ─────────────────────────────

  /** The manifest has samples for this instrument (after alias resolution). */
  has(inst: InstrumentId): boolean {
    return !isSynthId(inst) && this.manifest.instruments[sampleSourceId(inst)] !== undefined;
  }

  /** Samples are decoded and playable. */
  ready(inst: InstrumentId): boolean {
    return this.loaded.has(sampleSourceId(inst));
  }

  private fetchBuffer(file: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(file);
    if (!p) {
      p = (async () => {
        try {
          const res = await fetch(joinUrl(this.manifest.baseUrl, file));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.arrayBuffer();
          return await this.ctx.decodeAudioData(data);
        } catch (err) {
          console.warn(`[audio] sample failed to load: ${file}`, err);
          return null;
        }
      })();
      this.buffers.set(file, p);
    }
    return p;
  }

  /**
   * Fetch + decode everything the given instruments need. Synth ids and instruments the
   * manifest does not have are skipped. Progress counts files.
   */
  async load(ids: readonly InstrumentId[], onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const sources = [...new Set(ids.filter((id) => this.has(id)).map((id) => sampleSourceId(id)))];
    const files = new Set<string>();
    for (const src of sources) for (const f of instrumentFiles(this.manifest, src)) files.add(f);
    const total = files.size;
    let done = 0;
    onProgress?.(0, total);
    await pool([...files], LOAD_CONCURRENCY, async (f) => {
      await this.fetchBuffer(f);
      done++;
      onProgress?.(done, total);
    });
    await Promise.all(sources.map((src) => this.assemble(src)));
  }

  /** Start loading in the background (an instrument turned up that was not in the palette). */
  ensureLoading(inst: InstrumentId): void {
    const src = sampleSourceId(inst);
    if (!this.has(inst) || this.loaded.has(src) || this.loading.has(src)) return;
    void this.load([src]).catch(() => undefined);
  }

  private assemble(src: InstrumentId): Promise<void> {
    if (this.loaded.has(src)) return Promise.resolve();
    let p = this.loading.get(src);
    if (!p) {
      p = this.assembleNow(src).finally(() => this.loading.delete(src));
      this.loading.set(src, p);
    }
    return p;
  }

  /**
   * Recorded level of a file, from the build's side-car when it has it, otherwise measured from
   * the audio. One-shots are judged by their peak. Sustains by the mean of peak and RMS: soft
   * string samples have a far larger crest factor than loud ones, so RMS alone over-corrects
   * them (checked on the bus meters: +8 dB too much on violins) and peak alone under-corrects.
   */
  private fileLevelDb(file: string, buf: AudioBuffer, percussive: boolean): number {
    const side = this.sidecar?.files?.[file];
    const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    let peakDb = side?.peakDb;
    let rmsDb = side?.rmsDb;
    if (!ok(peakDb) || !ok(rmsDb)) {
      const m = measureDb(buf);
      peakDb = m.peakDb;
      rmsDb = m.rmsDb;
    }
    return percussive ? peakDb : (peakDb + rmsDb) / 2;
  }

  private async assembleNow(src: InstrumentId): Promise<void> {
    const def = this.manifest.instruments[src];
    if (!def) return;
    // per-key evening-out only where keys are pitches of one instrument recorded at uneven levels;
    // the piano is a consistent library, and a drum kit's keys are different drums
    const evenKeys = src !== 'piano' && !isUnpitched(src);
    const arts = new Map<string, LoadedArt>();
    for (const [name, art] of Object.entries(def.articulations)) {
      const percussive = !!art.oneShot || src === 'piano';
      const raw: { velMax: number; entries: { key: number; buffer: AudioBuffer; levelDb: number }[] }[] = [];
      for (const layer of art.layers) {
        const entries: { key: number; buffer: AudioBuffer; levelDb: number }[] = [];
        for (const [key, files] of Object.entries(layer.samples)) {
          for (const f of files) {
            const b = await this.fetchBuffer(f);
            if (b) entries.push({ key: Number(key), buffer: b, levelDb: this.fileLevelDb(f, b, percussive) });
          }
        }
        if (entries.length) raw.push({ velMax: layer.velMax, entries });
      }
      if (!raw.length) continue;
      const medians = raw.map((l) => median(l.entries.map((e) => e.levelDb)));
      const makeup = layerMakeupDb(medians);
      const ref = medians[medians.length - 1];
      const layers: LoadedLayer[] = raw.map((l, i) => {
        const takes = new Map<number, Take[]>();
        for (const e of l.entries) {
          let gainDb = makeup[i] + (evenKeys ? keyCompDb(e.levelDb, medians[i]) : 0);
          // a loud recording filed in a soft layer (the library reuses some) must not ride the layer's make-up
          if (evenKeys && Number.isFinite(ref) && Number.isFinite(e.levelDb)) gainDb = Math.min(gainDb, ref + OUTLIER_HEADROOM_DB - e.levelDb);
          const gain = dbToGain(gainDb);
          const list = takes.get(e.key);
          if (list) list.push({ buffer: e.buffer, gain });
          else takes.set(e.key, [{ buffer: e.buffer, gain }]);
        }
        return { velMax: l.velMax, takes, keys: [...takes.keys()].sort((a, b) => a - b) };
      });
      arts.set(name, { name, def: art, layers });
    }
    if (src === 'piano' && this.manifest.extras) {
      const x = this.manifest.extras;
      const list = async (files?: string[]): Promise<(AudioBuffer | null)[]> => Promise.all((files ?? []).map((f) => this.fetchBuffer(f)));
      const some = (bufs: (AudioBuffer | null)[]): AudioBuffer[] => bufs.filter((b): b is AudioBuffer => b !== null);
      this.extras = {
        pedalDown: some(await list(x.pianoPedalDown)),
        pedalUp: some(await list(x.pianoPedalUp)),
        release: await list(x.pianoRelease),
      };
    }
    if (src === 'cymbal') {
      const swells: { buffer: AudioBuffer; peakSec: number }[] = [];
      for (const f of cymbalSwellFiles(this.manifest)) {
        const b = await this.fetchBuffer(f);
        if (!b) continue;
        const side = this.sidecar?.files?.[f]?.loudestAtSec;
        swells.push({ buffer: b, peakSec: typeof side === 'number' && side > 0 ? side : loudestAt(b) });
      }
      this.swells = swells.sort((a, b) => a.peakSec - b.peakSec);
    }
    if (arts.size === 0) {
      console.warn(`[audio] no usable samples for "${src}"`);
      return;
    }
    this.loaded.set(src, { def, arts });
  }

  // ───────────────────────────── Voices ─────────────────────────────

  private channel(inst: InstrumentId, layer: LayerRole): AudioNode {
    const key = inst + '|' + layer;
    let node = this.channels.get(key);
    if (!node) {
      const bus = this.busFor(layer);
      const pan = panFor(inst);
      if (pan === 0) {
        node = bus; // centre: stereo samples pass untouched
      } else {
        const p = this.ctx.createStereoPanner();
        p.pan.value = pan;
        p.connect(bus);
        node = p;
      }
      this.channels.set(key, node);
    }
    return node;
  }

  private pickBuffer(art: LoadedArt, layerIdx: number, midi: number, rrBase: string, alias: boolean, unpitched: boolean): Chosen | null {
    const layer = art.layers[layerIdx];
    if (!layer) return null;
    const counter = this.rr.count(`${rrBase}|${layerIdx}|k${midi}`);
    let pk = pickKeyInRange(layer.keys, midi, counter, { unpitched });
    if (!pk) return null;
    if (pk.octaves !== 0 && !this.warned.has(rrBase)) {
      this.warned.add(rrBase);
      console.warn(`[audio] ${rrBase}: note ${midi} is more than 7 semitones outside the sampled range; playing it ${Math.abs(pk.octaves)} octave(s) ${pk.octaves < 0 ? 'lower' : 'higher'}`);
    }
    let takes = layer.takes.get(pk.key) as Take[];
    if (alias && takes.length < 2) {
      // one take only: the borrowing section plays the neighbouring sample so a unison is never one buffer twice
      const alt = pickKeyInRange(layer.keys, midi, counter, { unpitched, preferAlternate: true });
      if (alt && layer.takes.has(alt.key)) {
        pk = alt;
        takes = layer.takes.get(alt.key) as Take[];
      }
    }
    const take = takes[this.rr.next(`${rrBase}|${layerIdx}|${pk.key}`, takes.length)];
    return { buffer: take.buffer, rate: pk.rate, gain: take.gain };
  }

  private level(v: Voice, now: number): number {
    if (v.off !== null && now > v.off) return v.peak * Math.exp(-(now - v.off) / (v.relSec / 3 + 1e-3));
    if (v.mode === 'decay' || v.mode === 'oneshot') return v.peak * Math.exp(-Math.max(0, now - v.start) / 2.5);
    return v.peak;
  }

  liveCount(): number {
    let n = 0;
    for (const v of this.voices.values()) if (!v.dead) n++;
    return n;
  }

  private makeRoom(): void {
    const now = this.ctx.currentTime;
    let live: Voice[] = [];
    for (const v of this.voices.values()) if (!v.dead) live.push(v);
    while (live.length >= MAX_VOICES) {
      const idx = stealIndex(live.map((v) => ({ start: v.start, level: this.level(v, now), held: v.held })), now);
      if (idx < 0) break;
      this.kill(live[idx], now);
      live = live.filter((_, i) => i !== idx);
    }
  }

  private addGrain(v: Voice, chosen: readonly Chosen[], time: number, offsetSec: number, fadeIn: number | null): Grain {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    const nodes: AudioNode[] = [gain];
    gain.connect(v.grainDest);
    let audible = Infinity;
    const sources: AudioBufferSourceNode[] = [];
    for (const c of chosen) {
      const src = ctx.createBufferSource();
      src.buffer = c.buffer;
      const rate = c.rate * v.detune;
      src.playbackRate.value = rate;
      if (chosen.length > 1 || c.gain !== 1) {
        const lg = ctx.createGain();
        lg.gain.value = c.gain;
        src.connect(lg);
        lg.connect(gain);
        nodes.push(lg);
      } else {
        src.connect(gain);
      }
      const offset = Math.max(0, Math.min(offsetSec, c.buffer.duration * 0.6));
      src.start(time, offset);
      if (Number.isFinite(v.end)) src.stop(Math.max(v.end, time + 0.01));
      audible = Math.min(audible, (c.buffer.duration - offset) / rate);
      sources.push(src);
      nodes.push(src);
    }
    const timing = grainTiming(audible, this.rng());
    let xfadeIn = 0;
    if (fadeIn !== null) {
      xfadeIn = Math.max(0.02, Math.min(fadeIn, audible * 0.3));
      gain.gain.value = 0;
      try {
        gain.gain.setValueCurveAtTime(FADE_IN, time, xfadeIn);
      } catch {
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(1, time + xfadeIn);
      }
    }
    const grain: Grain = {
      sources, gain, nodes, start: time, naturalEnd: time + audible,
      handoverAt: time + Math.max(timing.hop, xfadeIn + 0.02), xfade: timing.xfade, retiredAt: null,
    };
    v.grains.push(grain);
    return grain;
  }

  /** Start a note. Returns null if the instrument has nothing playable (caller falls back to a synth). */
  play(req: PlayRequest): Voice | null {
    const src = sampleSourceId(req.inst);
    const li = this.loaded.get(src);
    if (!li) return null;
    const resolved = resolveArticulation(li.def, req.art, (name) => li.arts.has(name));
    if (!resolved) return null;
    const art = li.arts.get(resolved.name) as LoadedArt;
    const mode = voiceMode(src, resolved, !!art.def.oneShot);
    const alias = isAlias(req.inst);
    const unpitched = isUnpitched(src);
    const vel = Math.min(1, Math.max(0.01, req.vel));
    const rrBase = `${src}|${art.name}`;

    const layerPicks = layerGains(art.layers.map((l) => l.velMax), vel, mode === 'sustain');
    const chosen: Chosen[] = [];
    for (const p of layerPicks) {
      const c = this.pickBuffer(art, p.layer, req.midi, rrBase, alias, unpitched);
      if (c) chosen.push({ ...c, gain: c.gain * p.gain });
    }
    if (!chosen.length) return null;

    const ctx = this.ctx;
    const t0 = Math.max(req.time, ctx.currentTime);
    this.makeRoom();

    // a string (or bar, or drum head) struck again replaces its own earlier ring
    if (RESTRIKE.has(src) && mode !== 'sustain') {
      for (const o of this.voices.values()) {
        if (!o.dead && o.source === src && o.midi === req.midi && o.mode !== 'sustain' && o.start < t0 - 0.02) this.release(o, t0, 0.14, true);
      }
    }
    // closed / pedal hi-hat chokes the open hat
    if (src === 'drumkit' && (req.midi === 42 || req.midi === 44)) {
      for (const o of this.voices.values()) if (!o.dead && o.source === 'drumkit' && o.midi === 46 && o.start < t0) this.release(o, t0, 0.07, true);
    }

    const unitGain = (APPLY_MANIFEST_GAIN_DB ? dbToGain(art.def.gainDb ?? 0) : 1) * (req.gainScale ?? 1);
    const peak = velocityGain(vel) * unitGain;

    const env = ctx.createGain();
    env.gain.value = 0;
    const extra: AudioNode[] = [];
    let grainDest: AudioNode = env;
    if (mode === 'sustain') {
      const fc = velocityCutoffHz(vel);
      if (fc < 16000) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = fc;
        f.Q.value = -3;
        f.connect(env);
        grainDest = f;
        extra.push(f);
      }
    }
    let tail: AudioNode = env;
    let lfo: OscillatorNode | null = null;
    if (resolved.mode === 'tremoloLfo') {
      const trem = ctx.createGain();
      trem.gain.value = 0.62;
      lfo = ctx.createOscillator();
      lfo.frequency.value = 12 + bipolar(this.rng, 0.8);
      const depth = ctx.createGain();
      depth.gain.value = 0.38;
      lfo.connect(depth);
      depth.connect(trem.gain);
      env.connect(trem);
      lfo.start(t0);
      tail = trem;
      extra.push(trem, depth);
    }
    tail.connect(this.channel(req.inst, req.layer));

    const v: Voice = {
      id: this.nextId++, inst: req.inst, source: src, midi: req.midi, layer: req.layer, mode, start: t0,
      peak, unitGain, off: null, relSec: 0.3, end: Infinity, held: !!req.held, dead: false,
      env, grainDest, tail, extra, lfo, grains: [],
      regrain: mode === 'sustain' ? { art, layerPicks, rrBase, alias, unpitched } : null,
      detune: unpitched ? 1 : centsToRate((req.detuneCents ?? 0) + (alias ? ALIAS_DETUNE_CENTS : 0)),
    };
    this.voices.set(v.id, v);

    let offset = req.startOffsetSec ?? 0;
    if (mode === 'sustain' && req.legato && !offset && chosen[0].buffer.duration > 1) offset = legatoOffsetSec(src); // slur: join past the bow change
    const grain = this.addGrain(v, chosen, t0, offset, null);
    const g = env.gain;

    if (mode === 'sustain') {
      const e = sustainEnvelope(req.inst, vel, req.midi, req.legato);
      const attack = Math.max(0.01, req.attackSec ?? e.attack);
      v.relSec = e.release;
      g.setValueAtTime(0, t0);
      const len = req.offTime === null ? Infinity : req.offTime - t0;
      if (src === 'timpani' && art.name === 'roll' && Number.isFinite(len) && !req.held && req.attackSec === undefined) {
        // the recorded roll is level, so the crescendo to the note end is drawn here
        g.setTargetAtTime(peak * 0.3, t0, 0.02);
        g.setTargetAtTime(peak * 1.3, t0 + 0.06, Math.max(0.1, len));
      } else if (!req.held && req.attackSec === undefined && len > 1.2) {
        // a long note is not flat: it arrives a little under, blooms, and tapers before the release
        g.setTargetAtTime(peak * 0.86, t0, attack / 3);
        g.setTargetAtTime(peak, t0 + attack, Math.min(1.2, len * 0.25));
        if (Number.isFinite(len) && len > 2.5) g.setTargetAtTime(peak * 0.84, t0 + len * 0.68, len * 0.2);
      } else {
        g.setTargetAtTime(peak, t0, attack / 3);
      }
      if (req.offTime !== null) this.scheduleRelease(v, Math.max(req.offTime, t0 + 0.04), e.release);
    } else if (mode === 'gated') {
      const gate = Math.min(0.22, Math.max(0.08, req.offTime === null ? 0.15 : req.offTime - t0));
      g.setValueAtTime(0, t0);
      g.setTargetAtTime(peak * 1.1, t0, 0.004);
      this.scheduleRelease(v, t0 + gate, 0.1);
    } else {
      // decay / oneshot: the sample carries its own attack
      g.setValueAtTime(peak, t0);
      v.end = grain.naturalEnd;
      if (mode === 'decay') {
        const dr = decayRelease(src, req.midi);
        v.relSec = dr.release;
        if (req.offTime !== null && dr.damped) {
          const off = Math.max(req.offTime, t0 + 0.03);
          if (off < grain.naturalEnd) this.scheduleRelease(v, off, dr.release);
        }
      }
    }
    return v;
  }

  private stopSources(v: Voice): void {
    if (!Number.isFinite(v.end)) return;
    for (const gr of v.grains) {
      if (gr.retiredAt !== null && gr.retiredAt <= v.end) continue;
      for (const s of gr.sources) {
        try {
          s.stop(Math.max(v.end, gr.start + 0.005));
        } catch {
          /* already ended */
        }
      }
    }
    if (v.lfo) {
      try {
        v.lfo.stop(v.end + 0.05);
      } catch {
        /* already stopped */
      }
    }
  }

  private scheduleRelease(v: Voice, time: number, relSec: number): void {
    const rel = Math.max(0.01, relSec);
    v.env.gain.setTargetAtTime(0, time, rel / 3);
    v.off = time;
    v.relSec = rel;
    const end = time + rel * 2.3;
    v.end = v.mode === 'sustain' || v.mode === 'gated' ? end : Math.min(v.end, end);
    this.stopSources(v);
  }

  /**
   * Release a voice at `time` over `relSec`. A voice already releasing earlier is left alone
   * unless `force` (used to cut a release short). Safe on voices that have not started yet.
   */
  release(v: Voice, time: number, relSec: number, force = false): void {
    if (v.dead && !force) return;
    if (v.off !== null && v.off <= time && !force) return;
    const t = Math.max(time, this.ctx.currentTime);
    if (v.end <= t) return;
    // decay / oneshot voices may be shortened but never lengthened: if the sample (or an earlier
    // release) is over before this fade would be, leave it alone
    if (v.mode !== 'sustain' && v.mode !== 'gated' && t + Math.max(0.01, relSec) * 2.3 >= v.end) return;
    v.env.gain.cancelScheduledValues(t);
    this.scheduleRelease(v, t, relSec);
  }

  /** Fast fade (30 ms) and forget: used for stealing, stop() and seeks. */
  kill(v: Voice, time: number): void {
    this.release(v, time, KILL_SEC, true);
    v.dead = true;
  }

  /** Move a sounding voice to a new velocity over `overSec` (hold updates). */
  setLevel(v: Voice, vel: number, time: number, overSec: number): void {
    if (v.off !== null) return;
    const t = Math.max(time, this.ctx.currentTime);
    v.peak = velocityGain(vel) * v.unitGain;
    if (v.mode !== 'sustain') return;
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setTargetAtTime(v.peak, t, Math.max(0.05, overSec / 3));
  }

  /**
   * Stretch the release of sustain voices whose note-off falls in [from, to], so the end of a
   * phrase overlaps the hold that follows it instead of leaving a dip.
   */
  extendReleases(from: number, to: number, relSec: number): void {
    for (const v of this.voices.values()) {
      if (v.dead || v.mode !== 'sustain' || v.off === null || v.off < from || v.off > to) continue;
      const off = Math.max(v.off, this.ctx.currentTime);
      v.env.gain.cancelScheduledValues(off);
      this.scheduleRelease(v, off, relSec);
    }
  }

  releaseAll(time: number, relSec: number): void {
    for (const v of this.voices.values()) if (!v.dead) this.release(v, time, relSec, true);
  }

  killAll(time: number): void {
    for (const v of this.voices.values()) if (!v.dead) this.kill(v, time);
  }

  private dispose(v: Voice): void {
    try {
      v.tail.disconnect();
      v.env.disconnect();
      for (const n of v.extra) n.disconnect();
      if (v.lfo) v.lfo.disconnect();
      for (const gr of v.grains) for (const n of gr.nodes) n.disconnect();
    } catch {
      /* best effort */
    }
    this.voices.delete(v.id);
  }

  /** Called every scheduler tick: hand sustains over to fresh grains, drop finished voices. */
  service(now: number, horizon: number): void {
    for (const v of this.voices.values()) {
      if (v.end < now - 0.1) {
        this.dispose(v);
        continue;
      }
      if (!v.regrain || v.dead) continue;
      const cur = v.grains[v.grains.length - 1];
      if (!cur || cur.handoverAt >= horizon) continue;
      // only if the note is still held once the hand-over would be complete (otherwise it ends inside this grain)
      if (v.off !== null && v.off <= cur.handoverAt + cur.xfade * 0.5) continue;
      const rg = v.regrain;
      const chosen: Chosen[] = [];
      for (const p of rg.layerPicks) {
        const c = this.pickBuffer(rg.art, p.layer, v.midi, rg.rrBase, rg.alias, rg.unpitched);
        if (c) chosen.push({ ...c, gain: c.gain * p.gain });
      }
      if (!chosen.length) {
        v.regrain = null;
        continue;
      }
      const t = Math.max(cur.handoverAt, now + 0.005);
      const next = this.addGrain(v, chosen, t, grainOffset(chosen[0].buffer.duration, this.rng()), cur.xfade);
      const xf = Math.max(0.02, Math.min(cur.xfade, next.handoverAt - next.start - 0.02, Math.max(0.02, cur.naturalEnd - t)));
      try {
        cur.gain.gain.setValueCurveAtTime(FADE_OUT, t, xf);
      } catch {
        cur.gain.gain.setValueAtTime(1, t);
        cur.gain.gain.linearRampToValueAtTime(0, t + xf);
      }
      cur.retiredAt = t + xf + 0.05;
      for (const s of cur.sources) {
        try {
          s.stop(cur.retiredAt);
        } catch {
          /* already ended */
        }
      }
      // forget grains that are long gone
      while (v.grains.length > 2) {
        const old = v.grains[0];
        if (old.retiredAt === null || old.retiredAt > now - 0.1) break;
        for (const n of old.nodes) n.disconnect();
        v.grains.shift();
      }
    }
  }

  // ───────────────────────────── One-shot extras ─────────────────────────────

  private oneShot(buffer: AudioBuffer, rate: number, gain: number, time: number, layer: LayerRole, inst: InstrumentId = 'piano', offsetSec = 0): Voice {
    const ctx = this.ctx;
    const t0 = Math.max(time, ctx.currentTime);
    const env = ctx.createGain();
    env.gain.value = 0;
    if (offsetSec > 0) {
      // entering part-way through the recording: a short fade instead of a click
      env.gain.setValueAtTime(0, t0);
      env.gain.setTargetAtTime(gain, t0, 0.01);
    } else {
      env.gain.setValueAtTime(gain, t0);
    }
    env.connect(this.channel(inst, layer));
    const v: Voice = {
      id: this.nextId++, inst, source: `${inst}:extra`, midi: -1, layer, mode: 'oneshot', start: t0,
      peak: gain, unitGain: gain, off: null, relSec: 0.1, end: Infinity, held: false, dead: false,
      env, grainDest: env, tail: env, extra: [], lfo: null, grains: [], regrain: null, detune: 1,
    };
    this.voices.set(v.id, v);
    const grain = this.addGrain(v, [{ buffer, rate, gain: 1 }], t0, offsetSec, null);
    v.end = grain.naturalEnd;
    return v;
  }

  // ───────────────────────────── Cymbal swells ─────────────────────────────

  /** Time-to-peak of the loaded swell recordings (ascending), or the documented defaults before the cymbal is loaded. */
  swellPeaks(): number[] {
    return this.swells.length ? this.swells.map((s) => s.peakSec) : [...DEFAULT_SWELL_PEAKS];
  }

  /**
   * Play the swell recording closest to `leadSec` so that its peak lands at `peakTime`. When
   * that start is already past, it enters the recording part-way through instead of arriving late.
   * Returns false if no swell recording is loaded.
   */
  cymbalSwell(peakTime: number, leadSec: number, vel: number, layer: LayerRole): boolean {
    if (!this.swells.length) return false;
    let sw = this.swells[0];
    for (const s of this.swells) if (Math.abs(s.peakSec - leadSec) < Math.abs(sw.peakSec - leadSec)) sw = s;
    const now = this.ctx.currentTime + 0.005;
    let start = peakTime - sw.peakSec;
    let offset = 0;
    if (start < now) {
      offset = now - start;
      start = now;
    }
    if (offset > sw.buffer.duration - 0.2) return true; // nothing left worth playing
    this.makeRoom();
    this.oneShot(sw.buffer, 1, velocityGain(vel), start, layer, 'cymbal', offset);
    return true;
  }

  // ───────────────────────────── Piano extras ─────────────────────────────

  /** Quiet mechanical noise of the sustain pedal going down or coming up. */
  pedalNoise(down: boolean, time: number, layer: LayerRole): void {
    const list = down ? this.extras.pedalDown : this.extras.pedalUp;
    if (!list.length) return;
    const i = this.rr.next(down ? 'piano:pedalD' : 'piano:pedalU', list.length);
    this.oneShot(list[i], 1, dbToGain(-25) * (0.8 + 0.4 * this.rng()), time, layer);
  }

  /** Quiet damper / key-release sample at a piano note-off. */
  pianoReleaseNoise(midi: number, vel: number, time: number, layer: LayerRole): void {
    const list = this.extras.release;
    if (!list.length || midi > 96 || this.liveCount() > MAX_VOICES * 0.75) return;
    // a full set is one sample per key from A0; otherwise rotate through whatever is there
    const idx = list.length >= 80 ? Math.min(list.length - 1, Math.max(0, midi - 21)) : this.rr.next('piano:release', list.length);
    const buf = list[idx];
    if (!buf) return;
    this.oneShot(buf, 1, dbToGain(-21) * (0.4 + 0.6 * vel), time, layer);
  }

}
