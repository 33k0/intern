// Verify assets/samples against manifest.json (and assets/ir against ir.json).
// Usage: node check.mjs [--verbose]
// Exit code 1 if a hard check fails (missing/undecodable/silent file, schema error, wrong octave).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SAMPLES, IR_DIR, ffmpeg, walk, pool, dB, midiToHz, hzToMidi, midiToName, estimateF0, goertzelHann, timpaniPrincipal } from './lib.mjs';

const VERBOSE = process.argv.includes('--verbose');
const errors = [];
const notes = [];
const err = (s) => errors.push(s);

const REQUIRED = ['piano', 'violins', 'violas', 'celli', 'basses', 'solo_violin', 'flute', 'oboe', 'clarinet', 'horn', 'harp', 'timpani', 'bass_drum', 'cymbal', 'drumkit'];
const OPTIONAL = ['celesta', 'glockenspiel', 'vibraphone', 'tam_tam'];
const ARTS = ['sustain', 'staccato', 'tremolo', 'pizzicato', 'spiccato', 'hit', 'roll'];
const FAMILIES = ['strings', 'keys', 'winds', 'brass', 'harp', 'percussion', 'drums'];
const UNPITCHED = { drumkit: [36, 38, 42, 44, 46, 45, 47, 50, 51, 49], bass_drum: [36], cymbal: [49], tam_tam: [52] };
// longest allowed duration (s) per instrument/articulation (cap + small tolerance)
const maxDur = (inst, art, midi) => {
  if (inst === 'piano') return (midi < 48 ? 14 : midi <= 72 ? 10 : 6) + 0.15;
  if (inst === 'tam_tam' || (inst === 'cymbal' && art === 'roll')) return 12.15;
  if (['sustain', 'tremolo', 'roll'].includes(art) || ['harp', 'vibraphone', 'timpani', 'cymbal'].includes(inst)) return 9.15;
  if (['drumkit', 'bass_drum', 'glockenspiel'].includes(inst)) return 9.15; // drum kit: tom_mid is stretched by resampling
  return 4.15;
};

const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));

// ------------------------------------------------------------------ 1. schema
if (manifest.version !== 1) err('version must be 1');
if (manifest.baseUrl !== '/assets/samples/') err('baseUrl must be /assets/samples/');
for (const id of REQUIRED) if (!manifest.instruments[id]) err(`required instrument missing: ${id}`);
for (const id of Object.keys(manifest.instruments)) if (![...REQUIRED, ...OPTIONAL].includes(id)) err(`unknown instrument id: ${id}`);

const refs = []; // {file, inst, art, midi, layer}
for (const [id, inst] of Object.entries(manifest.instruments)) {
  for (const k of ['label', 'family', 'source', 'licence', 'range', 'articulations']) if (inst[k] == null) err(`${id}: missing ${k}`);
  if (!FAMILIES.includes(inst.family)) err(`${id}: bad family ${inst.family}`);
  if (!Array.isArray(inst.range) || inst.range.length !== 2 || !inst.range.every(Number.isInteger) || inst.range[0] > inst.range[1]) err(`${id}: bad range`);
  if (!Object.keys(inst.articulations || {}).length) err(`${id}: no articulations`);
  for (const [aid, art] of Object.entries(inst.articulations || {})) {
    if (!ARTS.includes(aid)) err(`${id}: unknown articulation id ${aid}`);
    if (typeof art.gainDb !== 'number') err(`${id}.${aid}: gainDb must be a number`);
    if (typeof art.oneShot !== 'boolean') err(`${id}.${aid}: oneShot must be boolean`);
    if (!Array.isArray(art.layers) || !art.layers.length) {
      err(`${id}.${aid}: no layers`);
      continue;
    }
    let prev = 0;
    art.layers.forEach((l, li) => {
      if (!(l.velMax > prev)) err(`${id}.${aid}: layers not ascending by velMax`);
      prev = l.velMax;
      const keys = Object.keys(l.samples || {});
      if (!keys.length) err(`${id}.${aid} layer ${li}: no samples`);
      for (const k of keys) {
        if (!/^\d+$/.test(k) || +k > 127) err(`${id}.${aid}: bad sample key ${k}`);
        const arr = l.samples[k];
        if (!Array.isArray(arr) || !arr.length) err(`${id}.${aid}[${k}]: value must be a non-empty array`);
        else for (const f of arr) refs.push({ file: f, inst: id, art: aid, midi: +k, layer: li });
        if (UNPITCHED[id] && !UNPITCHED[id].includes(+k)) err(`${id}.${aid}: unexpected pseudo-note ${k}`);
      }
    });
    if (prev !== 1) err(`${id}.${aid}: last layer velMax must be 1.0`);
  }
}
for (const n of UNPITCHED.drumkit) {
  const l = manifest.instruments.drumkit?.articulations?.hit?.layers ?? [];
  if (!l.every((x) => x.samples[String(n)])) err(`drumkit: pseudo-note ${n} missing in a layer`);
}
const ex = manifest.extras || {};
for (const k of ['pianoPedalDown', 'pianoPedalUp', 'pianoRelease']) {
  if (!Array.isArray(ex[k]) || !ex[k].length) err(`extras.${k} missing`);
  else for (const f of ex[k]) refs.push({ file: f, inst: 'piano', art: 'extras', midi: null });
}
if (!ex.pianoHarmonics || !Object.keys(ex.pianoHarmonics).length) err('extras.pianoHarmonics missing');
else
  for (const [k, arr] of Object.entries(ex.pianoHarmonics)) {
    if (!Array.isArray(arr)) err(`extras.pianoHarmonics[${k}] must be an array`);
    else for (const f of arr) refs.push({ file: f, inst: 'piano', art: 'extras', midi: null });
  }

