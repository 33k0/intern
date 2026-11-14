// Convert the raw libraries in .cache/raw into web-ready mp3 samples + manifest.json.
// Usage: node build.mjs [--force] [--only=<instrumentId>[,<id>...]] [--dry]
//
// Rules implemented (see README.md):
//  * mp3, libmp3lame VBR -q:a 4 (~160 kbps; -q:a 2 / 0 for low-level files), 44.1 kHz, stereo
//  * leading silence removed (threshold relative to the file peak, never above -55 dBFS), 2 ms pre-roll
//  * caps: sustain 9 s, piano 14/10/6 s, short articulations 4 s, ringing percussion per instrument;
//    0.3 s fade-out at the cap (longer for ringing percussion)
//  * NO per-sample normalisation: exactly one fixed gain per instrument+articulation (manifest gainDb)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  RAW, ROOT, SAMPLES, ensureDir, walk, ffmpeg, noteToMidi, midiToName, pool, dB, decodeMono, timpaniPrincipal, coarseOnset,
} from './lib.mjs';
import { analyzeAll } from './analyze.mjs';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const TARGET_PEAK_DB = -3; // loudest sample of each instrument+articulation lands here
// libmp3lame VBR quality: V4 (~160 kbps on full-level stereo material). LAME spends far fewer bits on
// low-level audio, and the soft dynamic layers are 20-50 dB below full scale (levels are deliberately not
// normalised), so quiet files get a higher VBR quality to keep them clean if the engine boosts them.
const mp3Quality = (peakDb) => (peakDb < -24 ? '0' : peakDb < -12 ? '2' : '4');

