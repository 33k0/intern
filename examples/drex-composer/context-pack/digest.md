# Theory digest

178 rules for the composer engine, each at most 35 words. 150 come from four public-domain books and carry the page or section where the idea is stated; 28 (16%) are marked **own**: general practice the 1890s–1920s books do not cover, with no book reference.

Generated from `digest.json` by `tools/ndi/render-digest-md.mjs`; edit the JSON, not this file. Page numbers are printed page numbers, as marked by `[p. N]` lines in `books/<slug>/text.txt`. The exact sentence each sourced rule rests on is in `digest.evidence.json`.

## Sources

- `rimsky-orchestration`: Nikolay Rimsky-Korsakov, *Principles of Orchestration* (1922). https://www.gutenberg.org/ebooks/33900
- `goetschius-melody`: Percy Goetschius, *Exercises in Melody-Writing* (1900). https://archive.org/details/exercisesinmelod00goet
- `tchaikovsky-harmony`: P. I. Tchaikovsky, *Guide to the Practical Study of Harmony* (1900). https://archive.org/details/tchaikovsky-harmony-textbook
- `prout-form`: Ebenezer Prout, *Musical Form* (1893). https://archive.org/details/15emusicalform00prouuoft

## Rules per call type

| Call | Rules |
| --- | ---: |
| `setup` | 25 |
| `plan` | 25 |
| `theme_draft` | 23 |
| `theme_judge` | 18 |
| `phrase_direction` | 25 |
| `voice_leading` | 25 |
| `phrase_judge` | 20 |
| `orchestration` | 25 |
| `hold` | 22 |
| `ending` | 23 |

## Melody (18)

- **`melody.active-steps-resolve`**: Scale steps 1, 3 and 5 are at rest. Resolve the 7th step upward (strongest pull) and the 6th and 4th downward (4th weakest); the 2nd may move either way.  
  Goetschius, *Exercises in Melody-Writing*, par. 5-6, p. 6 · calls: `theme_draft`, `theme_judge`
- **`melody.step-repeat-third-free`**: Stepwise motion along the scale is always available; a tone may also be repeated, or moved by a third, anywhere. A third leapt from a resting tone (1, 3, 5) creates no obligation.  
  Goetschius, *Exercises in Melody-Writing*, par. 9, p. 8 · calls: `theme_draft`
- **`melody.chord-leaps-for-vigour`**: Leaps along a good chord of the key give vigour and contrast to stepwise motion; switch between scale motion and chord leaps at any point.  
  Goetschius, *Exercises in Melody-Writing*, par. 13-14, p. 12 · calls: `theme_draft`
- **`melody.leap-recovery`**: A leap of a third is always allowed. After any wider leap, turn back and move in the opposite direction, by step or along a chord.  
  Goetschius, *Exercises in Melody-Writing*, par. 26, p. 17 · calls: `theme_draft`, `theme_judge`
- **`melody.leap-to-active-tone`**: Leap to an active tone from the side opposite its tendency (down to the 7th, up to the 6th or 4th) so its resolution supplies the turn; the reverse needs a clear chord line.  
  Goetschius, *Exercises in Melody-Writing*, par. 28, p. 18 · calls: `theme_draft`
- **`melody.successive-leaps-one-chord`**: Successive leaps in the same direction must together outline one chord: each new tone must harmonize with the tones of the leap before it.  
  Goetschius, *Exercises in Melody-Writing*, par. 31, p. 19 · calls: `theme_draft`, `theme_judge`
- **`melody.avoid-tritone-leap`**: Avoid the augmented-fourth leap between the 4th and 7th scale steps; it is acceptable only when it plainly outlines the dominant seventh chord.  
  Goetschius, *Exercises in Melody-Writing*, par. 35, p. 20 · calls: `theme_draft`, `theme_judge`
- **`melody.minor-sixth-seventh-apart`**: In harmonic minor, do not let the 6th and 7th scale steps follow each other directly; it is possible only rarely, as an obvious outline of the diminished seventh chord.  
  Goetschius, *Exercises in Melody-Writing*, par. 42, p. 29 · calls: `theme_draft`, `theme_judge`
- **`melody.long-notes-on-accents`**: For regular rhythm, put the longer notes on accented beats and the shorter notes on unaccented beats or beat fractions; evenly divided measures are also regular.  
  Goetschius, *Exercises in Melody-Writing*, par. 46, p. 31 · calls: `theme_draft`, `theme_judge`
- **`melody.essential-vs-embellishing`**: Design the melody over an implied chord: tones that agree with the chord of the moment are essential; tones that differ from it, usually the shorter ones, only connect or embellish.  
  Goetschius, *Exercises in Melody-Writing*, par. 100, p. 75 · calls: `theme_draft`
- **`melody.passing-note-fills-third`**: Fill a leap of a third with a passing note, normally on an unaccented fraction; moving it onto the beat of the second tone (accented passing note) often improves the rhythm.  
  Goetschius, *Exercises in Melody-Writing*, par. 104-105, p. 82 · calls: `theme_draft`
- **`melody.mode-metre-character`**: Choose mode and metre for character: major is brighter and more vigorous, minor more passionate and sombre; duple metre is sturdier, triple metre more graceful.  
  Goetschius, *Exercises in Melody-Writing*, par. 126a-b, p. 121 · calls: `setup`
- **`melody.tempo-and-motion`**: In slow or moderate tempo favour scale motion, ample ornament and varied note lengths; in fast tempo favour chord leaps, less ornament and more nearly uniform rhythm.  
  Goetschius, *Exercises in Melody-Writing*, par. 126c, p. 121 · calls: `setup`, `theme_draft`, `theme_judge`
- **`melody.accent-or-lengthen`**: To bring out a tone's meaning, put it on an accented beat or lengthen it; placing it on an unaccented beat or shortening it weakens its effect.  
  Goetschius, *Exercises in Melody-Writing*, par. 129f, p. 122 · calls: `theme_draft`, `hold`