for (const [k, v] of Object.entries(ex)) {
  if (['pianoPedalDown', 'pianoPedalUp', 'pianoRelease', 'pianoHarmonics'].includes(k)) continue;
  if (!Array.isArray(v) || !v.every((f) => typeof f === 'string')) err(`extras.${k}: expected an array of paths`);
  else for (const f of v) refs.push({ file: f, inst: f.split('/')[0], art: 'extras', midi: null });
}

// ------------------------------------------------------------------ 2. files
const uniq = new Map();
for (const r of refs) if (!uniq.has(r.file)) uniq.set(r.file, r);
const onDisk = walk(SAMPLES).filter((f) => f.endsWith('.mp3')).map((f) => path.relative(SAMPLES, f).split(path.sep).join('/'));
const orphans = onDisk.filter((f) => !uniq.has(f));
if (orphans.length) err(`${orphans.length} mp3 file(s) on disk are not referenced by the manifest, e.g. ${orphans.slice(0, 3).join(', ')}`);

const PITCHED = (r) => r.midi != null && !UNPITCHED[r.inst];

/** Goertzel power at frequency f. */
function goertzel(x, rate, f) {
  const w = (2 * Math.PI * f) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}
/** Max partial power near k*f (scan +/-60 cents). */
function partial(x, rate, f) {
  if (f >= rate / 2.1) return 0;
  let best = 0;
  for (let c = -60; c <= 60; c += 15) best = Math.max(best, goertzel(x, rate, f * Math.pow(2, c / 1200)));
  return best;
}