// ------------------------------------------------------------------ helpers
const DYN_ORDER = ['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];

/** Parse an .sfz into Map(lowercased sample basename -> opcodes). */
function parseSfz(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const txt = fs.readFileSync(file, 'latin1').replace(/\/\/[^\r\n]*/g, '');
  for (const region of txt.split('<region>').slice(1)) {
    const op = {};
    for (const line of region.split(/\r?\n/)) {
      const m = /^\s*(\w+)=(.*?)\s*$/.exec(line);
      if (m) op[m[1]] = m[2];
    }
    if (!op.sample) continue;
    const base = op.sample.split(/[\\/]/).pop().toLowerCase();
    if (!map.has(base)) map.set(base, op);
  }
  return map;
}

/** Dynamic-layer rank and round-robin index from a library file name. */
function parseTokens(base) {
  let dyn = null;
  let dynLabel = null;
  let m = /_v(\d+)(?=_|$)/i.exec(base);
  if (m) {
    dyn = +m[1];
    dynLabel = 'v' + m[1];
  } else {
    m = /_(pppp|ppp|pp|p|mp|mf|f|ff|fff)(?=_|$)/.exec(base);
    if (m) {
      dyn = DYN_ORDER.indexOf(m[1]);
      dynLabel = m[1];
    }
  }
  let rr = 1;
  m = /_rr(\d+)/i.exec(base);
  if (m) rr = +m[1];
  else {
    m = /_v\d+_(\d+)$/i.exec(base); // "susvib_E1_v1_2" style variants
    if (m) rr = +m[1];
  }
  return { dyn: dyn ?? 0, dynLabel: dynLabel ?? 'mf', rr };
}

/**
 * entries [{src, midi, dyn, dynLabel, rr}] -> layers (array, soft -> loud) of Map(midi -> [entry...]).
 * Up to `maxLayers` dynamic layers and `maxRR` round-robin takes. Every layer covers every sampled key:
 * where a key has fewer dynamics than the instrument, the nearest dynamic is reused (ties -> louder).
 */
function buildLayers(entries, { maxLayers = 3, maxRR = 3, fill = true } = {}) {
  if (!fill) {
    // layers taken literally from the dyn index; a key may be absent from a layer (engine uses the nearest key)
    const dyns = [...new Set(entries.map((e) => e.dyn))].sort((a, b) => a - b).slice(0, maxLayers);
    return dyns.map((d) => {
      const m = new Map();
      for (const e of entries.filter((x) => x.dyn === d).sort((a, b) => a.midi - b.midi || a.rr - b.rr)) {
        if (!m.has(e.midi)) m.set(e.midi, []);
        if (m.get(e.midi).length < maxRR) m.get(e.midi).push(e);
      }
      return m;
    });
  }
  const byKey = new Map();
  for (const e of entries) {
    if (!byKey.has(e.midi)) byKey.set(e.midi, new Map());
    const d = byKey.get(e.midi);
    if (!d.has(e.dyn)) d.set(e.dyn, []);
    d.get(e.dyn).push(e);
  }
  let maxK = 0;
  for (const d of byKey.values()) maxK = Math.max(maxK, d.size);
  const L = Math.min(maxLayers, maxK);
  const layers = Array.from({ length: L }, () => new Map());
  for (const [midi, d] of [...byKey.entries()].sort((a, b) => a[0] - b[0])) {
    const dyns = [...d.keys()].sort((a, b) => a - b);
    const k = dyns.length;
    for (let j = 0; j < L; j++) {
      const idx = L === 1 ? k - 1 : Math.round((j * (k - 1)) / (L - 1));
      const takes = d.get(dyns[idx]).sort((a, b) => a.rr - b.rr).slice(0, maxRR);
      layers[j].set(midi, takes);
    }
  }
  return layers;
}

const VELMAX = { 1: [1.0], 2: [0.5, 1.0], 3: [0.35, 0.7, 1.0] };

// ------------------------------------------------------------------ instrument definitions
const VS = path.join(RAW, 'vsco2');
const SFZ = path.join(RAW, 'vsco2-sfz');
const VC = path.join(RAW, 'vcsl', 'Idiophones', 'Struck Idiophones');
const DK = path.join(RAW, 'salamander-drumkit-samples', 'extracted', 'OH');
const PN = path.join(RAW, 'piano-tonejs');

const warnings = [];
const warn = (s) => {
  warnings.push(s);
  console.warn('  ! ' + s);
};

// Key-centre corrections to the VSCO SFZ mapping, found by pitch analysis (check.mjs):
//  * "trem_B2_v2_1.wav" in the cello section is really the loud take of B2 (MIDI 47, partials at
//    n x 124 Hz); it is misnamed (should be "B1" in VSCO's octave-low naming) and the SFZ maps it to 59.
const VSCO_KEY_OVERRIDES = { 'Strings/Cello Section/trem/trem_B2_v2_1.wav': 47 };

/**
 * Timpani fine tuning. The five VSCO drums sit up to ~0.8 semitone away from the SFZ key centres
 * (and the rolls are tuned differently from the hits). Measure the principal of every file, assign each
 * drum to the nearest semitone and correct the remainder by resampling (asetrate), so the manifest keys
 * are true pitches. `win` = [start, length] in seconds after the onset used for the measurement.
 */
async function tuneTimpani(entries, win) {
  const RATE = 5512;
  const byDrum = new Map();
  for (const e of entries) {
    const x = await decodeMono(e.src, RATE);
    const on = coarseOnset(x);
    const w = x.subarray(on + Math.floor(win[0] * RATE), Math.min(x.length, on + Math.floor((win[0] + win[1]) * RATE)));
    e.measured = timpaniPrincipal(w, RATE, e.midi);
    const d = /Timpani(\d)/.exec(path.basename(e.src))[1];
    if (!byDrum.has(d)) byDrum.set(d, []);
    byDrum.get(d).push(e);
  }
  for (const [d, es] of byDrum) {
    const ms = es.map((e) => e.measured).sort((a, b) => a - b);
    const med = ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2;
    const key = Math.round(med - 0.05); // exact half-way cases go down
    for (const e of es) {
      // use the file's own measurement unless it disagrees with its drum (then trust the drum median)
      const m = Math.abs(e.measured - med) <= 0.6 ? e.measured : med;
      const shift = Math.max(-0.75, Math.min(0.75, key - m));
      e.sfzKey = e.midi;
      e.midi = key;
      e.tuneSemitones = +shift.toFixed(3);
      e.extraFilter = Math.abs(shift) >= 0.02 ? `asetrate=44100*${Math.pow(2, shift / 12).toFixed(6)},aresample=44100` : null;
    }
    console.log(`  timpani drum ${d}: measured ${ms.map((v) => v.toFixed(2)).join(' ')} -> key ${key} (SFZ said ${es[0].sfzKey})`);
  }
  return entries;
}

/** A pitched VSCO articulation: folder + its SFZ map (authoritative key centres). */
function vscoArt(folder, sfzName, opts = {}) {
  const dir = path.join(VS, folder);
  const sfz = parseSfz(path.join(SFZ, sfzName + '.sfz'));
  const entries = [];
  for (const f of walk(dir)) {
    if (path.dirname(f) !== dir || !/\.wav$/i.test(f)) continue;
    const base = path.basename(f).replace(/\.wav$/i, '');
    const op = sfz.get(path.basename(f).toLowerCase());
    let midi = op && op.pitch_keycenter != null ? parseInt(op.pitch_keycenter, 10) : null;
    const ov = VSCO_KEY_OVERRIDES[`${folder}/${path.basename(f)}`];
    if (ov != null) midi = ov;
    if (midi == null || Number.isNaN(midi)) {
      warn(`${folder}/${base}: not in ${sfzName}.sfz, skipped`);
      continue;
    }
    if (opts.filter && !opts.filter(base)) continue;
    entries.push({ src: f, midi, sfzVolumeDb: op.volume != null ? parseFloat(op.volume) : null, ...parseTokens(base) });
  }
  if (!entries.length) warn(`no samples found in ${folder}`);
  return entries;
}

const SUS = { kind: 'sustain', cap: 9, fade: 0.3, oneShot: false, maxRR: 1 };
const SHORT = { kind: 'short', cap: 4, fade: 0.3, oneShot: true, maxRR: 3 };
const ring = (cap, fade = 1.0) => ({ kind: 'ring', cap, fade, oneShot: true, maxRR: 3 });

function strings(id, label, folder, sfzPrefix, names, range, extra = {}) {
  return {
    id, label, family: 'strings', source: 'VSCO 2 CE', licence: 'CC0', range,
    articulations: {
      sustain: { ...SUS, short: 'sus', entries: () => vscoArt(`Strings/${folder}/${names.sus}`, sfzPrefix + names.susSfz) },
      spiccato: { ...SHORT, short: 'spic', entries: () => vscoArt(`Strings/${folder}/${names.spic}`, sfzPrefix + 'Spic') },
      tremolo: { ...SUS, short: 'trem', entries: () => vscoArt(`Strings/${folder}/${names.trem}`, sfzPrefix + 'Trem') },
      pizzicato: { ...SHORT, short: 'pizz', entries: () => vscoArt(`Strings/${folder}/${names.pizz}`, sfzPrefix + 'Pizz') },
    },
    ...extra,
  };
}

function pianoEntries() {
  const VEL = [1, 4, 8, 12, 16];
  const out = [];
  for (const f of walk(PN)) {
    const m = /^([A-G]s?\d)v(\d+)\.mp3$/.exec(path.basename(f));
    if (!m) continue;
    const li = VEL.indexOf(+m[2]);
    if (li < 0) continue;
    out.push({ src: f, midi: noteToMidi(m[1]), dyn: li, dynLabel: 'v' + m[2], rr: 1, outName: `${m[1]}v${m[2]}` });
  }
  return out;
}

function vcslEntries(sub, re, pick, octaveShift) {
  const dir = path.join(VC, sub);
  const out = [];
  for (const f of walk(dir)) {
    const base = path.basename(f).replace(/\.wav$/i, '');
    const m = re.exec(base);
    if (!m) continue;
    const p = pick(m, base, f);
    if (!p) continue;
    const midi = noteToMidi(p.note);
    if (midi == null) {
      warn(`cannot parse note in ${base}`);
      continue;
    }
    out.push({ src: f, midi: midi + octaveShift, dyn: p.dyn, dynLabel: p.dynLabel, rr: p.rr ?? 1 });
  }
  return out;
}

/** Unpitched one-shots: files matched by regexp, mapped to a fixed pseudo-note. */
function fixed(dir, midi, layerRes, { maxRR = 3, extraFilter = null, tag = '', gainOf = null } = {}) {
  // layerRes: array (soft -> loud) of RegExp; rr = natural sort order of the matching files
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.wav$/i.test(f)) : [];
  const out = [];
  layerRes.forEach((re, li) => {
    const hit = files
      .filter((f) => re.test(f))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .slice(0, maxRR);
    if (!hit.length) warn(`no file for ${re} in ${dir}`);
    hit.forEach((f, i) =>
      out.push({
        src: path.join(dir, f), midi, dyn: li, dynLabel: 'l' + (li + 1), rr: i + 1, extraFilter,
        gainOffsetDb: gainOf ? gainOf(f) : 0,
        outName: (tag || f.replace(/\.wav$/i, '')).replace(/[^A-Za-z0-9_-]+/g, '_') + (tag ? `_l${li + 1}_rr${i + 1}` : ''),
      }),
    );
  });
  return out;
}

