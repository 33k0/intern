// Build stereo impulse responses for the convolution reverb from OpenAIR B-format recordings.
// Output: assets/ir/*.wav (48 kHz, 24-bit, stereo) + assets/ir/ir.json
//
// B-format (FuMa W,X,Y,Z from a Soundfield mic) -> stereo by a pair of virtual cardioids aimed
// +/-55 degrees off the front axis:   L/R = 0.5*sqrt(2)*W + 0.5*(cos55*X +/- sin55*Y)
// Leading silence before the direct sound is removed (1 ms kept), one fixed gain puts the peak at
// -1 dBFS (same gain on both channels), the last 60 ms are faded out.
import fs from 'node:fs';
import path from 'node:path';
import { RAW, IR_DIR, ensureDir, ffmpeg, decodeRaw, dB } from './lib.mjs';

const SRC = [
  {
    id: 'jack_lyons',
    name: 'Jack Lyons Concert Hall (University of York)',
    in: 'openair/jack-lyons/extracted/jack-lyons-concert-hall-university-york/b-format/rir_jack_lyons_lp2_96k.wav',
    out: 'jack_lyons_lp2_stereo.wav',
    licence: 'CC BY 4.0',
    attribution:
      'Jack Lyons Concert Hall impulse response (listening position 2) by Alex Duffell, Aishwarya Sridhar and Zhong Li, ' +
      'Audiolab, University of York - www.openairlib.net (OpenAIR). Licensed under CC BY 4.0. ' +
      'Modified: B-format decoded to stereo, trimmed, resampled to 48 kHz, gain adjusted.',
    sourceUrl: 'https://www.openair.hosted.york.ac.uk/?page_id=571',
    position: 'lp2: source centre of orchestra, receiver central seating block (seat D22), 10 m',
    publishedT30: { '500': 1.89, '1000': 1.86 },
  },
  {
    id: 'rymer',
    name: 'Arthur Sykes Rymer Auditorium (University of York)',
    in: 'openair/rymer/extracted/arthur-sykes-rymer-auditorium-university-york/b-format/s1r2.wav',
    out: 'rymer_s1r2_stereo.wav',
    licence: 'CC BY 4.0',
    attribution:
      'Arthur Sykes Rymer Auditorium impulse response (s1r2) - www.openairlib.net (OpenAIR), University of York; ' +
      'measured by Pierce Hening, Georgios Stamou and David Rivas Mendez. Licensed under CC BY 4.0. ' +
      'Modified: B-format decoded to stereo, trimmed, resampled to 48 kHz, gain adjusted.',
    sourceUrl: 'https://www.openair.hosted.york.ac.uk/?page_id=425',
    position: 's1r2: source centre of stage, receiver centre seat of middle row, 7.6 m',
    publishedT30: { '500': 0.39, '1000': 0.38 },
  },
];

const IN_RATE = 96000;
const OUT_RATE = 48000;
const ANG = (55 * Math.PI) / 180;
const kW = 0.5 * Math.SQRT2;
const kX = 0.5 * Math.cos(ANG);
const kY = 0.5 * Math.sin(ANG);

/** Schroeder backward integration; returns T20- and T30-based RT60 (s), broadband. */
function rt60(mono, rate) {
  const n = mono.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += mono[i] * mono[i];
    edc[i] = acc;
  }
  const db = (i) => 10 * Math.log10(edc[i] / edc[0]);
  const fit = (lo, hi) => {
    let i0 = 0;
    while (i0 < n && db(i0) > lo) i0++;
    let i1 = i0;
    while (i1 < n && db(i1) > hi) i1++;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
    for (let i = i0; i < i1; i += 8) {
      const x = i / rate;
      const y = db(i);
      sx += x; sy += y; sxx += x * x; sxy += x * y; k++;
    }
    const slope = (k * sxy - sx * sy) / (k * sxx - sx * sx);
    return -60 / slope;
  };
  return { t20: fit(-5, -25), t30: fit(-5, -35) };
}