- **`melody.save-extremes-for-climax`**: Treat a singing melody like a voice: keep it mostly within one central octave, saving the notes above for climaxes and the notes below for the fall of the line.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. VI, "Range and register", p. 134 · calls: `theme_draft`, `theme_judge`
- **`melody.vary-note-values`**: A singing melody needs at least three different note values, because rhythmic monotony does not suit it, and a fair number of long notes if it is to sound sustained.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. VI, "Vocalisation", p. 134 · calls: `theme_judge`
- **`melody.contrast-motives`**: When a phrase or period is built from more than one motive, make the motives contrast with each other in melodic outline, in rhythmic figure, or in both.  
  Prout, *Musical Form*, § 183, p. 83 · calls: `theme_judge`
- **`melody.one-climax-note`**: Give the theme one clear highest note, heard only once and placed in its second half; rise toward it and fall away after it.  
  **own** (no book source) · calls: `theme_draft`, `theme_judge`

## Phrase structure (9)

- **`phrase_structure.four-bar-phrase`**: Make the basic phrase four measures long and begin it on a tone of the tonic triad, on the first downbeat or as an upbeat; an upbeat's length is taken from the last measure.  
  Goetschius, *Exercises in Melody-Writing*, par. 8a, p. 7 · calls: `theme_draft`, `theme_judge`
- **`phrase_structure.even-lengths`**: Build complete musical statements (periods) in multiples of two bars: four, eight or sixteen. Other lengths are exceptional.  
  Prout, *Musical Form*, § 25, p. 8 · calls: `setup`
- **`phrase_structure.statement-needs-reply`**: Follow every statement with a corresponding reply. A single phrase, even one ending with a full cadence, cannot stand alone; lacking a response it feels incomplete.  
  Prout, *Musical Form*, § 26, p. 8 · calls: `phrase_direction`, `phrase_judge`
- **`phrase_structure.parallel-period`**: Parallel answer: let the answering phrase repeat the opening phrase's melody except for its last three or four tones, which must change to reach the different cadence.  
  Goetschius, *Exercises in Melody-Writing*, par. 52, p. 35 · calls: `phrase_direction`
- **`phrase_structure.rest-marks-group`**: Place a brief rest at the end of a repeated or sequenced group to make its recurrence clear; never let a rest break the continuity of the melody.  
  Goetschius, *Exercises in Melody-Writing*, par. 65, p. 44 · calls: `hold`
- **`phrase_structure.grade-rests-like-punctuation`**: Grade the points of rest like punctuation: a full stop at the end of a period, a semicolon at the end of a phrase, a comma at a two-bar section; make no break between motives.  
  Prout, *Musical Form*, § 66, p. 30 · calls: `hold`
- **`phrase_structure.vary-lengths-in-long-pieces`**: In longer pieces do not cadence at every fourth bar: extend some phrases and contract others to prevent monotony, without upsetting the balance of the whole. Unbroken regularity suits only small pieces.  
  Prout, *Musical Form*, § 221, p. 102 · calls: `plan`
- **`phrase_structure.extend-by-repeating-section`**: Extend a phrase in the middle by repeating one of its two-bar sections, exactly or varied, before going on to the cadence.  
  Prout, *Musical Form*, § 233, p. 107 · calls: `phrase_direction`
- **`phrase_structure.overlap`**: Never drop an accented bar. To tighten a join, overlap instead: let the final cadence bar of one phrase or period serve also as the first bar of the next.  
  Prout, *Musical Form*, § 258, p. 118 · calls: `phrase_direction`

## Cadences (14)

- **`cadences.perfect-cadence-melody`**: For a perfect cadence, end the phrase on the keynote, on an accented beat of the fourth measure, approached from a tone of the dominant triad.  
  Goetschius, *Exercises in Melody-Writing*, par. 8b, p. 7 · calls: `theme_draft`, `theme_judge`, `ending`
- **`cadences.half-cadence-melody`**: For a half cadence, end the opening phrase on an accented beat of its fourth measure on any tone of the dominant triad; start the answering phrase on the same beat as the first.  
  Goetschius, *Exercises in Melody-Writing*, par. 51, p. 34 · calls: `theme_draft`
- **`cadences.midpoint-and-end`**: Give a melody a point of repose at its midpoint (a half cadence) and end it on the tonic; without these it does not satisfy the ear.  
  Prout, *Musical Form*, § 8, p. 3 · calls: `theme_judge`
- **`cadences.eight-bar-plan`**: In the normal eight-bar period, put a half cadence at the fourth bar and a full cadence at the eighth, making two four-bar phrases.  
  Prout, *Musical Form*, § 27, p. 9 · calls: `theme_judge`, `phrase_judge`
- **`cadences.middle-cadence-options`**: The first phrase need not end with a half cadence: any middle cadence will do, such as an inverted or deceptive cadence, or a full cadence robbed of its finality.  
  Prout, *Musical Form*, § 29, p. 9 · calls: `phrase_direction`
- **`cadences.section-cadence-weaker`**: Make the cadence closing a section weaker than the one closing a phrase; equally marked cadences at every section break the continuity and make the music halt.  
  Prout, *Musical Form*, § 55, p. 25 · calls: `phrase_direction`, `phrase_judge`
- **`cadences.dominant-weak-tonic-strong`**: In a full cadence, connect an unaccented dominant chord with an accented tonic chord; dominant on the accent and tonic off it gives no feeling of finality.  
  Prout, *Musical Form*, § 59, p. 27 · calls: `ending`
- **`cadences.no-same-cadence-twice`**: In a short piece avoid using the same cadence twice. Above all do not end the third phrase with a full close in the tonic: the final cadence would merely repeat it.  
  Prout, *Musical Form*, § 339, p. 179 · calls: `phrase_judge`