// Octave conventions of the VCSL file names, verified by pitch detection (see check.mjs / README):
const GLOCK_OCTAVE_SHIFT = 12;
const VIBES_OCTAVE_SHIFT = 12;

const PERC = path.join(VS, 'Percussion');

// Salamander Drumkit: every wav is peak-normalised at the source, the kit balance lives in the
// <group> volume= opcodes of the library's own ALL.sfz. Those library-defined values are applied
// (one per kit piece / dynamic group) so that e.g. hi-hats are not as loud as the snare.
function drumkitGroupVolumes() {
  const f = path.join(RAW, 'salamander-drumkit-samples', 'extracted', 'ALL.sfz');
  const map = new Map();
  if (!fs.existsSync(f)) return map;
  let vol = 0;
  for (const line of fs.readFileSync(f, 'latin1').split(/\r?\n/)) {
    const code = line.replace(/\/\/.*$/, '');
    if (code.includes('<group>')) {
      const m = /volume=(-?[\d.]+)/.exec(code);
      vol = m ? parseFloat(m[1]) : 0;
    }
    const s = /sample=OH\\(\S+\.wav)/i.exec(code);
    if (s && !map.has(s[1].toLowerCase())) map.set(s[1].toLowerCase(), vol);
  }
  return map;
}
const DK_VOL = drumkitGroupVolumes();
const dkGain = (f) => {
  if (!DK_VOL.has(f.toLowerCase())) warn(`drumkit: ${f} not found in ALL.sfz, group volume 0 dB assumed`);
  return DK_VOL.get(f.toLowerCase()) ?? 0;
};
const semis = (n) => `asetrate=44100*${Math.pow(2, n / 12).toFixed(6)},aresample=44100`;

