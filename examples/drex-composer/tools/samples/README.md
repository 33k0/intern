# Sample tooling

Builds the browser sound base in `assets/samples/` (mp3 + `manifest.json`) and `assets/ir/` (reverb impulse
responses + `ir.json`) from free libraries. Licences and credits: `assets/CREDITS.md`.

## Run

```sh
cd tools/samples
npm install            # only dependency: ffmpeg-static (brings its own ffmpeg binary)
node download.mjs      # raw sources -> <project>/.cache/raw/   (~2.2 GB, skipped when already there)
node build.mjs         # -> assets/samples/**.mp3, manifest.json, manifest.extra.json
node build-ir.mjs      # -> assets/ir/*.wav, ir.json
node check.mjs         # verification report; exit code 1 on any hard failure   (--verbose for details)
```

`npm run all` does the four steps in order. Needs Node 20+ (uses global `fetch`), `git`, `curl`, `tar`, `unzip`.
Everything is re-runnable: downloads are cached, `build.mjs` only re-encodes files whose source or settings
changed (`--force` re-encodes all, `--only=piano,drumkit` limits the run and leaves the manifest alone,
`--dry` prints the plan). Nothing from the downloaded archives is ever executed.

| File | Purpose |
|---|---|
| `download.mjs` | Fetches the sources. `node download.mjs piano vsco vcsl drumkit openair` picks steps. |
| `build.mjs` | Instrument definitions, sample selection, gain, encoding, manifest. |
| `analyze.mjs` | Per-file analysis (peak, RMS, trim point), cached in `.cache/analysis.json`. |
| `build-ir.mjs` | B-format -> stereo impulse responses. |
| `check.mjs` | Checks every manifest path, decodes every file, silence / duration / format, pitch, schema. |
| `lib.mjs` | Shared helpers (ffmpeg wrapper, note names, pitch estimators). |

## Sources (see `download.mjs` for the pinned commits / URLs)

- **Piano** - Salamander Grand Piano mp3 set from `https://tambien.github.io/Piano/audio/`.
- **VSCO 2 CE** - the repository is ~2.3 GB and a shallow clone was very slow, so only the folders that are
  converted (~1.1 GB, 1155 files) are fetched file-by-file from `raw.githubusercontent.com` at a pinned commit.
  `node download.mjs vsco-clone` does the full `git clone --depth 1` instead. The library's own key maps come
  from its `SFZ` branch (`.cache/raw/vsco2-sfz/`).
- **VCSL** - blob-less sparse git checkout of the few folders needed.
- **Salamander Drumkit** - the GitHub repo only has `.sfz` files; samples come from the archive.org tarball.
- **OpenAIR** - zips from `webfiles.york.ac.uk`; the descriptive pages from web.archive.org (the OpenAIR site's
  TLS certificate had expired).

## Conversion rules

- **Format:** mp3 (libmp3lame VBR), 44.1 kHz, stereo. `-q:a 4` (~160 kbps) for full-level files; files whose
  peak ends up below -12 dBFS use `-q:a 2`, below -24 dBFS `-q:a 0`, because LAME gives quiet audio far fewer
  bits and the soft layers here are deliberately left quiet.
- **Trim:** start = first sample that reaches `clamp(filePeak - 50 dB, -75, -55) dBFS`, minus 2 ms, with a
  1.5 ms fade-in. Drum-kit hits are cut tighter (3 ms before the level is within 40 dB of the peak).
- **Caps (with fade-out at the cap):** sustain / tremolo / timpani roll 9 s (0.3 s fade); piano 14 s below C3,
  10 s C3-C5, 6 s above (0.3 s); staccato / spiccato / pizzicato 4 s; ringing one-shots: harp 9 s, vibraphone
  9 s, timpani 8 s, cymbal crash 8 s, cymbal swell and tam-tam 12 s, bass drum and glockenspiel 6 s,
  drum-kit cymbals 7 s (fades 0.6-2.5 s so the cut is not heard); drum-kit open hat 5 s, other drums 4 s (0.3 s).