- **`cadences.full-close-formula`**: Full closing cadence: a subdominant-group chord (IV, II or II7) on a weak beat, tonic six-four on the strong beat, dominant or dominant seventh on a weak beat, root-position tonic on the strong beat.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XVII, § 49, p. 57 · calls: `ending`
- **`cadences.root-dominant-seventh-closes`**: Root-position dominant seventh to tonic closes a piece or section completely, so avoid it mid-piece; there use inversions of the dominant seventh, which keep the music moving.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XVII, § 48, p. 57 · calls: `voice_leading`, `phrase_judge`
- **`cadences.perfect-needs-tonic-on-top`**: For a perfect cadence put both dominant and tonic in root position with the tonic note in the top voice of the last chord; any other arrangement makes the close imperfect.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXXIV, § 139, p. 136 · calls: `ending`, `phrase_judge`
- **`cadences.deceptive-to-prolong`**: To prolong a phrase pair, replace the expected full cadence in its eighth bar with a deceptive cadence, then repeat the last two bars in varied form to reach the real close.  
  Prout, *Musical Form*, § 224, p. 104 · calls: `phrase_direction`
- **`cadences.plagal-after-tonic-pedal`**: A tonic pedal point often ends with a plagal close: the subdominant triad followed by the tonic triad.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXII, § 64, p. 79 · calls: `ending`, `hold`
- **`cadences.extend-final-cadence`**: The simplest and commonest way to extend a closing phrase is to repeat or prolong its final cadence; the added bars do not begin a new phrase.  
  Prout, *Musical Form*, § 222, p. 102 · calls: `ending`

## Tension and release (13)

- **`tension_release.rising-falling-line`**: A rising scale line increases emotional tension or emphasis; a falling line relaxes it.  
  Goetschius, *Exercises in Melody-Writing*, par. 129a, p. 122 · calls: `theme_draft`, `phrase_direction`
- **`tension_release.step-vs-leap`**: Stepwise motion changes the intensity gradually and smoothly; leaps change it abruptly and positively, in proportion to their size.  
  Goetschius, *Exercises in Melody-Writing*, par. 129b, p. 122 · calls: `theme_draft`
- **`tension_release.chromatic-motion`**: Chromatic motion is more seductive or passionate than diatonic motion, usually the more so the faster it moves.  
  Goetschius, *Exercises in Melody-Writing*, par. 129c, p. 122 · calls: `setup`
- **`tension_release.chord-member-colour`**: A melody tone on the chord root sounds powerful, on the third sweeter, on the fifth soft and tender; sevenths, ninths, suspensions and appoggiaturas sound keen, and prolonging them creates strain.  
  Goetschius, *Exercises in Melody-Writing*, par. 129g, p. 122 · calls: `theme_draft`
- **`tension_release.melodic-suspension`**: Any tone that moves on by step may be held over (tied or restruck) into the first part of the next tone as a suspension, which then resolves by that step.  
  Goetschius, *Exercises in Melody-Writing*, par. 101, p. 76 · calls: `hold`
- **`tension_release.suspension-preparation`**: Prepare a suspension by holding the note over in the same voice from the previous chord, sound it on the accented beat, and resolve it down a step on the following weaker beat.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXIII, § 70, p. 82 · calls: `hold`
- **`tension_release.dissonance-resolves-down`**: A dissonance disturbs the ear until it moves melodically downward into a consonance; do not use a seventh chord whose seventh cannot resolve down by step.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XVI, § 45, p. 52 · calls: `voice_leading`, `phrase_judge`
- **`tension_release.pedal-clash`**: Over a pedal point, chords that clash with the held bass note greatly intensify the cadence that follows; but the first and last chords over the pedal must agree with it.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXII, §§ 62 and 65, p. 77 · calls: `hold`, `ending`
- **`tension_release.less-decided-close`**: To make a close less decided, end with the third of the tonic chord in the top voice, or delay the tonic chord to the weak beat (a feminine ending).  
  Prout, *Musical Form*, § 33, p. 11 · calls: `phrase_direction`, `phrase_judge`
- **`tension_release.defer-cadence`**: Stretch the approach to a cadence over an extra bar, for instance holding the cadential six-four before the dominant: the cadence is fully expected and satisfies all the more for being deferred.  
  Prout, *Musical Form*, § 223, p. 103 · calls: `hold`, `ending`
- **`tension_release.suspensions-slow-tempo`**: Suspensions enliven rhythm, bind chords together and give the harmony a refined, noble character; they are most effective in slow tempo, where the ear can follow preparation and resolution.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXX, p. 126 · calls: `setup`, `hold`
- **`tension_release.levers`**: Raise tension by rising register, growing loudness, thicker texture, faster chord changes, sharper dissonance or shorter phrases; release by reversing them. Move several together for big moments, one at a time for small ones.  
  **own** (no book source) · calls: `plan`
- **`tension_release.ending-energy`**: Choose each phrase ending by how much energy should remain: resolved (tonic) stops the motion, half-resolved (dominant) asks for an answer, suspended (held dissonance, no cadence) pulls straight into the next phrase.  
  **own** (no book source) · calls: `phrase_direction`, `phrase_judge`

## Developing variation (17)

- **`developing_variation.repeat-or-sequence`**: Unify a melody by making a whole group of tones recur: repeat it literally on the same scale steps, or sequence it on steps a fixed distance higher or lower.  
  Goetschius, *Exercises in Melody-Writing*, par. 59-61, p. 41 · calls: `theme_draft`, `theme_judge`, `phrase_direction`
- **`developing_variation.vary-slightly`**: Vary a repetition or sequence only slightly, never so far that it is hard to recognise: add intermediate tones, or omit small parts of the original figure.  
  Goetschius, *Exercises in Melody-Writing*, par. 66a, p. 44 · calls: `phrase_direction`, `phrase_judge`
- **`developing_variation.widen-narrow-intervals`**: Vary a recurring figure by widening or narrowing its intervals (step to small leap, small leap to wider leap, or the reverse) while keeping its direction at every point.  
  Goetschius, *Exercises in Melody-Writing*, par. 66b, p. 44 · calls: `phrase_direction`
- **`developing_variation.partial-recurrence`**: A repetition or sequence may be partial: bring back only a portion of the original figure.  
  Goetschius, *Exercises in Melody-Writing*, par. 67, p. 45 · calls: `phrase_direction`
