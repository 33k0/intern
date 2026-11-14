// Rough reading of the prompt, used ONLY to shape the local stand-in's priors.
// The real Drex reads the prompt itself from the state; none of this is sent to it.

import { clamp, hashString } from './rng.ts';

export interface Mood {
  /** -1 sad … +1 happy */
  valence: number;
  /** 0 still … 1 frantic */
  energy: number;
  /** 0 light … 1 dark */
  darkness: number;
  playful: number;
  electronic: number;
  /** 0 intimate … 1 epic */
  size: number;
  water: number;
  hash: number;
}

type Axis = Exclude<keyof Mood, 'hash'>;

const LEXICON: [RegExp, Partial<Record<Axis, number>>][] = [
  [/sad|sorrow|grief|griev|mourn|loss|lost|lonely|alone|miss(ing)?|goodbye|farewell|tears?|cry|heartbreak|melanchol|regret|bittersweet|nostalg|longing|yearn|wistful|rain/, { valence: -0.6, energy: -0.15, size: 0.1 }],
  [/happy|joy|cheer|bright|sunny|sunrise|morning|celebrat|party|smile|laugh|delight|hope|wonder|spring|summer/, { valence: 0.6, energy: 0.15 }],
  [/dark|shadow|night|midnight|3 ?am|ominous|sinister|dread|fear|horror|haunt|ghost|grave|doom|storm|war|battle|boss|villain|menac|death|dying|abyss|void/, { darkness: 0.6, valence: -0.25 }],
  [/calm|quiet|still|gentle|soft|peace|serene|sleep|dream|lullaby|slow|drift|float|frozen|snow|mist|fog|dawn|meditat|tender/, { energy: -0.4, size: -0.15 }],
  [/fast|run|chase|race|rush|frantic|urgent|driv|pound|fight|battle|boss|action|explosi|energetic|hyper|sprint|wild/, { energy: 0.55 }],
  [/danc|club|rave|neon|arcade|cyber|synth|electr|techno|house|beat|bass|robot|machine|digital|glitch|future|laser|disco|drum|trap|808|video ?game/, { electronic: 0.7, energy: 0.25 }],
  [/play|playful|silly|funny|absurd|goofy|bounc|skip|cartoon|kitten|puppy|child|kid|toy|circus|clown|mischie|whims|quirky|pineapple|learning to|tiptoe|sneak/, { playful: 0.75, valence: 0.3, energy: 0.1 }],
  [/epic|huge|vast|grand|triumph|hero|victor|soar|mountain|cathedral|orchestra|cinematic|overwhelm|climax|glory|ascend|majest|galaxy|space|universe/, { size: 0.6, energy: 0.15 }],
  [/small|intimate|alone|solo|whisper|room|letter|memory|candle|close/, { size: -0.4 }],
  [/water|pool|ocean|sea|wave|river|lake|rain|underwater|swim|tide|drown|submerge|shore|beach/, { water: 0.8 }],
  [/love|kiss|embrace|romance|wedding|heart/, { valence: 0.2, size: 0.15, energy: -0.1 }],
];

export function readMood(prompt: string): Mood {
  const text = prompt.toLowerCase();
  const m: Mood = { valence: 0, energy: 0.45, darkness: 0.2, playful: 0, electronic: 0, size: 0.45, water: 0, hash: hashString(text) };
  for (const [re, delta] of LEXICON) {
    if (re.test(text)) {
      for (const [axis, d] of Object.entries(delta) as [Axis, number][]) m[axis] += d;
    }
  }
  m.valence = clamp(m.valence, -1, 1);
  for (const axis of ['energy', 'darkness', 'playful', 'electronic', 'size', 'water'] as const) m[axis] = clamp(m[axis], 0, 1);
  if (m.valence < -0.2) m.darkness = clamp(m.darkness + 0.15, 0, 1);
  return m;
}

/** Deterministic small jitter in [-1, 1] tied to the prompt, so different prompts break ties differently. */
export function promptJitter(mood: Mood, salt: string): number {
  return ((hashString(`${mood.hash}:${salt}`) % 2001) - 1000) / 1000;
}