- **Gain:** no per-sample normalisation. One fixed gain per instrument+articulation, chosen so that the
  loudest source sample of that articulation peaks at -3 dBFS, rounded to 0.5 dB; it is the `gainDb` in the
  manifest. Two documented exceptions:
  - *Drum kit:* the Salamander wavs are all peak-normalised, the kit balance is in the `volume=` opcodes of
    its `ALL.sfz`. Those per-group values are applied in addition to the common `gainDb` (listed per file as
    `libraryGroupVolumeDb` in `manifest.extra.json`).
  - *Piano extras* (pedal, release, harmonics) use the piano's gain.
- **Dynamics:** up to 3 layers (piano 5: velocity layers 1/4/8/12/16 of 16; drum kit 4 because the snare has a
  ghost layer). `velMax`: 2 layers 0.5/1, 3 layers 0.35/0.7/1, piano 0.16/0.38/0.63/0.88/1, drum kit
  0.2/0.45/0.75/1. Every layer lists every sampled key; where a key has fewer dynamics than the instrument the
  nearest one is reused (ties -> the louder). Exception: glockenspiel, whose loud layer was sampled on G#7
  instead of G7, keeps per-layer key sets.
- **Round robin:** up to 3 takes for short articulations (the VSCO libraries have 2); sustains use 1.
- **Density:** the libraries are already sampled every 2-4 semitones (piano every 3), so nothing is thinned.

## Pitch / octave conventions (verified, see `check.mjs` output)

- **Piano:** scientific names, C4 = 60. The instrument is stretch-tuned as recorded (A0 -25 cents ... C8 +90).
- **VSCO 2 CE:** MIDI keys are taken from the library's SFZ `pitch_keycenter`, not from the file names. Most
  folders name notes an octave low (`VlnEns_susVib_G2` = G3 = 55); `Solo Violin/Arco Vib` and `Pizz`, and the
  harp, use scientific names. `VSCO_KEY_OVERRIDES` in `build.mjs` fixes the one wrong key found.
- **Timpani:** no pitch in the names, SFZ keys are up to 1.6 semitones off. `tuneTimpani()` measures the
  principal of each drum (kettledrum modes are 1 : 1.5 : 2, so plain autocorrelation reads an octave low),
  snaps it to the nearest semitone and resamples the remainder.
- **VCSL glockenspiel / vibraphone:** names are an octave low (`glock_*_C7` = C8 = 108, `Vibes_*_A4` = A5 = 81):
  `GLOCK_OCTAVE_SHIFT` / `VIBES_OCTAVE_SHIFT` = +12.
- **Unpitched** instruments use the fixed pseudo-notes of the manifest spec (drum kit 36/38/42/44/45/46/47/49/50/51,
  bass drum 36, cymbal 49, tam-tam 52).

## Outputs

- `assets/samples/manifest.json` - exactly the schema the engine expects. Besides the four piano helpers,
  `extras` also carries `cymbalSwellShort` / `cymbalSwellMedium` / `cymbalSwellLong` (arrays of one path);
  `cymbal.roll@49` is the medium swell.
- `assets/samples/manifest.extra.json` - informational side-car, not needed to play anything:
  per articulation and layer the median peak / RMS / duration; per file the source path, trim, cap, gain,
  peak and RMS after gain, `loudestAtSec` (when a swell or roll peaks), `sfzVolumeDb` (the extra per-region
  gain VSCO's own SFZ applies at playback - not applied here), `tunedBySemitones`, mp3 quality.
- `assets/ir/ir.json` - `[{id, name, file, licence, attribution, sourceUrl, rt60Approx, ...}]`;
  `rt60Approx` is the mean of OpenAIR's published T30 at 500 Hz and 1 kHz.

## Things to know when using the samples

- **Soft layers are much quieter than loud ones** (natural recorded levels, e.g. cello tremolo: median peak
  -35 dBFS soft vs -4 dBFS loud; timpani -32 / -18 / -6). If the engine also scales gain by velocity the soft
  end may become too quiet; the per-layer medians and per-file `sfzVolumeDb` in the side-car are there to
  build a compensation curve from.
- Levels also vary along the range inside a layer (flute and horn top notes are ~20 dB hotter than the bottom).
- Section string sustains have slow attacks (violins: median 180 ms to come within 20 dB of the peak) - use
  `spiccato` for fast notes.
- Swell timing: `cymbalSwellShort` peaks ~1.6 s after the start, medium ~3.8 s, long ~7.2 s.