- **`developing_variation.rhythm-halve-double`**: A figure may recur in a different rhythm; it stays recognisable if the total length is kept, or exactly halved or doubled, so the same tones remain accented.  
  Goetschius, *Exercises in Melody-Writing*, par. 68, p. 46 · calls: `phrase_direction`
- **`developing_variation.inversion`**: Inverting a figure (turning it upside down) is an excellent variation to use freely; keep it on the same beats as the original and add no other confusing change.  
  Goetschius, *Exercises in Melody-Writing*, par. 70, p. 47 · calls: `phrase_direction`
- **`developing_variation.germ`**: Grow an ornate figure or whole phrase from a germ of two or three plain tones (a piece of scale, or a tonic or dominant chord line) by embellishment and repetition.  
  Goetschius, *Exercises in Melody-Writing*, par. 121-122, p. 109 · calls: `theme_draft`
- **`developing_variation.plain-skeleton-sound`**: The underlying plain tones must themselves form a faultless, natural figure, and their elaboration must stay coherent, smooth, well balanced in rhythm and design, and free from eccentricity.  
  Goetschius, *Exercises in Melody-Writing*, par. 121, p. 109 · calls: `theme_judge`
- **`developing_variation.develop-for-unity`**: Develop a short theme by sequential imitation, inversion, augmentation or diminution, so that the parts of the work are logically connected and the whole has unity.  
  Prout, *Musical Form*, § 12, p. 4 · calls: `setup`
- **`developing_variation.rhythm-keeps-identity`**: Vary a longer motive by altering some of its intervals, even step to leap; if its rhythmic figure is strongly marked, the rhythm alone keeps the motive recognisable.  
  Prout, *Musical Form*, § 182, p. 82 · calls: `theme_judge`, `phrase_judge`
- **`developing_variation.vary-repeated-section`**: When a section is repeated, vary it: change its melodic outline, its harmony, its key, or any combination of these.  
  Prout, *Musical Form*, § 207, p. 93 · calls: `phrase_direction`
- **`developing_variation.motive-saturation`**: Hold a short piece together by using the one or two motives of its opening bars, and their diminutions, in nearly every bar, leaving them only at the final cadences of periods.  
  Prout, *Musical Form*, § 325, p. 164 · calls: `phrase_judge`
- **`developing_variation.change-one-thing`**: Derive each phrase from the one before: keep most of its features and change one or two (rhythm, contour, interval size, harmony, register), so it sounds new yet clearly descended.  
  **own** (no book source) · calls: `phrase_direction`, `phrase_judge`
- **`developing_variation.fragment-to-build`**: To drive toward a climax, cut the motive down to its opening cell and repeat that fragment in rising sequence, at shorter and shorter distances.  
  **own** (no book source) · calls: `phrase_direction`
- **`developing_variation.augment-to-broaden`**: Use augmentation (doubled note lengths) to broaden the theme at a climax or ending; use diminution (halved lengths) to add urgency during a build.  
  **own** (no book source) · calls: `phrase_direction`, `ending`
- **`developing_variation.rule-of-three`**: State an idea the same way at most twice; at its third appearance change its ending, harmony, direction or scoring.  
  **own** (no book source) · calls: `phrase_direction`, `phrase_judge`
- **`developing_variation.pick-by-intent`**: Pick the transformation by intent: sequence to travel, inversion to answer, fragmentation to intensify, augmentation to broaden, a new register or instrument to refresh, plain repetition to confirm.  
  **own** (no book source) · calls: `phrase_direction`

## Departure and return (11)

- **`departure_return.near-keys`**: The nearly related keys of a major key are its dominant, subdominant and relative minor, plus the relative minors of the dominant and subdominant.  
  Prout, *Musical Form*, § 80, p. 38 · calls: `setup`
- **`departure_return.parallel-keys`**: A major key is also related, in the second degree, to its tonic minor and subdominant minor; a minor key to its tonic major and dominant major.  
  Prout, *Musical Form*, § 91, p. 42 · calls: `setup`
- **`departure_return.minor-first-goal`**: From a minor key, modulate first to the relative major (its nearest key) or to the submediant major; the dominant and subdominant minors share only one chord with it.  
  Prout, *Musical Form*, § 82, p. 39 · calls: `plan`
- **`departure_return.no-key-twice`**: In a small form never modulate to the same key twice, and make no more than one cadence in any key other than the tonic.  
  Prout, *Musical Form*, § 324, p. 164 · calls: `plan`
- **`departure_return.return-must-recall`**: For unity, the third part of a three-part form must bring back the first part's principal idea. It may be much altered or cut to a single period, but never build it from new material.  
  Prout, *Musical Form*, § 353, p. 185 · calls: `plan`
- **`departure_return.middle-ends-on-home-dominant`**: End the middle part on the dominant of the original key, as is often done, so that it leads back into the return of the first part.  
  Prout, *Musical Form*, § 376, p. 211 · calls: `plan`
- **`departure_return.link-back`**: To get back from a contrasting middle section, use a link: a passage with no cadence of its own that modulates back to the home key before the first theme returns.  
  Prout, *Musical Form*, § 368, p. 203 · calls: `phrase_direction`
- **`departure_return.vary-the-return`**: Vary the principal subject when it returns: keep its melodic and harmonic outline, but make the melody more florid in its ornaments and the accompaniment fuller and richer.  
  Prout, *Musical Form*, § 373, p. 204 · calls: `phrase_direction`
- **`departure_return.return-new-continuation`**: When the opening subject returns near the end and no longer has to lead to the dominant, give it a new continuation in the tonic and repeat its closing phrase for a final close.  
  Prout, *Musical Form*, § 326, p. 166 · calls: `ending`
- **`departure_return.final-cadence-home`**: An answering phrase may pass through other keys, but the final cadence must fall on the tonic of the original key.  
  Goetschius, *Exercises in Melody-Writing*, par. 90, p. 64 · calls: `ending`
- **`departure_return.hold-dominant-link`**: A link leading back to the first subject may simply hold one chord, the dominant minor ninth of the home key, for several bars, with no cadence.  
  Prout, *Musical Form*, § 382, p. 229 · calls: `hold`

