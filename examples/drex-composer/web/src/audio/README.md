# Audio engine (`web/src/audio`)

Plays `PhraseScore` objects (see `shared/types.ts`) in the browser. Entry point: `engine.ts` → `AudioEngine`.

```ts
const engine = await AudioEngine.create({ irId?, seed? }); // fetches manifest, side-car, IR; builds the graph; silent
await engine.unlock();                                     // from a user gesture
await engine.loadInstruments(palette, onProgress);         // only what the palette needs
engine.setSoundWorld('large_hall');
engine.on((e) => …);                                       // phrase_started | hold_started | hold_ended | ended
engine.enqueue(score); engine.start();                     // free-running
engine.applyHold(update);                                  // while holding
engine.playSynced(scores, clock);                          // video-locked (each score has startSec)
engine.scheduleAt(clockSec, notes, bpm);                   // video-locked: extra accent notes
engine.nudge({ gainDb, lowpassSteps, reverbSteps }, overSec);
engine.stop();
```

Also: `bufferedAhead()`, `playhead()`, `levels()`, `masterLevel()`, `dispose()`.

## Files

| File | What | Web Audio? |
| --- | --- | --- |
| `engine.ts` | `AudioEngine`: look-ahead scheduler, holds, video-locked mode, events | yes (Tone) |
| `graph.ts` | buses, effects, master chain, meters | yes (Tone) |
| `sampler.ts` | sample loading, level matching, voices, grains, piano extras, cymbal swells | yes (raw nodes) |
| `synths.ts` | sub, pad, pluck, kick808, noise texture | yes (Tone) |
| `ticker.ts` | worker-driven 25 ms timer | browser |
| `plan.ts` | score → timed plan: ritardando, humanise, pedal deferral, legato, kicks, swells | pure |
| `selection.ts` | articulation fallbacks, key/rate, layer crossfade, round robin, envelopes, level maths, stealing | pure |
| `timeline.ts` | phrase chaining, hold beat grid, `secToBeat` | pure |
| `mixmap.ts` | `MixState` + sound world → parameters | pure |
| `manifest.ts`, `prng.ts` | manifest types/helpers, deterministic PRNG | pure |
| `demoScore.ts` | two hand-written phrases (12/8, 70 BPM) + a hold update | pure |
| `smoke.html` / `smoke.ts` | dev-only harness (`/src/audio/smoke.html`, add `?silent=1` to render to no output device) | browser |
| `__tests__/schedule.test.ts` | `npx tsx --test web/src/audio/__tests__/schedule.test.ts` | node |

The pure modules import neither Tone nor any Web Audio type, so they run under node.

## Signal path

```
voice ─▶ [pan per instrument] ─▶ bus[layer] ─▶ duck (sidechain) ─┐   (bus input is metered → levels())
noise bed (level = mix.noise) ─▶ duck ───────────────────────────┤
                                                                  ▼
  ×0.5 ─▶ low-pass (24 dB/oct) ─▶ tanh saturation ─▶ Tone.Chorus (wet on/off) ─▶ Tone.StereoWidener ─▶ cut
cut ─┬─▶ dry ───────────────────────────────────────────────────────────────┐
     ├─▶ reverb send ─▶ pre-delay ─▶ ConvolverNode (hall IR) ─▶ return ──────┤
     └─▶ delay send ─▶ delay ⟲ (feedback 0.36, band-limited) ─▶ return ──────┤ (a little of the delay also feeds the reverb)
                                                                             ▼
        master (dynamics × nudge) ─▶ fade ─▶ compressor (2.2:1) ─▶ limiter (20:1, −1.5 dB, always on) ─▶ destination
```

* `cutAtBeat` ramps `cut` to zero in 25 ms and kills the voices; the convolver and delay keep ringing.
* `fadeOut` drives `fade`. `stop()` kills voices in 30 ms and also chokes the reverb/delay returns.
* Sidechain: every kick (drumkit 36, kick808) dips all buses except `pulse` / `accents` to −9 dB, ~180 ms recovery.
* All parameter moves are `setTargetAtTime` glides (0.4 s at phrase starts, `overSec` for hold updates and nudges).

## Scheduling

A worker timer ticks every 25 ms; each tick schedules everything that starts within 200 ms of the audio clock
(the window widens automatically if ticks arrive late). Tone.Transport is not used.

* Free-running: `start(n+1) = start(n) + phraseSeconds(n)`. Events are emitted when the moment is *heard* (audio time plus
  `outputLatency`), with 25 ms granularity.
