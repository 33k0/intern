// Shared helpers for the sample tooling. No third-party deps except ffmpeg-static.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import ffmpegPath from 'ffmpeg-static';

export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TOOLS_DIR, '..', '..');
export const RAW = path.join(ROOT, '.cache', 'raw');
export const ASSETS = path.join(ROOT, 'assets');
export const SAMPLES = path.join(ASSETS, 'samples');
export const IR_DIR = path.join(ASSETS, 'ir');
export const FFMPEG = ffmpegPath;

export const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];

/** "C4" -> 60, "D#3"/"Ds3"/"Eb3" -> 51. Scientific pitch (C4 = 60). */
export function noteToMidi(name) {
  const m = /^([A-Ga-g])([#sb]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  let n = NOTE_INDEX[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === 's') n += 1;
  if (m[2] === 'b') n -= 1;
  return n + (parseInt(m[3], 10) + 1) * 12;
}

/** 61 -> "Cs4" (file-name safe: 's' instead of '#'). */
export function midiToName(midi) {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
export function hzToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

/** Recursively list files (absolute paths). */
export function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** Run ffmpeg, resolve {code, stderr, stdout(Buffer)}. */
export function ffmpeg(args, { wantStdout = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const err = [];
    const out = [];
    p.stderr.on('data', (d) => err.push(d));
    if (wantStdout) p.stdout.on('data', (d) => out.push(d));
    p.on('close', (code) =>
      resolve({ code, stderr: Buffer.concat(err).toString('utf8'), stdout: Buffer.concat(out) }),
    );
  });
}

/** Decode a file to mono Float32 PCM at `rate` Hz. */
export async function decodeMono(file, rate = 22050, { start = 0, dur = null } = {}) {
  const args = [];
  if (start) args.push('-ss', String(start));
  args.push('-i', file);
  if (dur) args.push('-t', String(dur));
  args.push('-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-');
  const r = await ffmpeg(args, { wantStdout: true });
  if (r.code !== 0) throw new Error(`decode failed: ${file}\n${r.stderr.slice(-400)}`);
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}

/** Decode to interleaved Float32 with native channel count; returns {data, channels, rate}. */
export async function decodeRaw(file, rate, channels) {
  const r = await ffmpeg(['-i', file, '-vn', '-ac', String(channels), '-ar', String(rate), '-f', 'f32le', '-'], {
    wantStdout: true,
  });
  if (r.code !== 0) throw new Error(`decode failed: ${file}\n${r.stderr.slice(-400)}`);
  const b = r.stdout;
  return { data: new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)), channels, rate };
}

/** Parse "Duration: hh:mm:ss.xx" and stream info out of ffmpeg -i stderr. */
export async function probe(file) {
  const r = await ffmpeg(['-i', file]);
  const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr);
  const s = /Audio: (\S+).*?, (\d+) Hz, ([^,\n]+)/.exec(r.stderr);
  return {
    duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : null,
    codec: s ? s[1] : null,
    rate: s ? +s[2] : null,
    layout: s ? s[3].trim() : null,
  };
}

/**
 * Fundamental estimate by normalised autocorrelation (McLeod-style NSDF) on a window.
 * Returns {hz, clarity}. Search range [fmin, fmax].
 */
export function estimateF0(x, rate, fmin = 25, fmax = 4500) {
  const n = x.length;
  const minLag = Math.max(2, Math.floor(rate / fmax));
  const maxLag = Math.min(n - 2, Math.ceil(rate / fmin));
  const nsdf = new Float64Array(maxLag + 2);
  for (let tau = minLag - 1; tau <= maxLag + 1; tau++) {
    let acf = 0;
    let m = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) {
      const a = x[i];
      const b = x[i + tau];
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }
  // global max, then take the first peak that reaches 90 % of it (avoids sub-octave errors)
  let gmax = -1;
  for (let t = minLag; t <= maxLag; t++) if (nsdf[t] > gmax) gmax = nsdf[t];
  const thr = 0.9 * gmax;
  let best = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (nsdf[t] >= thr && nsdf[t] >= nsdf[t - 1] && nsdf[t] >= nsdf[t + 1]) {
      best = t;
      break;
    }
  }
  if (best < 0) return { hz: 0, clarity: 0 };
  const a = nsdf[best - 1];
  const b = nsdf[best];
  const c = nsdf[best + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
  return { hz: rate / (best + shift), clarity: b };
}

/** Peak and RMS (linear) of a Float32Array. */
export function levels(x) {
  let pk = 0;
  let sq = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    if (v > pk) pk = v;
    sq += x[i] * x[i];
  }
  return { peak: pk, rms: Math.sqrt(sq / Math.max(1, x.length)) };
}

export const dB = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Simple promise pool. */
export async function pool(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const k = i++;
      if (k >= items.length) return;
      res[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return res;
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

/** Windowed Goertzel power of x at frequency f (Hann window). */
export function goertzelHann(x, rate, f) {
  const w = (2 * Math.PI * f) / rate;
  const c = 2 * Math.cos(w);
  const n = x.length;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)) + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/**
 * Timpani "principal" pitch. A kettledrum has no harmonic series: the strong modes sit at about
 * 1 : 1.5 : 2 times the principal (the note that is heard), so autocorrelation reports an octave too low.
 * This scans +/-`span` semitones around `approxMidi` for the frequency whose 1 / ~1.5 / ~2 mode set
 * carries the most energy, then refines on the principal alone. `x` is mono PCM at `rate`.
 * Returns the principal as a fractional MIDI note.
 */
export function timpaniPrincipal(x, rate, approxMidi, span = 2.2) {
  let best = -1;
  let bm = approxMidi;
  for (let m = approxMidi - span; m <= approxMidi + span; m += 0.02) {
    const f0 = midiToHz(m);
    let p15 = 0;
    for (const r of [1.45, 1.47, 1.49, 1.51, 1.53, 1.55]) p15 = Math.max(p15, goertzelHann(x, rate, f0 * r));
    let p2 = 0;
    for (const r of [1.94, 1.97, 2.0, 2.03]) p2 = Math.max(p2, goertzelHann(x, rate, f0 * r));
    const s = Math.sqrt(goertzelHann(x, rate, f0)) + Math.sqrt(p15) + 0.5 * Math.sqrt(p2);
    if (s > best) {
      best = s;
      bm = m;
    }
  }
  let b2 = -1;
  let bm2 = bm;
  for (let m = bm - 0.25; m <= bm + 0.25; m += 0.01) {
    const p = goertzelHann(x, rate, midiToHz(m));
    if (p > b2) {
      b2 = p;
      bm2 = m;
    }
  }
  return bm2;
}

/** Index of the first sample reaching 10 % of the peak (coarse onset for analysis windows). */
export function coarseOnset(x) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  let on = 0;
  while (on < x.length && Math.abs(x[on]) < 0.1 * pk) on++;
  return on;
}