## Voice leading (9)

- **`voice_leading.hold-step-leap`**: For each upper voice prefer, in order: hold a common tone, move by step, leap only to a chord tone. Let at most one upper voice leap at a time; the bass may leap freely.  
  **own** (no book source) · calls: `voice_leading`
- **`voice_leading.keep-common-tones`**: When two successive chords share a tone, hold it in the same voice; this gives the harmony fluency, smoothness and unity.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. II, § 11, p. 13 · calls: `voice_leading`
- **`voice_leading.no-parallel-fifths-octaves`**: Never move two voices in parallel perfect fifths or parallel octaves: they displease the ear and destroy the independence of the voices.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. III, § 13, p. 16 · calls: `voice_leading`, `phrase_judge`
- **`voice_leading.contrary-to-bass`**: When two chords share no tone, let the bass move by step and lead the upper voices in contrary motion to it, each to the nearest tone of the new chord, without large leaps.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. III, § 13, p. 16 · calls: `voice_leading`
- **`voice_leading.never-double-leading-note`**: Never double the leading note: when a first-inversion dominant triad goes to the tonic, its third (in the bass) must not be doubled.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. VIII, § 24, p. 28 · calls: `voice_leading`, `phrase_judge`
- **`voice_leading.dominant-seventh-resolution`**: Resolve the dominant seventh to the tonic triad: the seventh falls a step to the third, the leading note rises to the tonic, the fifth usually falls, and the bass leaps to the tonic.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. X, § 29, p. 33 · calls: `voice_leading`
- **`voice_leading.outer-voices-mobile`**: Let the outer voices be mobile, rising and falling like waves. The bass favours leaps of fourths and fifths, or stepwise scale motion, mostly in contrary motion to the top voice.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XI, § 33, p. 38 · calls: `voice_leading`
- **`voice_leading.inner-voices-quiet`**: Keep the inner voices quiet: let them hold the common tones of successive chords, even for several bars, lying not too high and not too far apart.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XI, § 33, p. 38 · calls: `voice_leading`, `hold`
- **`voice_leading.overtone-spacing`**: Space a wide chord like the overtone series: octaves and sixths at the bottom, fifths and fourths in the middle, thirds or seconds at the top.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. III, "Remarks", p. 78 · calls: `voice_leading`

## Harmony (32)

- **`harmony.principal-triads`**: Treat the tonic, subdominant and dominant triads as the principal chords: they define the key unmistakably and are enough to harmonise any melody that stays in the key.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. I, § 5, p. 11 · calls: `setup`
- **`harmony.secondary-triads-softer`**: In a major key the minor triads on the second, third and sixth degrees are softer and weaker; use them as contrast that sets off the strength of the three major triads.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. I, § 6, p. 11 · calls: `voice_leading`
- **`harmony.minor-leading-note`**: In minor, build the harmony on the harmonic minor scale: raise the seventh degree to give a leading note, which the cadence cannot do without.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. VI, § 18, p. 21 · calls: `setup`
- **`harmony.root-vs-inversion`**: Root-position triads give repose and completeness; inversions lack repose and press onward. Use inversions in the middle of a piece, rarely at the start, never as the final chord.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. VIII, § 23, p. 26 · calls: `voice_leading`, `phrase_judge`, `ending`
- **`harmony.core-vocabulary`**: Core vocabulary: the consonant triads and inversions, the dominant seventh, diminished seventh, first-inversion leading-note triad, and secondary sevenths (chiefly on the second degree); use all other chords rarely and for a distinct purpose.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXX, p. 126 · calls: `setup`
- **`harmony.establish-new-key`**: To modulate, foreign chords alone are not enough: establish the new key with a chord that can belong only to it, above all its dominant seventh, which belongs to one key only.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Third Section (before Ch. XVIII), §§ 51-52, p. 63 · calls: `voice_leading`
- **`harmony.pivot-chord`**: Modulate by means of a chord common to the key you leave and the key you enter, even for the simplest moves to nearly related keys.  
  Prout, *Musical Form*, § 96, p. 44 · calls: `voice_leading`
- **`harmony.modulating-sequence`**: For a passing modulation, use a modulating sequence: a chain of dominant sevenths (or other chords that resolve to a tonic), each a fifth below the last, so that every chord is a modulation.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XIX, § 59, p. 70 · calls: `phrase_direction`
- **`harmony.diminished-seventh-pivot`**: Use the diminished seventh as an enharmonic pivot: respelled, each one is equivalent to three others, so a single chord can resolve into four different keys.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXI, § 61, p. 75 · calls: `voice_leading`
- **`harmony.pedal-restores-key`**: After modulating so far that an ordinary full cadence cannot restore the main key, use a pedal point: hold the cadence's bass note while other harmonies pass above it.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXII, § 62, p. 77 · calls: `plan`, `hold`
- **`harmony.dominant-pedal`**: Begin a dominant pedal with the tonic six-four and end it with the dominant triad or dominant seventh; above it you may touch the keys of the dominant, the dominant's dominant and the subdominant.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXII, § 63, p. 77 · calls: `hold`
- **`harmony.pedal-placement`**: Pedal points belong mainly at the close of a piece; at the beginning or in the middle, use a short pedal on the tonic.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXII, § 65, p. 80 · calls: `hold`
- **`harmony.augmented-triad`**: Treat an augmented triad as dominant of the next chord: built on the tonic it leads to the subdominant, on the dominant to the tonic. Its raised fifth rises a semitone, never doubled.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXVI, § 91, p. 101 · calls: `voice_leading`
- **`harmony.augmented-sixth`**: Augmented-sixth chords are inversions of dominant-function chords with the second scale degree lowered; resolve them to the tonic triad, nearly always a major one, since a minor resolution does not fully satisfy.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXVII, §§ 98 and 103, p. 108 · calls: `voice_leading`
- **`harmony.altered-steps`**: In major, any scale step except the 3rd and 7th may be chromatically raised, but only the 6th may be lowered; lowered 6th, raised 4th and raised 2nd are the best.  
  Goetschius, *Exercises in Melody-Writing*, par. 73-74, p. 52 · calls: `setup`