async function inspect(r) {
  const file = path.join(SAMPLES, r.file);
  const out = { ...r };
  if (!fs.existsSync(file)) {
    out.missing = true;
    return out;
  }
  out.bytes = fs.statSync(file).size;
  // full decode (also proves the file decodes end to end)
  const d = await ffmpeg(['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '44100', '-'], { wantStdout: true });
  if (d.code !== 0 || /Error|Invalid/i.test(d.stderr)) {
    out.decodeError = d.stderr.trim().slice(0, 200) || `exit ${d.code}`;
    if (d.code !== 0) return out;
  }
  const info = await ffmpeg(['-i', file]);
  const st = /Audio: (\w+)[^,]*, (\d+) Hz, (\w+)/.exec(info.stderr);
  out.format = st ? `${st[1]}/${st[2]}/${st[3]}` : 'unknown';
  const x = new Float32Array(d.stdout.buffer, d.stdout.byteOffset, Math.floor(d.stdout.length / 4));
  const n = x.length >> 1;
  out.duration = n / 44100;
  let pk = 0;
  let sq = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    if (v > pk) pk = v;
    sq += v * v;
  }
  out.peakDb = dB(pk);
  out.rmsDb = dB(Math.sqrt(sq / Math.max(1, x.length)));
  // lead-in: time until the level first reaches max(-55 dBFS, peak-50 dB) (clamped at -75)
  const thr = Math.pow(10, Math.min(-55, Math.max(-75, out.peakDb - 50)) / 20);
  let lead = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(x[2 * i]) >= thr || Math.abs(x[2 * i + 1]) >= thr) {
      lead = i / 44100;
      break;
    }
  }
  out.leadMs = lead * 1000;
  // attack: time until the level is within 20 dB of the peak
  const t20 = pk * 0.1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(x[2 * i]) >= t20 || Math.abs(x[2 * i + 1]) >= t20) {
      out.attackMs = (i / 44100) * 1000;
      break;
    }
  }
  if (PITCHED(r)) {
    const f = midiToHz(r.midi);
    const early = r.inst === 'piano' && r.midi > 96; // top piano notes die away within ~0.2 s
    const dec = f < 150 ? 4 : f < 900 ? 2 : 1;
    const rate = 44100 / dec;
    const mono = new Float32Array(Math.floor(n / dec));
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (let k = 0; k < dec; k++) s += x[2 * (i * dec + k)] + x[2 * (i * dec + k) + 1];
      mono[i] = s / (2 * dec);
    }
    const winLen = Math.min(mono.length, Math.floor(rate * (early ? 0.15 : Math.max(0.3, 8 / (f / 2.6)))));
    // analysis window: after the attack; very high notes (short decay) are measured right at the start
    let t0 = Math.floor(rate * (early ? 0.005 : out.duration > 1.2 ? 0.25 : out.duration > 0.5 ? 0.06 : 0.02));
    if (t0 + winLen > mono.length) t0 = Math.max(0, mono.length - winLen);
    const w = mono.subarray(t0, t0 + winLen);
    const e = estimateF0(w, rate, f / 2.6, Math.min(f * 2.6, rate / 2.2));
    out.f0 = e.hz;
    out.clarity = e.clarity;
    out.estMidi = e.hz > 0 ? hzToMidi(e.hz) : null;
    // harmonic-comb evidence for the labelled octave
    const P = (k) => partial(w, rate, f * k);
    const own = P(1) + P(2) + P(3) + P(4);
    const sub = P(0.5) + P(1.5) + P(2.5); // only present if the real pitch is an octave LOWER
    const odd = P(1) + P(3); // absent if the real pitch is an octave HIGHER
    const even = P(2) + P(4);
    // spectral peak next to the labelled pitch: the fundamental if it is reasonably strong,
    // otherwise the strongest of partials 2..4 (each scanned +/-1.2 st)
    const scan = (k) => {
      let bp = 0;
      let bd = null;
      if (f * k * 1.08 >= rate / 2) return { p: 0, d: null };
      for (let d = -1.2; d <= 1.2001; d += 0.04) {
        const p = goertzelHann(w, rate, f * k * Math.pow(2, d / 12));
        if (p > bp) {
          bp = p;
          bd = d;
        }
      }
      return { p: bp, d: bd };
    };
    const parts = [1, 2, 3, 4].map(scan);
    const strongest = parts.reduce((a, b) => (b.p > a.p ? b : a));
    const bestDev = parts[0].p >= strongest.p * 0.003 ? parts[0].d : strongest.d; // fundamental within 25 dB
    out.nearDev = bestDev;
    if (r.inst === 'timpani') {
      // kettledrum modes are 1 : 1.5 : 2 -> dedicated estimator on a longer window
      const dec2 = 8;
      const m2 = new Float32Array(Math.floor(n / dec2));
      for (let i = 0; i < m2.length; i++) {
        let s = 0;
        for (let k = 0; k < dec2; k++) s += x[2 * (i * dec2 + k)] + x[2 * (i * dec2 + k) + 1];
        m2[i] = s / (2 * dec2);
      }
      const r2 = 44100 / dec2;
      const a0 = Math.floor(0.2 * r2);
      const len = Math.floor((r.art === 'roll' ? 3.0 : 0.8) * r2);
      out.timpDev = timpaniPrincipal(m2.subarray(a0, Math.min(m2.length, a0 + len)), r2, r.midi, 1.5) - r.midi;
    }
    out.subRatioDb = 10 * Math.log10((sub + 1e-12) / (own + 1e-12));
    out.oddRatioDb = 10 * Math.log10((odd + 1e-12) / (even + 1e-12));
  }
  return out;
}