const INSTRUMENTS = [
  {
    id: 'piano', label: 'Grand Piano (Salamander)', family: 'keys', source: 'Salamander Grand Piano V3 (via @tonejs/piano)',
    licence: 'CC BY 3.0', range: [21, 108],
    articulations: {
      sustain: {
        kind: 'piano', oneShot: false, maxRR: 1, maxLayers: 5, fade: 0.3, short: '',
        capFor: (midi) => (midi < 48 ? 14 : midi <= 72 ? 10 : 6),
        velMax: [0.16, 0.38, 0.63, 0.88, 1.0], // midpoints between the 16-step layers 1,4,8,12,16
        entries: pianoEntries,
      },
    },
  },
  strings('violins', 'Violins (section)', 'Violin Section', 'ViolinEns', { sus: 'susVib', susSfz: 'SusVib', spic: 'Spic', trem: 'Trem', pizz: 'Pizz' }, [55, 91]),
  strings('violas', 'Violas (section)', 'Viola Section', 'ViolaEns', { sus: 'susvib', susSfz: 'SusVib', spic: 'spic', trem: 'trem', pizz: 'pizz' }, [48, 86]),
  strings('celli', 'Celli (section)', 'Cello Section', 'CelloEns', { sus: 'susvib', susSfz: 'SusVib', spic: 'spic', trem: 'trem', pizz: 'pizzT' }, [36, 81]),
  strings('basses', 'Double Bass (solo contrabass - VSCO 2 CE has no bass section)', 'Solo Contrabass', 'Contrabass', { sus: 'SusVib', susSfz: 'SusVB', spic: 'Spic', trem: 'Trem', pizz: 'Pizz' }, [24, 60]),
  strings('solo_violin', 'Solo Violin', 'Solo Violin', 'SViolin', { sus: 'Arco Vib', susSfz: 'Vib', spic: 'spic', trem: 'Trem', pizz: 'Pizz' }, [55, 100]),
  {
    id: 'flute', label: 'Flute', family: 'winds', source: 'VSCO 2 CE', licence: 'CC0', range: [60, 98],
    articulations: {
      sustain: { ...SUS, short: 'sus', entries: () => vscoArt('Woodwinds/Flute/susvib', 'FluteSusVib') },
      staccato: { ...SHORT, short: 'stac', entries: () => vscoArt('Woodwinds/Flute/stac', 'FluteStac') },
    },
  },
  {
    id: 'oboe', label: 'Oboe', family: 'winds', source: 'VSCO 2 CE', licence: 'CC0', range: [58, 91],
    articulations: {
      sustain: { ...SUS, short: 'sus', entries: () => vscoArt('Woodwinds/Oboe/Vib', 'OboeSusVib') },
      staccato: { ...SHORT, short: 'stac', entries: () => vscoArt('Woodwinds/Oboe/Stacc', 'OboeStac') },
    },
  },
  {
    id: 'clarinet', label: 'Clarinet', family: 'winds', source: 'VSCO 2 CE', licence: 'CC0', range: [50, 91],
    articulations: {
      sustain: { ...SUS, short: 'sus', entries: () => vscoArt('Woodwinds/Clarinet/susLong', 'ClarinetSus') },
      staccato: { ...SHORT, short: 'stac', entries: () => vscoArt('Woodwinds/Clarinet/stac', 'ClarinetStac') },
    },
  },
  {
    id: 'horn', label: 'French Horn', family: 'brass', source: 'VSCO 2 CE', licence: 'CC0', range: [34, 77],
    articulations: {
      sustain: { ...SUS, short: 'sus', entries: () => vscoArt('Brass/F Horn/sus', 'FHornSus') },
      staccato: { ...SHORT, short: 'stac', entries: () => vscoArt('Brass/F Horn/stac', 'FHornStac') },
    },
  },
  {
    id: 'harp', label: 'Harp', family: 'harp', source: 'VSCO 2 CE', licence: 'CC0', range: [24, 103],
    articulations: {
      // plucked, rings out: use like a one-shot (articulation id "sustain" = the normal played note)
      sustain: { ...ring(9, 0.6), short: 'pluck', maxLayers: 1, entries: () => vscoArt('Strings/Harp', 'Harp') },
    },
  },
  {
    id: 'timpani', label: 'Timpani', family: 'percussion', source: 'VSCO 2 CE', licence: 'CC0', range: [38, 58],
    articulations: {
      hit: { ...ring(8, 1.0), short: 'hit', entries: () => vscoArt('Percussion/Timpani', 'Timpani'), prepare: (es) => tuneTimpani(es, [0.2, 0.8]) },
      roll: { ...SUS, short: 'roll', entries: () => vscoArt('Percussion/Timpani/Rolls', 'TimpaniRolls'), prepare: (es) => tuneTimpani(es, [0.2, 3.0]) },
    },
  },
  {
    id: 'bass_drum', label: 'Orchestral Bass Drum', family: 'percussion', source: 'VSCO 2 CE', licence: 'CC0', range: [36, 36],
    articulations: {
      hit: { ...ring(6, 1.0), short: 'hit', entries: () => fixed(PERC, 36, [/^BDrumNewhit_v2_/, /^BDrumNewhit_v5_/, /^BDrumNewhit_v7_/]) },
    },
  },
  {
    id: 'cymbal', label: 'Orchestral Cymbals (clash crash + suspended swell)', family: 'percussion', source: 'VSCO 2 CE', licence: 'CC0', range: [49, 49],
    articulations: {
      hit: { ...ring(8, 1.5), short: 'hit', entries: () => fixed(PERC, 49, [/^cymbal-crash1_pp_/, /^cymbal-crash1_mf_/, /^cymbal-crash1_ff_/]) },
      // suspended-cymbal crescendo swell (soft mallets): the roll builds to a peak, then rings out.
      // manifest roll@49 = the medium swell; short/long variants are exposed through manifest.extras.
      roll: {
        kind: 'ring', cap: 12, fade: 1.5, oneShot: true, maxRR: 1, short: 'roll',
        entries: () => fixed(PERC, 49, [/^susCymb1-cresc-Median_v1/], { tag: 'swell_medium' }),
        extras: () => ({
          cymbalSwellShort: { src: path.join(PERC, 'susCymb1-cresc-Short_v1.wav'), out: 'cymbal/swell_short.mp3' },
          cymbalSwellLong: { src: path.join(PERC, 'susCymb1-cresc-Long_v1.wav'), out: 'cymbal/swell_long.mp3' },
        }),
        extrasSelf: 'cymbalSwellMedium',
      },
    },
  },
  {
    id: 'tam_tam', label: 'Tam-tam (gong)', family: 'percussion', source: 'VSCO 2 CE', licence: 'CC0', range: [52, 52],
    articulations: {
      hit: { ...ring(12, 2.5), short: 'hit', entries: () => fixed(PERC, 52, [/^gongHit_p\./, /^gongHit_mf\./, /^gongHit_fff\./]) },
    },
  },
  {
    id: 'glockenspiel', label: 'Glockenspiel', family: 'percussion', source: 'VCSL', licence: 'CC0', range: [79, 108],
    articulations: {
      hit: {
        // the loud layer was sampled on G#7 instead of G7, so layers keep their own key sets (no fill)
        ...ring(6, 1.0), short: 'hit', fill: false,
        entries: () =>
          vcslEntries('Glockenspiel', /^glock_(soft|medium|loud)_([A-G]#?\d)_(\d+)$/, (m) => ({
            note: m[2], dyn: ['soft', 'medium', 'loud'].indexOf(m[1]), dynLabel: m[1], rr: 1,
          }), GLOCK_OCTAVE_SHIFT),
      },
    },
  },
  {
    id: 'vibraphone', label: 'Vibraphone (motor off)', family: 'percussion', source: 'VCSL', licence: 'CC0', range: [53, 89],
    articulations: {
      hit: {
        ...ring(9, 1.0), short: 'hit',
        entries: () =>
          vcslEntries('Vibraphone', /^Vibes_(soft|hard)_([A-G]#?\d)_v(\d)_rr(\d)_Main$/, (m) => {
            // 3 dynamics: soft mallet v1, soft mallet v2, hard mallet v3
            const key = `${m[1]}${m[3]}`;
            const li = { soft1: 0, soft2: 1, hard3: 2 }[key];
            if (li == null) return null;
            return { note: m[2], dyn: li, dynLabel: key, rr: 1 };
          }, VIBES_OCTAVE_SHIFT),
      },
    },
  },
  {
    id: 'drumkit', label: 'Drum Kit (Salamander, overhead mics)', family: 'drums', source: 'Salamander Drumkit', licence: 'CC BY-SA 3.0', range: [36, 51],
    articulations: {
      hit: {
        kind: 'drum', oneShot: true, maxRR: 3, short: '', cap: 4, fade: 0.3,
        // drums: cut right before the transient (3 ms before the level is within 40 dB of the peak);
        // the kick otherwise keeps ~10 ms of beater noise in front of the hit
        tightTrim: true,
        capFor: (midi) => (midi === 49 || midi === 51 ? 7 : midi === 46 ? 5 : 4),
        fadeFor: (midi) => (midi === 49 || midi === 51 ? 1.2 : 0.3),
        perKeyLayers: true,
        entries: () => [
          ...fixed(DK, 36, [/^kick_OH_P_/, /^kick_OH_F_/, /^kick_OH_FF_/], { tag: 'kick', gainOf: dkGain }),
          ...fixed(DK, 38, [/^snare_OH_Ghost_/, /^snare_OH_MP_/, /^snare_OH_F_/, /^snare_OH_FF_/], { tag: 'snare', gainOf: dkGain }),
          ...fixed(DK, 42, [/^hihatClosed_OH_P_/, /^hihatClosed_OH_F_/], { tag: 'hat_closed', gainOf: dkGain }),
          ...fixed(DK, 44, [/^hihatFoot_OH_MP_/], { tag: 'hat_pedal', gainOf: dkGain }),
          ...fixed(DK, 46, [/^hihatOpen_OH_P_/, /^hihatOpen_OH_F_/, /^hihatOpen_OH_FF_/], { tag: 'hat_open', gainOf: dkGain }),
          ...fixed(DK, 45, [/^loTom_OH_PP_/, /^loTom_OH_MP_/, /^loTom_OH_FF_/], { tag: 'tom_low', gainOf: dkGain }),
          // the kit only has two toms: the mid tom is the high tom re-pitched (resampled) 5 semitones down
          // (high tom ~140 Hz, low tom ~70 Hz, derived mid tom ~105 Hz)
          ...fixed(DK, 47, [/^hiTom_OH_P_/, /^hiTom_OH_F_/, /^hiTom_OH_FF_/], { tag: 'tom_mid', extraFilter: semis(-5), gainOf: dkGain }),
          ...fixed(DK, 50, [/^hiTom_OH_P_/, /^hiTom_OH_F_/, /^hiTom_OH_FF_/], { tag: 'tom_high', gainOf: dkGain }),
          ...fixed(DK, 51, [/^ride2_OH_PP_/, /^ride2_OH_MP_/, /^ride2_OH_FF_/], { tag: 'ride', gainOf: dkGain }),
          ...fixed(DK, 49, [/^crash1_OH_P_/, /^crash1_OH_FF_/], { tag: 'crash', gainOf: dkGain }),
        ],
        // velMax per number of layers at a key
        velMaxFor: (n) => ({ 1: [1.0], 2: [0.45, 1.0], 3: [0.45, 0.75, 1.0], 4: [0.2, 0.45, 0.75, 1.0] })[n],
      },
    },
  },
];