- **`harmony.altered-steps-resolve`**: Resolve chromatically raised steps upward and lowered steps downward, generally by step to the adjacent scale degree; altered steps colour the key and do not change it.  
  Goetschius, *Exercises in Melody-Writing*, par. 80 (and par. 76-77), p. 56 · calls: `voice_leading`
- **`harmony.near-keys-only`**: In a short, simple piece modulate only to the most nearly related keys and never to an unrelated key; remote modulations belong to the larger forms.  
  Prout, *Musical Form*, § 170, p. 78 · calls: `setup`
- **`harmony.reharmonise-held-note`**: Modulate by sustaining one note of a chord alone, then harmonising it as a different member of a new chord; any chord containing that note may follow.  
  Prout, *Musical Form*, § 156, p. 70 · calls: `hold`
- **`harmony.chromatic-as-flavouring`**: Treat extreme chromatic harmony as the flavouring, not the main ingredient, and vary the method of modulation as much as possible.  
  Prout, *Musical Form*, § 168, p. 77 · calls: `setup`
- **`harmony.first-modulation-not-subdominant`**: In a major key, almost never make the first modulation to the subdominant: the tonic is that key's dominant, so going there early soon weakens the feeling of the home key.  
  Prout, *Musical Form*, § 346, p. 182 · calls: `plan`
- **`harmony.balance-dominant-subdominant`**: After a modulation to the dominant side, it is often best to make the next one to the subdominant side: each counterbalances the other and the home key stays secure.  
  Prout, *Musical Form*, § 346, p. 182 · calls: `plan`
- **`harmony.middle-key-choice`**: For the middle part of a major-key three-part piece choose the subdominant, the tonic minor or, more rarely, the relative minor; beginning it in the dominant is most unusual.  
  Prout, *Musical Form*, § 375, p. 211 · calls: `plan`
- **`harmony.change-on-accents`**: Change the harmony on accented beats and bars; the stronger the accent, the more it needs a new chord. A chord may continue from an accented bar through the following unaccented bar.  
  Prout, *Musical Form*, § 208, p. 94 · calls: `voice_leading`, `phrase_judge`
- **`harmony.long-note-many-chords`**: A long melody note does not require equally long notes in the other voices: treat it as a tone common to several chords and keep the harmony changing at the surrounding pace.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XX, § 60 (footnote to the exercises), p. 74 · calls: `hold`
- **`harmony.upper-pedal`**: Pedal notes held in an upper or inner part, not only in the bass, are more effective in the orchestra than on the piano, thanks to the greater variety of tone colour.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. III, "Number of harmonic parts—Duplication", p. 66 · calls: `hold`
- **`harmony.dominant-ninth`**: Resolve the dominant ninth chord to the tonic with the ninth stepping down like the seventh. Prepare the ninth as a held note, omit the fifth in four parts, and never invert the chord.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XII, § 35, p. 40 · calls: `voice_leading`
- **`harmony.colour-sevenths-ninths`**: For warm, bittersweet colour add the major seventh or ninth to tonic and subdominant major chords, and the seventh or ninth to minor chords; treat these as colour tones that need not resolve.  
  **own** (no book source) · calls: `setup`, `voice_leading`
- **`harmony.two-chord-oscillation`**: A slow oscillation between two chords that share two tones creates stillness without closure; break the pattern with a third chord to signal that the music is moving on.  
  **own** (no book source) · calls: `setup`
- **`harmony.modal-mixture`**: Borrow from the parallel minor (minor subdominant, flat sixth, flat seventh chords) to cast a sudden shadow on a major passage; borrow the major tonic or subdominant to let light into a minor one.  
  **own** (no book source) · calls: `voice_leading`
- **`harmony.chromatic-mediant`**: Move to a chord a third away that shares one tone with the present chord for a vivid, unprepared change of colour; hold the shared tone in the same voice.  
  **own** (no book source) · calls: `voice_leading`
- **`harmony.harmonic-rhythm`**: Change chords slowly for calm and breadth; change them faster approaching a cadence or climax, then slow again on arrival.  
  **own** (no book source) · calls: `voice_leading`, `phrase_judge`
- **`harmony.dark-turn`**: For a late dark turn, replace an expected major chord by its minor form, lower the second or sixth degree, or let the bass sink by semitones under a held melody note.  
  **own** (no book source) · calls: `plan`

## Orchestration (28)