console.log(`checking ${uniq.size} files referenced by manifest.json ...`);
const res = await pool([...uniq.values()], Math.max(2, os.cpus().length - 2), inspect);

const byInst = new Map();
const sem = (x) => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(2));
let silent = 0;
let clipped = 0;
for (const r of res) {
  if (r.missing) {
    err(`missing file: ${r.file}`);
    continue;
  }
  if (r.decodeError) err(`decode problem: ${r.file}: ${r.decodeError}`);
  if (r.duration == null) continue;
  if (r.format !== 'mp3/44100/stereo') err(`${r.file}: unexpected format ${r.format}`);
  if (!(r.peakDb > -60)) {
    silent++;
    err(`silent file (peak ${r.peakDb.toFixed(1)} dBFS): ${r.file}`);
  }
  if (r.peakDb > -0.01) clipped++;
  if (r.duration < 0.04) err(`${r.file}: too short (${r.duration.toFixed(3)} s)`);
  if (r.art !== 'extras' && r.duration > maxDur(r.inst, r.art, r.midi)) err(`${r.file}: longer than its cap (${r.duration.toFixed(2)} s)`);
  const key = r.art === 'extras' ? 'piano (extras)' : r.inst;
  if (!byInst.has(key)) byInst.set(key, []);
  byInst.get(key).push(r);
}

