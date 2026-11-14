// Standard MIDI file export, so a composed piece can be auditioned in any DAW or player.
// Timing is exact (per-phrase tempo, ritardando approximated in steps); it carries notes only, not the mix.

import type { InstrumentId, PhraseScore } from '../shared/types.ts';
import { beatToSec, phraseSeconds } from '../shared/types.ts';

const PROGRAM: Partial<Record<InstrumentId, number>> = {
  piano: 0, violins: 48, violins2: 48, violas: 48, celli: 48, basses: 48, solo_violin: 40, flute: 73, oboe: 68, clarinet: 71,
  horn: 60, harp: 46, timpani: 47, celesta: 8, glockenspiel: 9, vibraphone: 11, sub: 38, pad: 89, pluck: 84,
  keys: 4, lead: 81, supersaw: 90, synth_bass: 38, bell: 98, brass: 62,
};
const DRUM_NOTE: Partial<Record<InstrumentId, (midi: number) => number>> = {
  drumkit: (m) => m, kick808: () => 36, bass_drum: () => 35, cymbal: () => 49, tam_tam: () => 52,
};
const PPQ = 480;

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function track(events: { tick: number; bytes: number[]; order: number }[]): Buffer {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(Math.max(0, Math.round(e.tick - last))), ...e.bytes);
    last = Math.max(last, Math.round(e.tick));
  }
  body.push(0, 0xff, 0x2f, 0);
  const head = Buffer.alloc(8);
  head.write('MTrk', 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, Buffer.from(body)]);
}

export function scoresToMidi(scores: PhraseScore[]): Buffer {
  // Everything is laid out in real seconds, then written at a fixed 120 BPM so ticks map linearly to time.
  const ticksPerSec = PPQ * 2;
  const byInst = new Map<InstrumentId, { tick: number; bytes: number[]; order: number }[]>();
  const channels = new Map<InstrumentId, number>();
  let nextChannel = 0;
  let t0 = 0;
  for (const s of scores) {
    for (const n of s.notes) {
      if (n.inst === 'noise') continue;
      const drum = DRUM_NOTE[n.inst];
      if (!channels.has(n.inst)) {
        if (drum) channels.set(n.inst, 9);
        else {
          if (nextChannel === 9) nextChannel++;
          channels.set(n.inst, nextChannel % 16);
          nextChannel++;
        }
        byInst.set(n.inst, drum ? [] : [{ tick: 0, bytes: [0xc0 | channels.get(n.inst)!, PROGRAM[n.inst] ?? 0], order: 0 }]);
      }
      const ch = channels.get(n.inst)!;
      const midi = drum ? drum(n.midi) : n.midi;
      const on = (t0 + beatToSec(s, n.t)) * ticksPerSec;
      const short = n.art === 'staccato' || n.art === 'spiccato' || n.art === 'pizzicato' || n.art === 'hit';
      const off = (t0 + beatToSec(s, n.t + (short ? Math.min(n.dur, 0.4) : n.dur))) * ticksPerSec;
      const list = byInst.get(n.inst)!;
      list.push({ tick: on, bytes: [0x90 | ch, midi, Math.max(1, Math.min(127, Math.round(n.vel * 127)))], order: 2 });
      list.push({ tick: Math.max(on + 1, off - 1), bytes: [0x80 | ch, midi, 0], order: 1 });
    }
    t0 += phraseSeconds(s);
  }
  const tempo = track([{ tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20], order: 0 }]); // 500,000 µs per quarter = 120 BPM
  const tracks = [tempo, ...[...byInst.values()].map(track)];
  const head = Buffer.alloc(14);
  head.write('MThd', 0, 'ascii');
  head.writeUInt32BE(6, 4);
  head.writeUInt16BE(1, 8);
  head.writeUInt16BE(tracks.length, 10);
  head.writeUInt16BE(PPQ, 12);
  return Buffer.concat([head, ...tracks]);
}