- **`orchestration.strings-carry-expression`**: Give expressive melody to the strings and keep it within the human vocal range: violin notes above the soprano's top and double-bass notes below the bass voice lose warmth and expression.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "A. Stringed Instruments", p. 9 · calls: `orchestration`, `setup`
- **`orchestration.basses-double-cellos`**: Except for pedal notes, do not give the double basses an independent part: let them double the cellos in unison or at the octave.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "A. Stringed Instruments", p. 9 · calls: `orchestration`
- **`orchestration.flute`**: Flute: cold in tone; suits light, graceful melodies in major and brief touches of sorrow in minor. Its low register is dull and cold, its very high register brilliant.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Wood-wind", p. 19 · calls: `orchestration`
- **`orchestration.oboe`**: Oboe: artless and gay in major, pathetic and sad in minor. Its low register sounds wild, its very high register hard and dry.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Wood-wind", p. 19 · calls: `orchestration`
- **`orchestration.clarinet`**: Clarinet: pliable and expressive; suits joyful or contemplative melodies in major and sad, reflective or impassioned ones in minor. Its low register is ringing and threatening, its very high register piercing.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Wood-wind", p. 19 · calls: `orchestration`
- **`orchestration.horn`**: Horn: soft and poetic, dark in the low register, round and full in the upper, but not agile. Its middle notes blend with the bassoon, so it links brass and woodwind.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Brass", p. 24 · calls: `orchestration`
- **`orchestration.pizzicato`**: Use pizzicato chiefly as a colour effect: it has little expressive range, cannot move as fast as bowed playing, and must go slowest of all on the double basses.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Pizzicato", p. 27 · calls: `orchestration`
- **`orchestration.harp`**: Treat the harp as a harmonic, accompanying instrument: give it chords and broken-chord figures with the notes close together, and keep quick figures in its upper register, where they stay clear.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Harp", p. 28 · calls: `orchestration`
- **`orchestration.timpani`**: Timpani cover every dynamic from thunderous to barely audible; use a timpani roll for the most gradual crescendo or diminuendo, an accent dropping to soft, or a dying-away.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Kettle-drums", p. 30 · calls: `orchestration`, `hold`
- **`orchestration.celesta-glockenspiel`**: Use celesta (or piano, alone or with harp) for a soft bell-like sound; the glockenspiel is used the same way but is more brilliant and penetrating.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Glockenspiel, Bells, Xylophone", p. 32 · calls: `orchestration`
- **`orchestration.dont-double-everything`**: Do not double everything all the time: constant mixed doublings wipe out individual colours and give a dull, neutral texture, while simple single timbres leave far more scope for variety.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. I, "Comparison of resonance in orchestral groups and combination of different tone qualities", p. 35 · calls: `orchestration`
- **`orchestration.melody-stands-out`**: Always make the melody stand out from the accompaniment: by a marked dynamic difference, by contrast of tone colour, by doubling or tripling it, or by crossing it above neighbouring parts.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. II, opening remarks on melody, p. 36 · calls: `orchestration`
- **`orchestration.violins-melody`**: Give melody in the soprano-alto register and above to the first violins; add the second violins in unison for fuller resonance without changing the tone colour.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. II, "a) Violins", p. 36 · calls: `orchestration`
- **`orchestration.violas`**: Use violas for short characteristic phrases in the alto-tenor register rather than long singing melodies, since their tone is slightly nasal; usually double a viola melody with other strings or woodwind.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. II, "b) Violas", p. 37 · calls: `orchestration`
- **`orchestration.cellos-melody`**: Give tense, passionate singing melody in the tenor-bass range to the cellos, usually on their top string with its rich chest-voice quality; they suit this better than quick figures.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. II, "c) Violoncellos", p. 38 · calls: `orchestration`
- **`orchestration.octave-doubling-extremes`**: Double a melody lying in the extreme high register an octave below, and a melody lying in the extreme low register an octave above.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. II, "Stringed instruments doubling in octaves", p. 44 · calls: `orchestration`
- **`orchestration.solo-vs-unison`**: Give phrases needing varied, individual expression to one solo instrument of pure timbre. Unison doubling adds resonance, sweetness and power but reduces colour and expressive freedom; use it mainly in loud, broad passages.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. II, "Combination in unison", p. 48 · calls: `orchestration`
- **`orchestration.rescoring-returns`**: When an idea returns, re-score it for variety: move it to another octave or key, widen it with added octaves above and below, alter details, or repeat softly what was loud.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Different ways of orchestrating the same music", p. 100 · calls: `orchestration`
- **`orchestration.tutti-loud`**: Reserve the tutti (strings, woodwind and brass together) essentially for loud and very loud passages; it is rarely used soft.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Full Tutti", p. 102 · calls: `orchestration`
- **`orchestration.solo-string`**: Use a solo violin or cello for phrases needing individual expression, or simply for its distinct colour; keep the accompaniment light and transparent, because a solo string instrument is comparatively weak.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Soli in the strings", p. 105 · calls: `orchestration`
- **`orchestration.percussion`**: Pair triangle, snare drum and tambourine with upper-register harmony, and cymbals, bass drum and gong with low-register harmony; played very loud, the heavy percussion can drown an entire tutti.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Use of percussion instruments for rhythm and colour", p. 117 · calls: `orchestration`
- **`orchestration.economy`**: Do not keep the full orchestra playing for long. Use strings most, then woodwind, brass, timpani, harp, pizzicato, and percussion least; celesta, glockenspiel and xylophone are too distinctive for frequent use.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Economy in orchestral colour", p. 118 · calls: `setup`, `plan`
- **`orchestration.let-groups-rest`**: Let groups rest: a group silent for some time gains fresh interest when it returns. Heavy brass may stay silent for long periods; use percussion seldom and never all together.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Economy in orchestral colour", p. 118 · calls: `plan`
- **`orchestration.three-groups-chord`**: For a full, round, firm chord, lay the same harmony out in strings, woodwind and brass side by side.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. III, "C. Combination of the three groups", p. 95 · calls: `ending`
- **`orchestration.calm-accompaniment`**: Under a melody laden with ornament, keep the accompaniment rhythmically calm, so that the contrast displays the melody better.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XXX, § 132, p. 128 · calls: `phrase_judge`
- **`orchestration.piano-role`**: Use piano for clear attacks and intimacy: let it state a theme alone or over soft strings, then move to arpeggios, bass octaves or rhythmic chords once strings take the melody.  
  **own** (no book source) · calls: `orchestration`
- **`orchestration.three-layers`**: Keep at most three layers at once: one melody, one moving inner figure, one sustained bass or chord bed. When a new idea enters, remove or simplify another.  
  **own** (no book source) · calls: `orchestration`
- **`orchestration.electronic-layers`**: Give a sub bass only chord roots in long notes with nothing else below it; let a pad hold the harmony when strings carry melody; keep plucks and noise short and sparse.  
  **own** (no book source) · calls: `orchestration`

## Dynamics and pacing (17)

- **`dynamics_pacing.crescendo-order`**: Build a long crescendo by adding groups in the order strings, woodwind, brass; make a long diminuendo by removing them in the reverse order: brass, woodwind, strings.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Crescendo and diminuendo", p. 112 · calls: `orchestration`
- **`dynamics_pacing.crown-and-fade`**: Let the brass crown a crescendo with a brilliant accented climax; use clarinets when the sound must fade away to a breath.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Crescendo and diminuendo", p. 112 · calls: `ending`
- **`dynamics_pacing.score-by-role`**: Score each passage according to its role: decide whether it complements or contrasts with what comes before and after, and whether it is a climax or only a step on the way.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Different ways of orchestrating the same music", p. 98 · calls: `plan`
- **`dynamics_pacing.no-medium-start-end`**: Do not begin or end a piece at a medium dynamic, whether moderately loud or moderately soft; it sounds colourless.  
  Rimsky-Korsakov, *Principles of Orchestration*, Ch. IV, "Economy in orchestral colour", p. 118 · calls: `setup`, `ending`
