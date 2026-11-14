import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clashes, shareKept, similarity } from '../core/facts.ts';
import { lineLength, notation, type Line } from '../core/line.ts';
import { chordCandidates, chordName, chordPcs, degreeToMidi, fitOf, keyName, midiToDegree, type Key } from '../core/theory.ts';
import { applyOps, MELODIC_OPS, TEXTURE_OPS } from '../core/transform.ts';
import { rhythmFor, cellsFor } from '../calls/themes.ts';

const cSharpMinor: Key = { tonic: 1, mode: 'natural_minor' };
// The example theme from the design doc: 5(1.5) 6(.5) 5(1) 3(2) 2(1) 1(3)
const theme: Line = [
  { deg: 4, dur: 1.5 }, { deg: 5, dur: 0.5 }, { deg: 4, dur: 1 }, { deg: 2, dur: 2 }, { deg: 1, dur: 1 }, { deg: 0, dur: 3 },
];
const ctx = { grid: 0.5 };

test('notation matches the design doc format', () => {
  assert.equal(notation(theme), '5(1.5) 6(.5) 5(1) 3(2) 2(1) 1(3)');
  assert.equal(notation([{ deg: 7, dur: 1 }, { deg: -1, dur: 1 }, { deg: null, dur: 2 }]), "1'(1) 7,(1) r(2)");
});

test('degrees map to the right pitches', () => {
  assert.equal(keyName(cSharpMinor), 'C♯ minor');
  assert.equal(degreeToMidi(cSharpMinor, 0), 61); // C#4
  assert.equal(degreeToMidi(cSharpMinor, 2), 64); // E4
  assert.equal(degreeToMidi(cSharpMinor, 7), 73); // C#5
  assert.equal(degreeToMidi(cSharpMinor, -1), 59); // B3
  assert.deepEqual(midiToDegree(cSharpMinor, 64), { deg: 2, alt: 0 });
});

test('the library has the twenty transformations of the design doc', () => {
  // 13 melodic kinds (sequence, displacement, fragmentation and register transfer each come in two or four directions) + 7 texture kinds.
  const kinds = new Set(MELODIC_OPS.map((o) => o.id.replace(/_(up|down)_(step|third)$/, '').replace(/_(head|tail|half|beat|up|down)$/, '')));
  assert.equal(kinds.size + TEXTURE_OPS.length - 0, 13 + 7);
});

test('melodic transformations do what they say', () => {
  const degs = (l: Line) => l.filter((n) => n.deg !== null).map((n) => n.deg);
  assert.deepEqual(degs(applyOps(theme, ['seq_up_third'], ctx)), [6, 7, 6, 4, 3, 2]);
  assert.deepEqual(degs(applyOps(theme, ['inversion'], ctx)), [4, 3, 4, 6, 7, 8]);
  assert.deepEqual(degs(applyOps(theme, ['retrograde'], ctx)), [0, 1, 2, 4, 5, 4]);
  assert.equal(lineLength(applyOps(theme, ['augmentation'], ctx)), 18);
  assert.equal(lineLength(applyOps(theme, ['diminution'], ctx)), 4.5);
  assert.equal(degs(applyOps(theme, ['fragment_head'], ctx)).length, 3);
  assert.deepEqual(degs(applyOps(theme, ['fragment_tail'], ctx)), [2, 1, 0]);
  assert.deepEqual(degs(applyOps(theme, ['register_up'], ctx)), [11, 12, 11, 9, 8, 7]);
  assert.ok(lineLength(applyOps(theme, ['extension'], ctx)) > lineLength(theme) - 3);
  assert.equal(applyOps(theme, ['displace_beat'], ctx)[0].deg, null);
  // Expansion widens the leap (5→3 becomes 5→2); contraction narrows it.
  assert.deepEqual(degs(applyOps(theme, ['expand'], ctx)).slice(2, 4), [4, 1]);
  assert.deepEqual(degs(applyOps(theme, ['contract'], ctx)).slice(2, 4), [4, 3]);
  assert.ok(degs(applyOps(theme, ['ornament'], ctx)).length > 6);
  // No transformation mutates its input.
  assert.equal(notation(theme), '5(1.5) 6(.5) 5(1) 3(2) 2(1) 1(3)');
});

test('facts: an intact theme keeps everything, an inversion keeps rhythm but not intervals', () => {
  const same = shareKept(theme, theme);
  assert.equal(same.overall, 1);
  const inv = shareKept(theme, applyOps(theme, ['inversion'], ctx));
  assert.equal(inv.rhythm, 1);
  assert.ok(inv.intervals < 0.5);
  const aug = shareKept(theme, applyOps(theme, ['augmentation'], ctx));
  assert.equal(aug.intervals, 1);
  assert.equal(aug.rhythm, 1, 'augmentation keeps the rhythm in proportion');
  const unrelated: Line = [{ deg: 0, dur: 4 }, { deg: 0, dur: 4 }];
  assert.ok(shareKept(theme, unrelated).overall < 0.3);
});

test('facts: similarity flags copies', () => {
  assert.equal(similarity(theme, theme), 1);
  assert.ok(similarity(theme, applyOps(theme, ['seq_up_step'], ctx)) < 0.3);
  assert.ok(similarity(theme, theme, ['d1', 'd4'], ['d1', 'd5']) < 1);
});

test('chord options: every family is always offered and named', () => {
  const all = chordCandidates(cSharpMinor);
  for (const family of ['diatonic', 'diatonic_extended', 'suspended', 'borrowed', 'chromatic_mediant', 'late_romantic']) {
    assert.ok(all.some((c) => c.family === family), family);
  }
  assert.ok(all.length <= 255, 'fits the 255-option limit of a choice question');
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, 'option keys are unique');
  for (const c of all) assert.ok(!chordName(c, cSharpMinor).includes('('.concat('0')), `${c.id} has a readable name`);
  const names = all.map((c) => chordName(c, cSharpMinor));
  // The warm chords the reference style opens with: major sevenths and ninths on A and E, and G♯ minor.
  for (const want of ['Amaj7', 'Amaj9', 'Emaj7', 'Emaj9', 'G♯m', 'C♯m9']) assert.ok(names.includes(want), `${want} in ${names.join(' ')}`);
});

test('clash detection: a semitone above a chord tone', () => {
  const tonic = chordCandidates(cSharpMinor)[0];
  assert.deepEqual(chordPcs(tonic, cSharpMinor), [1, 4, 8]);
  assert.equal(fitOf(64, tonic, cSharpMinor), 'chord_tone'); // E
  assert.equal(fitOf(66, tonic, cSharpMinor), 'colour'); // F#
  assert.equal(fitOf(69, tonic, cSharpMinor), 'clash'); // A against G#
  const found = clashes([{ deg: 5, dur: 2 }], [{ t: 0, dur: 4, chord: tonic }], cSharpMinor);
  assert.equal(found.length, 1);
});

test('theme rhythm fills at most one two-bar unit in every meter', () => {
  for (const sub of [2, 3] as const) {
    for (const cell of cellsFor(sub)) {
      for (const unit of [4, 6, 7, 8, 10]) {
        for (let count = 4; count <= 8; count++) {
          const durs = rhythmFor(cell, count, unit);
          assert.equal(durs.length, count);
          assert.ok(durs.every((d) => d > 0), `${cell.id} ${count} in ${unit}`);
          assert.ok(durs.reduce((a, b) => a + b, 0) <= unit + 1e-6, `${cell.id} ${count} notes in ${unit} beats overflows`);
        }
      }
    }
  }
});