* Hold: decided only 100 ms before the last phrase ends, so a phrase arriving any earlier still makes the downbeat. The hold
  chord fades in (1.5 s) over the stretched releases of the phrase's last sustains. A beat grid keeps running from the phrase
  end at that phrase's tempo; the next phrase starts on its next whole beat and the held notes fall away over 1.2 s.
* Held sustains (and any sustain longer than its sample) are re-grained: a fresh take from a varied offset is crossfaded in
  (equal power, ≤ 1.5 s) every 5–6 s, sooner on short samples (the hop is derived from the actual buffer length).
* Video-locked: clock time is mapped to audio time with a smoothed offset. Pause → everything released in 80 ms. A jump of
  more than 250 ms, or more than 60 ms of drift on two consecutive ticks, kills the voices and resyncs; long notes already
  under way at the new position are joined mid-sample.

## How the samples are performed

* **Levels.** The library keeps raw recorded dynamics and nothing is normalised per sample. At load, each dynamic layer is
  made up to the level of the loudest layer (≤ +26 dB), and within a layer each key is trimmed 60 % of the way towards the
  layer median (±12 dB; not for piano or unpitched kits). Levels come from `manifest.extra.json` (mean of `peakDb` and `rmsDb` for
  sustains, `peakDb` for one-shots) and are measured from the decoded audio when it is absent. One velocity curve
  (`0.06 + 0.94·vel^1.6`) then sets loudness for every instrument: vel 0.15 sits ≈ 19 dB under vel 1.0.
* **Velocity layers.** Sustains crossfade neighbouring layers with equal-power gains; one-shots and the piano pick one layer.
  Sustains also get a per-voice low-pass that opens with velocity.
* **Round robin.** Takes rotate; equally-near sampled keys alternate; `violins2` shares the `violins` rotation (so a unison
  never uses one buffer twice), is detuned +6 cents, and uses the neighbouring key where there is only one take.
* **Humanise.** Per-note jitter (strings ±10 ms … drums ±3 ms, none on sub/kick808/noise), velocity ±6 %, detune ±3 cents,
  seeded from (seed, phrase index, note index).
* **Envelopes.** Bowed strings get a 20–40 ms fade-in over their (already slow) recorded attack, winds/brass 40–90 ms;
  releases 250–600 ms overlap the next note. A slurred note (starts where another note of the same line ends) enters past
  the sample's attack. Long notes bloom slightly and taper before the release.
* **Piano.** Pedal marks defer note-offs to the next lift (carried across phrase boundaries); pedal and key-release noises;
  longer release below C3; no damper above C7; a re-struck key replaces its earlier ring.
* **Cymbal `roll`** is a swell peaking at the note end: the recording whose time-to-peak is nearest the note length is
  started early (or entered part-way if there is no lead time). **Timpani `roll`** is a level recording, so a crescendo to
  the note end is drawn with gain.
* **Fallbacks.** staccato ↔ spiccato; pizzicato → staccato → gated sustain; tremolo → sustain + 12 Hz LFO; an instrument
  with only `hit` plays it for any articulation. No samples at all → pad (sustained) or pluck (short/struck) with one
  warning, and the samples are fetched in the background.
* Voice cap 96, oldest-quietest stolen first; hold voices and notes that have not started are spared.

## Deviations from the brief, and choices worth knowing

* **Manifest `gainDb` is not applied.** `tools/samples/build.mjs` bakes that gain into the mp3s; applying it again would
  double it. (`APPLY_MANIFEST_GAIN_DB` in `sampler.ts`.)
* **Layer levels are fully matched and one velocity curve carries the dynamics**, rather than leaving a residual gap between
  layers plus a gentle velocity gain. Net effect is the intended one (pp clearly audible, same response for single- and
  multi-layer instruments); the constants are `LAYER_MAKEUP_MAX_DB`, `KEY_COMP_AMOUNT` in `selection.ts` and
  `velocityGain`.
* **Width** tops out at 0.72 on the StereoWidener, not 1.0 (1.0 removes the centre of the image entirely).
* **Piano picks one velocity layer** instead of crossfading two (two struck attacks at once smear).
* **Out-of-range notes** (> 7 semitones beyond the sampled keys) are moved by octaves into range, with one warning, rather
  than played at a clamped rate, which would be the wrong pitch.
* **Noise notes** (swells) are audible even when `mix.noise` is 0; only the continuous bed follows `mix.noise`.
* Hold notes carry no layer, so they go to the bus that instrument last used in the phrase (else `pedal`).
* A phrase with no pedal marks implies a pedal lift on its downbeat.
* `pianoHarmonics` and VSCO's `sfzVolumeDb` are not used. Seating is pan only (no depth for the timpani).
* Synth levels were set from bus meters, not by ear.