- **`dynamics_pacing.dynamic-change-meaning`**: Crescendo and diminuendo convey growing and fading emphasis of feeling; sudden loud or soft changes mark swift, violent impulses and can be reinforced by a simultaneous wide leap or change of register.  
  Goetschius, *Exercises in Melody-Writing*, par. 129d-e, p. 122 · calls: `plan`
- **`dynamics_pacing.final-pause`**: At the end of a piece, strengthen the repose of the full cadence by pausing on the last chord, or by repeating the final chord once or more.  
  Prout, *Musical Form*, § 222, p. 102 · calls: `ending`, `hold`
- **`dynamics_pacing.rest-as-pause`**: A bar's rest after a phrase works like a pause on its last note: the listener's mind carries the preceding harmony on through the silence.  
  Prout, *Musical Form*, § 263, p. 122 · calls: `hold`
- **`dynamics_pacing.coda-shrinking-cadences`**: A coda may consist of repeated and extended cadences formed from the opening bars of the main theme, the cadences arriving at shorter and shorter distances as they repeat.  
  Prout, *Musical Form*, § 373, p. 204 · calls: `ending`
- **`dynamics_pacing.tonic-pedal-ending`**: A movement may end with a few bars of repeated cadences over a tonic pedal.  
  Prout, *Musical Form*, § 377, p. 212 · calls: `ending`
- **`dynamics_pacing.climax-placement`**: Place the main climax about two-thirds to three-quarters of the way through, and make the highest melody note, the loudest dynamic and the fullest scoring arrive together there.  
  **own** (no book source) · calls: `plan`
- **`dynamics_pacing.one-main-peak`**: Plan one main peak. Keep every earlier peak clearly lower, each a little higher than the last; peaks of equal height cancel one another.  
  **own** (no book source) · calls: `plan`
- **`dynamics_pacing.lull-before-peak`**: Before the biggest moment, pull back: thin the texture, drop the dynamic, or stop completely for a beat or two, so the arrival lands against near-silence.  
  **own** (no book source) · calls: `plan`, `hold`
- **`dynamics_pacing.quiet-start`**: Begin quieter and thinner than seems necessary, with one or two instruments, so that every later addition is heard as growth.  
  **own** (no book source) · calls: `setup`
- **`dynamics_pacing.after-climax`**: After the main climax do not rebuild: let loudness, register and texture fall away, and make the descent shorter than the climb.  
  **own** (no book source) · calls: `plan`, `ending`
- **`dynamics_pacing.ending-choices`**: Decide early how the piece ends: by arrival (loud, full, held tonic) or by dissolving (a melody fragment fading over a held chord or pedal), and prepare that ending from the climax onward.  
  **own** (no book source) · calls: `plan`, `ending`
- **`dynamics_pacing.open-ending`**: To leave a piece unresolved or bittersweet, end on a held colour chord or on the dominant, or keep the keynote out of the top voice, instead of a full close.  
  **own** (no book source) · calls: `ending`
- **`dynamics_pacing.hold-the-unstable`**: Hold a note or chord longest when it is unstable and its resolution is expected; keep holds on stable chords short in mid-piece, or the music stalls.  
  **own** (no book source) · calls: `hold`

## Form (10)

- **`form.double-period`**: Sixteen-bar plan in four phrases: end phrase 1 with a light half cadence in the home key and phrase 2 with a perfect cadence in a near key, best the dominant (major) or relative (minor).  
  Goetschius, *Exercises in Melody-Writing*, par. 97-98, p. 72 · calls: `plan`
- **`form.begin-consonant-close-cadence`**: Begin a piece with a consonant chord in root position, and close it with the full extended cadence unless the last notes of the melody rule that out.  
  Tchaikovsky, *Guide to the Practical Study of Harmony*, Ch. XVII, § 49, p. 57 · calls: `ending`
- **`form.intro-bars`**: A piece may begin with one or two bars that only set up the rhythmic figure or accompaniment pattern before the melody enters; these bars stand outside the first phrase.  
  Prout, *Musical Form*, § 265, p. 123 · calls: `setup`
- **`form.episode-must-contrast`**: The middle part of a three-part form must be a true episode: a subject distinct from the principal one and more or less strongly contrasted with it, not merely a continuation of it.  
  Prout, *Musical Form*, § 350, p. 184 · calls: `plan`
- **`form.coda-optional`**: A coda is optional: a concluding tail-piece after the return of the first part, which may be built from subjects already heard but need not be.  
  Prout, *Musical Form*, § 352, p. 185 · calls: `ending`
- **`form.middle-change-mode`**: A very common contrast for the middle episode: keep the same tonic as the principal subject but change the mode, major for minor or the reverse.  
  Prout, *Musical Form*, § 358, p. 192 · calls: `setup`
- **`form.middle-tempo-metre`**: For stronger contrast the middle part may change tempo and metre as well as key, for example a fast, agitated middle between slow outer parts, or a slow trio in a fast scherzo.  
  Prout, *Musical Form*, § 398, p. 242 · calls: `setup`
- **`form.ternary-plan`**: Three-part plan: first a short two-part piece ending in the tonic; then a contrasted episode in another key on new subjects; then the first part again, whole or shortened, plain or varied; optionally a coda.  
  Prout, *Musical Form*, § 400, p. 243 · calls: `setup`, `plan`
- **`form.arc`**: For a piece that must keep developing, use one arc instead of sectional repeats: quiet statement, growth through varied restatements, climax, then a short afterglow recalling the opening.  
  **own** (no book source) · calls: `setup`, `plan`
- **`form.key-change-as-event`**: Treat a key change as a structural event: move up a step or a third to lift a restatement of the theme, or to the flat side or the minor to darken it.  
  **own** (no book source) · calls: `plan`