// piano helpers that live in manifest.extras (same fixed gain as the piano notes)
function pianoExtras() {
  const files = walk(PN).map((f) => path.basename(f));
  const num = (s) => parseInt(/\d+/.exec(s)[0], 10);
  return {
    pianoPedalDown: files.filter((f) => /^pedalD\d\.mp3$/.test(f)).sort(),
    pianoPedalUp: files.filter((f) => /^pedalU\d\.mp3$/.test(f)).sort(),
    pianoRelease: files.filter((f) => /^rel\d+\.mp3$/.test(f)).sort((a, b) => num(a) - num(b)),
    pianoHarmonics: files.filter((f) => /^harmS[A-G]s?\d\.mp3$/.test(f)),
  };
}

// ------------------------------------------------------------------ plan
const jobs = new Map(); // out rel path -> job
function addJob(job) {
  const prev = jobs.get(job.out);
  if (prev && prev.src !== job.src) throw new Error(`output name collision: ${job.out}`);
  jobs.set(job.out, job);
}

const manifest = { version: 1, baseUrl: '/assets/samples/', instruments: {}, extras: {} };
const extra = { generated: null, note: 'Informational side-car for manifest.json (levels, durations, provenance). Not required by the engine.', instruments: {}, files: {} };
const plan = [];