// ------------------------------------------------------------------ 3. report
const med = (a) => {
  const s = a.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
console.log('\nPer instrument:');
console.log('instrument            files     MB   dur med/max (s)   peak max  lead>10ms  articulations (files, keys, layers)');
let totalBytes = 0;
let totalFiles = 0;
for (const [id, rs] of byInst) {
  const bytes = rs.reduce((a, r) => a + r.bytes, 0);
  totalBytes += bytes;
  totalFiles += rs.length;
  const inst = manifest.instruments[id];
  let arts = '';
  if (inst) {
    arts = Object.entries(inst.articulations)
      .map(([aid, a]) => {
        const files = new Set(a.layers.flatMap((l) => Object.values(l.samples).flat()));
        const keys = new Set(a.layers.flatMap((l) => Object.keys(l.samples)));
        return `${aid} ${files.size}f/${keys.size}k/${a.layers.length}L ${a.gainDb >= 0 ? '+' : ''}${a.gainDb}dB`;
      })
      .join('; ');
  }
  const late = rs.filter((r) => r.leadMs > 10).length;
  console.log(
    `${id.padEnd(20)} ${String(rs.length).padStart(5)} ${(bytes / 1e6).toFixed(1).padStart(6)}   ${med(rs.map((r) => r.duration)).toFixed(2).padStart(5)} / ${Math.max(...rs.map((r) => r.duration)).toFixed(2).padStart(5)}   ${Math.max(...rs.map((r) => r.peakDb)).toFixed(1).padStart(6)}   ${String(late).padStart(6)}    ${arts}`,
  );
  if (late && VERBOSE) for (const r of rs.filter((x) => x.leadMs > 10)) console.log(`      lead ${r.leadMs.toFixed(0)} ms  ${r.file}`);
}
console.log(`TOTAL ${totalFiles} files, ${(totalBytes / 1e6).toFixed(1)} MB (limit ~450 MB)`);
if (totalBytes > 450e6) err('assets/samples is larger than 450 MB');
if (clipped) notes.push(`${clipped} file(s) reach 0 dBFS after mp3 decoding (inter-sample overshoot)`);

// ------------------------------------------------------------------ 3b. attack timing
console.log('\nAttack timing per articulation (ms until the level is within 20 dB of the file peak; lead = ms before anything audible):');
{
  const g = new Map();
  for (const r of res) {
    if (r.duration == null || r.art === 'extras') continue;
    const k = `${r.inst}.${r.art}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const rows = [];
  for (const [k, rs] of g) {
    const at = rs.map((r) => r.attackMs ?? 0);
    const ld = rs.map((r) => r.leadMs);
    rows.push(`${k} ${med(at).toFixed(0)}/${Math.max(...at).toFixed(0)} (lead max ${Math.max(...ld).toFixed(0)})`);
    const oneShot = manifest.instruments[rs[0].inst].articulations[rs[0].art].oneShot;
    const slow = rs.filter((r) => (r.attackMs ?? 0) > 120);
    if (oneShot && slow.length && !(rs[0].inst === 'cymbal' && rs[0].art === 'roll')) notes.push(`${k}: ${slow.length} one-shot sample(s) take >120 ms to come within 20 dB of their peak, e.g. ${slow[0].file} (${slow[0].attackMs.toFixed(0)} ms)`);
  }
  for (let i = 0; i < rows.length; i += 3) console.log('  ' + rows.slice(i, i + 3).map((x) => x.padEnd(48)).join(''));
  console.log('  (format: median/max attack)');
}

// ------------------------------------------------------------------ 4. pitch
console.log('\nPitch check (estimated fundamental vs manifest key; autocorrelation + harmonic comb):');
console.log('instrument.articulation      n   within1st  harmonic-lock  unconfirmed  median dev (st)   spot check (middle key)');
// Tuning facts of the source material that are not labelling errors:
const KNOWN_TUNING = {
  'piano:108': { st: 0.9, why: 'Salamander piano is stretch-tuned as recorded (measured A0 -25 c, C4 -2 c, C7 +19 c, A7 +39 c, C8 +90 c)' },
};
const knownHits = new Set();
const groups = new Map();
for (const r of res) {
  if (r.f0 == null || !PITCHED(r)) continue;
  const k = `${r.inst}.${r.art}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
for (const [k, rs] of groups) {
  let ok = 0;
  let amb = 0;
  let off = 0;
  const devs = [];
  const bad = [];
  for (const r of rs) {
    const dev = r.estMidi == null ? null : r.estMidi - r.midi;
    r.dev = dev;
    if (r.inst === 'timpani') {
      // judged by the mode-comb estimator only (autocorrelation locks an octave low on 1 : 1.5 : 2 modes)
      if (Math.abs(r.timpDev) <= 0.35) {
        ok++;
        devs.push(r.timpDev);
      } else {
        off++;
        bad.push(r);
      }
      continue;
    }
    // The comb test says whether the LABELLED octave is right:
    //   subRatio high     -> strong partials at 0.5f / 1.5f / 2.5f -> real pitch may be an octave lower
    //   oddRatio very low -> nothing at f and 3f                   -> real pitch may be an octave higher
    const combLower = r.subRatioDb > -6;
    const combHigher = r.oddRatioDb < -40;
    const nearOk = r.nearDev != null && Math.abs(r.nearDev) <= 0.6;
    const known = KNOWN_TUNING[`${r.inst}:${r.midi}`];
    if (known && r.nearDev != null && Math.abs(r.nearDev - known.st) <= 0.15) {
      ok++;
      knownHits.add(`${r.inst} key ${r.midi}: ${known.why}`);
      continue;
    }
    if (dev != null && Math.abs(dev) <= 1) {
      ok++;
      devs.push(dev);
    } else if (nearOk && !combLower && !combHigher) {
      amb++; // autocorrelation locked onto a harmonic / sub-harmonic (or is too coarse up high); spectrum agrees with the label
    } else {
      off++;
      bad.push(r);
    }
  }
  const mid = rs.slice().sort((a, b) => a.midi - b.midi)[Math.floor(rs.length / 2)];
  const candTimp = mid.timpDev != null ? `principal ${midiToHz(mid.midi + mid.timpDev).toFixed(1)} Hz (${sem(mid.timpDev)} st); autocorrelation ` : '';
  const cand0 = mid.f0 > 0 ? `${mid.f0.toFixed(1)} Hz = ${midiToName(Math.round(mid.estMidi))} (${sem(mid.estMidi - mid.midi)} st; octave candidates ${(mid.f0 / 2).toFixed(1)} / ${(mid.f0 * 2).toFixed(1)} Hz)` : 'no clear f0';
  console.log(
    `${k.padEnd(26)} ${String(rs.length).padStart(3)}   ${String(ok).padStart(6)}   ${String(amb).padStart(9)}   ${String(off).padStart(4)}   ${sem(med(devs)).padStart(8)}          key ${mid.midi} (${midiToName(mid.midi)}, ${midiToHz(mid.midi).toFixed(1)} Hz): est ${candTimp}${cand0}`,
  );
  for (const r of bad) {
    const msg = `${r.file}: key ${r.midi} (${midiToName(r.midi)}), autocorr ${r.f0 ? r.f0.toFixed(1) + ' Hz (' + sem(r.dev) + ' st)' : 'n/a'}, clarity ${r.clarity?.toFixed(2)}, spectral peak near label ${sem(r.nearDev)} st, sub-partials ${r.subRatioDb.toFixed(1)} dB, odd/even ${r.oddRatioDb.toFixed(1)} dB${r.timpDev != null ? ', timpani principal ' + sem(r.timpDev) + ' st' : ''}`;
    if (VERBOSE) console.log('      ? ' + msg);
  }
  // hard failure only if the group as a whole looks transposed
  if (ok < rs.length * 0.5 && rs.length >= 3) err(`${k}: fewer than half of the samples match their manifest key - check octave convention`);
  else if (off) notes.push(`${k}: ${off} of ${rs.length} sample(s) could not be pitch-confirmed (run with --verbose)`);
  const m = med(devs);
  if (Number.isFinite(m) && Math.abs(m) > 0.5) notes.push(`${k}: median tuning deviation ${sem(m)} semitones`);
}

for (const k of knownHits) notes.push(k);

// ------------------------------------------------------------------ 5. impulse responses
console.log('\nImpulse responses:');
const irFile = path.join(IR_DIR, 'ir.json');
if (!fs.existsSync(irFile)) err('assets/ir/ir.json missing');
else {
  const irs = JSON.parse(fs.readFileSync(irFile, 'utf8'));
  if (!Array.isArray(irs) || irs.length < 2) err('ir.json must list two impulse responses');
  for (const ir of irs) {
    for (const k of ['id', 'name', 'file', 'licence', 'attribution', 'sourceUrl', 'rt60Approx']) if (ir[k] == null) err(`ir ${ir.id}: missing ${k}`);
    const f = path.join(IR_DIR, ir.file);
    if (!fs.existsSync(f)) {
      err(`ir file missing: ${ir.file}`);
      continue;
    }
    const d = await ffmpeg(['-v', 'error', '-i', f, '-f', 'f32le', '-'], { wantStdout: true });
    const info = await ffmpeg(['-i', f]);
    const st = /Audio: (\w+)[^,]*, (\d+) Hz, (\w+)/.exec(info.stderr);
    const x = new Float32Array(d.stdout.buffer, d.stdout.byteOffset, Math.floor(d.stdout.length / 4));
    let pk = 0;
    for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
    if (d.code !== 0) err(`ir ${ir.file} does not decode`);
    if (!st || st[3] !== 'stereo' || !['44100', '48000'].includes(st[2])) err(`ir ${ir.file}: must be stereo 44.1/48 kHz (got ${st?.slice(1).join('/')})`);
    if (!(pk > 0.01)) err(`ir ${ir.file} is silent`);
    console.log(`  ${ir.id.padEnd(12)} ${ir.file}  ${st?.slice(1).join('/')}  ${(x.length / 2 / +st[2]).toFixed(2)} s  peak ${dB(pk).toFixed(1)} dBFS  rt60~${ir.rt60Approx} s  ${ir.licence}`);
  }
}

// ------------------------------------------------------------------ result
if (notes.length) {
  console.log('\nNotes:');
  for (const n of notes) console.log('  - ' + n);
}
if (errors.length) {
  console.log(`\nFAILED: ${errors.length} problem(s)`);
  for (const e of errors.slice(0, 60)) console.log('  x ' + e);
  process.exit(1);
}
console.log(`\nOK: ${uniq.size} files exist, decode, are non-silent and within duration caps; schema valid.`);
