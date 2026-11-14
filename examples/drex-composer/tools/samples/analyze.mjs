// Per-file analysis used by build.mjs: duration, peak, RMS and the trim point (start of the attack).
// Results are cached in .cache/analysis.json (keyed by path + size + mtime).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, ffmpeg, pool, dB } from './lib.mjs';

const RATE = 44100; // full band: cymbals / hi-hats peak well above 11 kHz
const CACHE = path.join(ROOT, '.cache', 'analysis.json');
const VERSION = 5;

/**
 * Trim rule ("start"): first sample whose level reaches the threshold, minus 2 ms of pre-roll.
 * threshold = clamp(filePeak - 50 dB, -75 dBFS, -55 dBFS)  -> never above -55 dBFS, so soft attacks survive;
 * relative to the peak so that very quiet files (pp layers, key noises) are not eaten.
 * If the recording's noise floor sits above that threshold nothing is found before the note, in which case
 * we fall back to "first time the level comes within 40 dB of the peak, minus 10 ms" - but only when that
 * removes more than 30 ms (i.e. there really is a noisy lead-in).
 */
export async function analyzeFile(file) {
  const r = await ffmpeg(['-i', file, '-vn', '-ac', '2', '-ar', String(RATE), '-f', 'f32le', '-'], { wantStdout: true });
  if (r.code !== 0) throw new Error(`cannot decode ${file}: ${r.stderr.slice(-300)}`);
  const b = r.stdout;
  const x = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
  const n = x.length >> 1;
  // remove DC per channel
  let m0 = 0;
  let m1 = 0;
  for (let i = 0; i < n; i++) {
    m0 += x[2 * i];
    m1 += x[2 * i + 1];
  }
  m0 /= Math.max(1, n);
  m1 /= Math.max(1, n);
  const env = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.max(Math.abs(x[2 * i] - m0), Math.abs(x[2 * i + 1] - m1));
    env[i] = v;
    if (v > peak) peak = v;
  }
  const peakDb = dB(peak);
  const thrDb = Math.min(-55, Math.max(-75, peakDb - 50));
  const first = (levelDb) => {
    const t = Math.pow(10, levelDb / 20);
    for (let i = 0; i < n; i++) if (env[i] >= t) return i / RATE;
    return 0;
  };
  const tAbs = first(thrDb);
  const t40 = first(peakDb - 40);
  const t20 = first(peakDb - 20);
  let start = Math.max(0, tAbs - 0.002);
  let rule = 'abs';
  if (t40 - 0.010 - start > 0.030 && tAbs < 0.001) {
    start = Math.max(0, t40 - 0.010);
    rule = 'rel40';
  }
  // RMS over the first 1.5 s after the trim point
  const i0 = Math.floor(start * RATE);
  const i1 = Math.min(n, i0 + Math.floor(1.5 * RATE));
  let sq = 0;
  for (let i = i0; i < i1; i++) sq += ((x[2 * i] - m0) ** 2 + (x[2 * i + 1] - m1) ** 2) / 2;
  const rmsDb = dB(Math.sqrt(sq / Math.max(1, i1 - i0)));
  // time of the loudest 100 ms (for swells / rolls: when the crescendo peaks)
  const hop = Math.floor(0.05 * RATE);
  let bestE = -1;
  let bestT = 0;
  for (let i = 0; i + 2 * hop <= n; i += hop) {
    let e = 0;
    for (let k = i; k < i + 2 * hop; k++) e += env[k] * env[k];
    if (e > bestE) {
      bestE = e;
      bestT = (i + hop) / RATE;
    }
  }
  // raw (un-DC-corrected) peak is what matters for clipping
  let rawPeak = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > rawPeak) rawPeak = Math.abs(x[i]);
  return {
    duration: n / RATE,
    peakDb: +dB(rawPeak).toFixed(2),
    rmsDb: +rmsDb.toFixed(2),
    start: +start.toFixed(5),
    rule,
    tAbs: +tAbs.toFixed(4),
    t40: +t40.toFixed(4),
    t20: +t20.toFixed(4),
    loudestAt: +bestT.toFixed(3),
    dc: +Math.max(Math.abs(m0), Math.abs(m1)).toFixed(5),
  };
}

export async function analyzeAll(files) {
  let cache = {};
  if (fs.existsSync(CACHE)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    } catch {
      cache = {};
    }
  }
  if (cache.__v !== VERSION) cache = { __v: VERSION };
  const out = {};
  let done = 0;
  await pool(files, Math.max(2, os.cpus().length - 2), async (f) => {
    const st = fs.statSync(f);
    const key = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const c = cache[f];
    if (c && c.key === key) {
      out[f] = c.a;
      return;
    }
    const a = await analyzeFile(f);
    cache[f] = { key, a };
    out[f] = a;
    if (++done % 300 === 0) console.log(`  analysed ${done}`);
  });
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return out;
}