for (const inst of INSTRUMENTS) {
  if (ONLY.length && !ONLY.includes(inst.id)) continue;
  const mi = { label: inst.label, family: inst.family, source: inst.source, licence: inst.licence, range: inst.range, articulations: {} };
  for (const [artId, art] of Object.entries(inst.articulations)) {
    let entries = art.entries();
    if (art.prepare && entries.length) entries = await art.prepare(entries);
    if (!entries.length) {
      warn(`${inst.id}.${artId}: no source samples - articulation omitted`);
      continue;
    }
    for (const e of entries) {
      const stem = e.outName ?? `${art.short}_${e.dynLabel}_${midiToName(e.midi)}${e.rr > 1 ? `_rr${e.rr}` : ''}`;
      e.out = `${inst.id}/${stem}.mp3`;
      e.cap = art.capFor ? art.capFor(e.midi) : art.cap;
      e.fade = art.fadeFor ? art.fadeFor(e.midi) : art.fade;
    }
    let layers;
    let velMaxes;
    if (art.perKeyLayers) {
      // drum kit: each piece has its own number of dynamics; build a common 3-layer grid for the manifest
      const keys = [...new Set(entries.map((e) => e.midi))].sort((a, b) => a - b);
      const perKey = new Map();
      for (const k of keys) {
        const ke = entries.filter((e) => e.midi === k);
        const n = new Set(ke.map((e) => e.dyn)).size;
        const vm = art.velMaxFor(n);
        perKey.set(k, vm.map((v, i) => ({ velMax: v, takes: ke.filter((e) => e.dyn === i).sort((a, b) => a.rr - b.rr).slice(0, art.maxRR) })));
      }
      // a layer boundary exists wherever any piece has one; each piece contributes the sample set that covers it
      const bounds = [...new Set([...perKey.values()].flatMap((ls) => ls.map((l) => l.velMax)))].sort((a, b) => a - b);
      layers = bounds.map(() => new Map());
      velMaxes = bounds;
      bounds.forEach((b, bi) => {
        for (const [k, ls] of perKey) layers[bi].set(k, ls.find((l) => b <= l.velMax + 1e-9).takes);
      });
    } else {
      layers = buildLayers(entries, { maxLayers: art.maxLayers ?? 3, maxRR: art.maxRR, fill: art.fill ?? true });
      velMaxes = art.velMax ?? VELMAX[layers.length];
    }
    const used = new Set();
    for (const l of layers) for (const takes of l.values()) for (const e of takes) used.add(e);
    const artExtras = art.extras ? Object.entries(art.extras()).filter(([, v]) => fs.existsSync(v.src) || (warn(`missing ${v.src}`), false)) : [];
    plan.push({ inst, artId, art, layers, velMaxes, used: [...used], artExtras });
    mi.articulations[artId] = { gainDb: 0, oneShot: art.oneShot, layers: [] };
  }
  manifest.instruments[inst.id] = mi;
}

