// Sample manifest + impulse-response index: types and pure helpers (no Web Audio, no Tone).

import type { InstrumentId } from '../../../shared/types.ts';

export type Family = 'strings' | 'keys' | 'winds' | 'brass' | 'harp' | 'percussion' | 'drums';

export interface SampleLayer {
  /** Upper velocity bound (0..1) of this layer; layers ascend. */
  velMax: number;
  /** MIDI number (as string) → round-robin takes (paths relative to baseUrl). */
  samples: Record<string, string[]>;
}

export interface ArticulationDef {
  gainDb?: number;
  oneShot?: boolean;
  layers: SampleLayer[];
}

export interface InstrumentDef {
  label?: string;
  family?: Family;
  range?: [number, number];
  articulations: Record<string, ArticulationDef>;
}

export interface ManifestExtras {
  pianoPedalDown?: string[];
  pianoPedalUp?: string[];
  pianoRelease?: string[];
  pianoHarmonics?: Record<string, string[]>;
  /** Cymbal crescendo recordings peaking about 1.6 s, 3.8 s and 7.2 s after their start. */
  cymbalSwellShort?: string[];
  cymbalSwellMedium?: string[];
  cymbalSwellLong?: string[];
}

/** Optional side-car written by the sample build: measured levels per file. */
export interface ManifestSidecar {
  files?: Record<string, { peakDb?: number; rmsDb?: number; loudestAtSec?: number; sfzVolumeDb?: number }>;
}

export interface SampleManifest {
  version: number;
  baseUrl: string;
  instruments: Record<string, InstrumentDef>;
  extras?: ManifestExtras;
}

export interface IrEntry {
  id: string;
  name?: string;
  file: string;
}

export const MANIFEST_URL = '/assets/samples/manifest.json';
export const SIDECAR_URL = '/assets/samples/manifest.extra.json';
export const IR_INDEX_URL = '/assets/ir/ir.json';
export const IR_BASE_URL = '/assets/ir/';

export const SYNTH_IDS = ['sub', 'pad', 'pluck', 'kick808', 'noise', 'keys', 'lead', 'supersaw', 'synth_bass', 'bell', 'brass'] as const;
export type SynthId = (typeof SYNTH_IDS)[number];

export function isSynthId(id: string): id is SynthId {
  return (SYNTH_IDS as readonly string[]).includes(id);
}

/** Instruments that borrow another instrument's samples. */
const ALIASES: Partial<Record<InstrumentId, InstrumentId>> = { violins2: 'violins' };

/** The instrument id whose samples `id` plays. */
export function sampleSourceId(id: InstrumentId): InstrumentId {
  return ALIASES[id] ?? id;
}

export function isAlias(id: InstrumentId): boolean {
  return ALIASES[id] !== undefined;
}

/** Instruments whose manifest keys are pseudo-notes: never pitch-shifted. */
const UNPITCHED = new Set<string>(['drumkit', 'bass_drum', 'cymbal', 'tam_tam']);
export function isUnpitched(id: string): boolean {
  return UNPITCHED.has(id);
}

export function emptyManifest(): SampleManifest {
  return { version: 1, baseUrl: '/assets/samples/', instruments: {} };
}

/** Defensive clean-up of whatever JSON arrived: drops malformed entries, sorts layers by velMax. */
export function normalizeManifest(raw: unknown): SampleManifest {
  const out = emptyManifest();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<SampleManifest>;
  if (typeof r.version === 'number') out.version = r.version;
  if (typeof r.baseUrl === 'string' && r.baseUrl) out.baseUrl = r.baseUrl.endsWith('/') ? r.baseUrl : r.baseUrl + '/';
  const insts = r.instruments && typeof r.instruments === 'object' ? r.instruments : {};
  for (const [id, def] of Object.entries(insts)) {
    if (!def || typeof def !== 'object' || !def.articulations) continue;
    const arts: Record<string, ArticulationDef> = {};
    for (const [artName, art] of Object.entries(def.articulations)) {
      if (!art || !Array.isArray(art.layers)) continue;
      const layers: SampleLayer[] = [];
      for (const layer of art.layers) {
        if (!layer || typeof layer.samples !== 'object' || !layer.samples) continue;
        const samples: Record<string, string[]> = {};
        for (const [key, takes] of Object.entries(layer.samples)) {
          if (!Number.isFinite(Number(key))) continue;
          const list = (Array.isArray(takes) ? takes : [takes]).filter((x): x is string => typeof x === 'string' && x.length > 0);
          if (list.length) samples[key] = list;
        }
        if (Object.keys(samples).length === 0) continue;
        layers.push({ velMax: typeof layer.velMax === 'number' ? layer.velMax : 1, samples });
      }
      if (!layers.length) continue;
      layers.sort((a, b) => a.velMax - b.velMax);
      arts[artName] = { gainDb: art.gainDb ?? 0, oneShot: !!art.oneShot, layers };
    }
    if (Object.keys(arts).length === 0) continue;
    out.instruments[id] = { label: def.label, family: def.family, range: def.range, articulations: arts };
  }
  if (r.extras && typeof r.extras === 'object') out.extras = r.extras;
  return out;
}

export function joinUrl(base: string, file: string): string {
  if (/^(https?:)?\/\//.test(file) || file.startsWith('/')) return file;
  // Only escape what would break the URL; names that are already percent-encoded stay as they are.
  const safe = file.replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/ /g, '%20');
  return (base.endsWith('/') ? base : base + '/') + safe;
}

/** Every distinct file an instrument needs (piano also pulls the pedal and release extras). */
export function instrumentFiles(manifest: SampleManifest, id: InstrumentId): string[] {
  const src = sampleSourceId(id);
  const def = manifest.instruments[src];
  const files = new Set<string>();
  if (!def) return [];
  for (const art of Object.values(def.articulations)) {
    for (const layer of art.layers) for (const takes of Object.values(layer.samples)) for (const f of takes) files.add(f);
  }
  if (src === 'piano' && manifest.extras) {
    const x = manifest.extras;
    for (const f of x.pianoPedalDown ?? []) files.add(f);
    for (const f of x.pianoPedalUp ?? []) files.add(f);
    for (const f of x.pianoRelease ?? []) files.add(f);
    // pianoHarmonics are not used by the engine, so they are not fetched
  }
  if (src === 'cymbal') for (const f of cymbalSwellFiles(manifest)) files.add(f);
  return [...files];
}

/** The cymbal swell recordings, shortest first; falls back to the plain `roll` sample. */
export function cymbalSwellFiles(manifest: SampleManifest): string[] {
  const x = manifest.extras ?? {};
  const out = [...(x.cymbalSwellShort ?? []).slice(0, 1), ...(x.cymbalSwellMedium ?? []).slice(0, 1), ...(x.cymbalSwellLong ?? []).slice(0, 1)];
  if (out.length) return out;
  const roll = manifest.instruments.cymbal?.articulations.roll;
  const first = roll?.layers[roll.layers.length - 1];
  const takes = first ? Object.values(first.samples)[0] : undefined;
  return takes?.length ? [takes[0]] : [];
}