ensureDir(IR_DIR);
const index = [];
for (const s of SRC) {
  const inFile = path.join(RAW, s.in);
  const { data } = await decodeRaw(inFile, IN_RATE, 4);
  const frames = data.length / 4;
  // direct-sound onset on W: first sample above 10 % of the W peak
  let pk = 0;
  for (let i = 0; i < frames; i++) pk = Math.max(pk, Math.abs(data[i * 4]));
  let onset = 0;
  while (onset < frames && Math.abs(data[onset * 4]) < 0.1 * pk) onset++;
  const start = Math.max(0, onset - Math.round(0.001 * IN_RATE));
  // sanity: is the mic's X axis facing the source? (W.X > 0 over the first 3 ms of direct sound)
  let wx = 0, wy = 0;
  for (let i = onset; i < Math.min(frames, onset + 288); i++) {
    wx += data[i * 4] * data[i * 4 + 1];
    wy += data[i * 4] * data[i * 4 + 2];
  }
  const pan = `pan=stereo|c0=${kW.toFixed(5)}*c0+${kX.toFixed(5)}*c1+${kY.toFixed(5)}*c2|c1=${kW.toFixed(5)}*c0+${kX.toFixed(5)}*c1-${kY.toFixed(5)}*c2`;
  const chain = (gain, dur) =>
    `atrim=start_sample=${start},asetpts=N/SR/TB,${pan},aresample=${OUT_RATE}:filter_size=64:precision=28` +
    (gain != null ? `,volume=${gain.toFixed(6)},afade=t=out:st=${(dur - 0.06).toFixed(4)}:d=0.06` : '');
  // pass 1: measure
  const p1 = await ffmpeg(['-i', inFile, '-af', chain(null), '-f', 'f32le', '-'], { wantStdout: true });
  if (p1.code !== 0) throw new Error(p1.stderr);
  const st = new Float32Array(p1.stdout.buffer, p1.stdout.byteOffset, Math.floor(p1.stdout.length / 4));
  let peak = 0;
  for (let i = 0; i < st.length; i++) peak = Math.max(peak, Math.abs(st[i]));
  const gain = Math.pow(10, -1 / 20) / peak;
  const dur = st.length / 2 / OUT_RATE;
  const mono = new Float32Array(st.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (st[2 * i] + st[2 * i + 1]);
  const rt = rt60(mono, OUT_RATE);
  // pass 2: write
  const outFile = path.join(IR_DIR, s.out);
  const p2 = await ffmpeg(['-y', '-i', inFile, '-af', chain(gain, dur), '-c:a', 'pcm_s24le', '-map_metadata', '-1', outFile]);
  if (p2.code !== 0) throw new Error(p2.stderr);
  const rtPublished = (s.publishedT30['500'] + s.publishedT30['1000']) / 2;
  console.log(
    `${s.id}: onset ${(onset / IN_RATE * 1000).toFixed(1)} ms trimmed to 1 ms, W.X ${wx >= 0 ? '+' : '-'} W.Y ${wy >= 0 ? '+' : '-'}, ` +
      `gain ${dB(gain).toFixed(2)} dB, ${dur.toFixed(2)} s, measured broadband T20 ${rt.t20.toFixed(2)} s / T30 ${rt.t30.toFixed(2)} s, ` +
      `OpenAIR table T30 mid-band ${rtPublished.toFixed(2)} s -> ${path.relative(IR_DIR, outFile)} (${(fs.statSync(outFile).size / 1e6).toFixed(2)} MB)`,
  );
  index.push({
    id: s.id,
    name: s.name,
    file: s.out,
    licence: s.licence,
    attribution: s.attribution,
    sourceUrl: s.sourceUrl,
    rt60Approx: Math.round(rtPublished * 10) / 10,
    // extra, informational
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    downloadUrl: `https://webfiles.york.ac.uk/OPENAIR/IRs/${s.in.split('/')[3]}/${s.in.split('/')[3]}.zip`,
    position: s.position,
    format: `wav, ${OUT_RATE} Hz, 24-bit, stereo, ${dur.toFixed(2)} s`,
    processing: `B-format (W,X,Y of 4 ch, 96 kHz) decoded to stereo with virtual cardioids at +/-55 deg; ${(start / IN_RATE * 1000).toFixed(1)} ms leading silence removed; resampled to ${OUT_RATE} Hz; fixed gain ${dB(gain).toFixed(2)} dB (peak -1 dBFS); 60 ms fade-out`,
    rt60MeasuredBroadband: { t20: +rt.t20.toFixed(2), t30: +rt.t30.toFixed(2) },
    rt60PublishedT30: s.publishedT30,
  });
}
fs.writeFileSync(path.join(IR_DIR, 'ir.json'), JSON.stringify(index, null, 2) + '\n');
console.log('wrote', path.join(IR_DIR, 'ir.json'));