// ------------------------------------------------------------------ analyse sources, derive gains
const allSrc = new Set();
for (const p of plan) {
  for (const e of p.used) allSrc.add(e.src);
  for (const [, v] of p.artExtras) allSrc.add(v.src);
}
const px = !ONLY.length || ONLY.includes('piano') ? pianoExtras() : null;
if (px) for (const k of Object.keys(px)) for (const f of px[k]) allSrc.add(path.join(PN, f));
console.log(`analysing ${allSrc.size} source files ...`);
const an = await analyzeAll([...allSrc]);

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

for (const p of plan) {
  const peaks = [...p.used.map((e) => an[e.src].peakDb + (e.gainOffsetDb || 0)), ...p.artExtras.map(([, v]) => an[v.src].peakDb)];
  const maxPeak = Math.max(...peaks);
  const gainDb = Math.round((TARGET_PEAK_DB - maxPeak) * 2) / 2;
  p.gainDb = gainDb;
  const art = manifest.instruments[p.inst.id].articulations[p.artId];
  art.gainDb = gainDb;
  const ex = ((extra.instruments[p.inst.id] ??= {})[p.artId] = { gainDb, capSec: p.art.cap ?? null, layers: [] });
  p.layers.forEach((layer, li) => {
    const samples = {};
    const lp = [];
    const lr = [];
    const ld = [];
    for (const [midi, takes] of [...layer.entries()].sort((a, b) => a[0] - b[0])) {
      samples[String(midi)] = takes.map((e) => e.out);
      for (const e of takes) {
        const a = an[e.src];
        const start = p.art.tightTrim ? Math.max(a.start, a.t40 - 0.003) : a.start;
        const g = gainDb + (e.gainOffsetDb || 0);
        lp.push(a.peakDb + g);
        lr.push(a.rmsDb + g);
        ld.push(Math.min(e.cap, a.duration - start));
        addJob({ src: e.src, out: e.out, start, cap: e.cap, fade: e.fade, gainDb: g, groupGainDb: e.gainOffsetDb || 0, sfzVolumeDb: e.sfzVolumeDb ?? null, tuneSemitones: e.tuneSemitones ?? null, srcDur: a.duration, extraFilter: e.extraFilter || null });
      }
    }
    art.layers.push({ velMax: p.velMaxes[li], samples });
    ex.layers.push({
      velMax: p.velMaxes[li],
      medianPeakDb: +median(lp).toFixed(1),
      medianRmsDb: +median(lr).toFixed(1),
      medianDurationSec: +median(ld).toFixed(2),
      minDurationSec: +Math.min(...ld).toFixed(2),
    });
  });
  // extra one-shots that belong to this articulation (same fixed gain), exposed via manifest.extras
  for (const [key, v] of p.artExtras) {
    const a = an[v.src];
    addJob({ src: v.src, out: v.out, start: a.start, cap: p.art.cap, fade: p.art.fade, gainDb, srcDur: a.duration, extraFilter: null });
    manifest.extras[key] = [v.out];
  }
  if (p.art.extrasSelf) manifest.extras[p.art.extrasSelf] = [...new Set(p.used.map((e) => e.out))];
  const nFiles = new Set(p.used.map((e) => e.out)).size;
  console.log(
    `${(p.inst.id + '.' + p.artId).padEnd(24)} files ${String(nFiles).padStart(3)}  layers ${p.layers.length}  keys ${p.layers[0].size}` +
      `  srcPeak max ${maxPeak.toFixed(1)} dB -> gain ${gainDb >= 0 ? '+' : ''}${gainDb} dB` +
      `  layer median peaks [${ex.layers.map((l) => l.medianPeakDb).join(', ')}]  median dur [${ex.layers.map((l) => l.medianDurationSec).join(', ')}] s`,
  );
}

if (px) {
  const g = manifest.instruments.piano.articulations.sustain.gainDb;
  const mk = (f) => {
    const a = an[path.join(PN, f)];
    // pedal / release / harmonic noises: keep whole, never trim more than digital silence
    addJob({ src: path.join(PN, f), out: `piano/${f}`, start: a.start, cap: 8, fade: 0.3, gainDb: g, srcDur: a.duration, extraFilter: null });
    return `piano/${f}`;
  };
  manifest.extras.pianoPedalDown = px.pianoPedalDown.map(mk);
  manifest.extras.pianoPedalUp = px.pianoPedalUp.map(mk);
  manifest.extras.pianoRelease = px.pianoRelease.map(mk); // index 0 = key 1 (A0) ... index 87 = key 88 (C8)
  manifest.extras.pianoHarmonics = {};
  for (const f of px.pianoHarmonics) {
    const midi = noteToMidi(/^harmS([A-G]s?\d)/.exec(f)[1]);
    manifest.extras.pianoHarmonics[String(midi)] = [mk(f)];
  }
  manifest.extras.pianoHarmonics = Object.fromEntries(Object.entries(manifest.extras.pianoHarmonics).sort((a, b) => a[0] - b[0]));
}

// ------------------------------------------------------------------ encode
function filterChain(j) {
  const f = [`atrim=start=${j.start.toFixed(5)}`, 'asetpts=PTS-STARTPTS'];
  let len = j.srcDur - j.start;
  if (j.extraFilter) {
    // resampling pitch change (drum kit mid tom): duration scales by 1/ratio
    f.push('aresample=44100', j.extraFilter, 'asetpts=N/SR/TB');
    len /= parseFloat(/\*([\d.]+)/.exec(j.extraFilter)[1]);
  }
  if (j.start > 0) f.push('afade=t=in:st=0:d=0.0015');
  const capped = len > j.cap + 0.02;
  if (capped) f.push(`atrim=end=${j.cap}`, `afade=t=out:st=${(j.cap - j.fade).toFixed(4)}:d=${j.fade}`);
  if (j.gainDb !== 0) f.push(`volume=${j.gainDb}dB`);
  f.push('aresample=44100', 'aformat=sample_fmts=s16p:channel_layouts=stereo');
  return { chain: f.join(','), capped };
}

const stateFile = path.join(ROOT, '.cache', 'build-state.json');
const state = fs.existsSync(stateFile) && !FORCE ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
let encoded = 0;
let skipped = 0;
const list = [...jobs.values()];
console.log(`${list.length} output files planned`);
if (!DRY) {
  await pool(list, Math.max(2, os.cpus().length - 2), async (j) => {
    const dest = path.join(SAMPLES, j.out);
    const { chain, capped } = filterChain(j);
    const q = mp3Quality(an[j.src].peakDb + j.gainDb);
    const sig = `${j.src}|${fs.statSync(j.src).size}|${chain}|q${q}`;
    extra.files[j.out] = {
      source: path.relative(RAW, j.src),
      trimStartMs: +(j.start * 1000).toFixed(1),
      loudestAtSec: +Math.max(0, an[j.src].loudestAt - j.start).toFixed(2),
      cappedAtSec: capped ? j.cap : null,
      gainDb: j.gainDb,
      ...(j.groupGainDb ? { libraryGroupVolumeDb: j.groupGainDb } : {}),
      peakDb: +(an[j.src].peakDb + j.gainDb).toFixed(1),
      rmsDb: +(an[j.src].rmsDb + j.gainDb).toFixed(1),
      mp3Vbr: 'V' + q,
      // VSCO 2 CE only: the per-region `volume` its own SFZ mapping adds at playback (NOT applied here)
      ...(j.sfzVolumeDb != null ? { sfzVolumeDb: j.sfzVolumeDb } : {}),
      ...(j.extraFilter ? { resampled: j.extraFilter } : {}),
      ...(j.tuneSemitones != null ? { tunedBySemitones: j.tuneSemitones } : {}),
    };
    if (state[j.out] === sig && fs.existsSync(dest)) {
      skipped++;
      return;
    }
    ensureDir(path.dirname(dest));
    const r = await ffmpeg(['-y', '-i', j.src, '-vn', '-af', chain, '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', q, '-map_metadata', '-1', dest]);
    if (r.code !== 0) throw new Error(`ffmpeg failed for ${j.src}\n${r.stderr.slice(-600)}`);
    state[j.out] = sig;
    if (++encoded % 200 === 0) console.log(`  encoded ${encoded}`);
  });
  // drop outputs that are no longer part of the plan (only inside instrument folders we own)
  if (!ONLY.length) {
    const keep = new Set(list.map((j) => j.out));
    for (const f of walk(SAMPLES)) {
      const rel = path.relative(SAMPLES, f).split(path.sep).join('/');
      if (rel.endsWith('.mp3') && !keep.has(rel)) {
        fs.rmSync(f);
        delete state[rel];
        console.log('  removed stale', rel);
      }
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log(`encoded ${encoded}, up-to-date ${skipped}`);
  if (!ONLY.length) {
    ensureDir(SAMPLES);
    fs.writeFileSync(path.join(SAMPLES, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
    extra.generated = new Date().toISOString();
    extra.warnings = warnings;
    fs.writeFileSync(path.join(SAMPLES, 'manifest.extra.json'), JSON.stringify(extra, null, 1) + '\n');
    console.log('wrote manifest.json and manifest.extra.json');
  } else console.log('(--only run: manifest not rewritten)');
}
if (warnings.length) console.log(`${warnings.length} warning(s)`);
