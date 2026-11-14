// Context pack loader. Drex is weak closed-book, so the theory it needs travels in the request.
// Each call type gets only its own slice of the digest, plus the style sheet and worked examples.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallType, StyleId } from '../shared/types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = join(ROOT, 'context-pack');

interface Rule {
  id: string;
  topic: string;
  text: string;
  source: { book: string; ref: string } | null;
  calls: string[];
  /** When set, the rule is only sent for these style sheets (and goes first, so it always gets room). */
  styles?: StyleId[];
}

export interface StyleSheet {
  id: StyleId;
  name: string;
  summary: string;
  traits: string[];
  avoid?: string[];
  defaults?: Record<string, unknown>;
}

interface WorkedExample {
  call: string;
  state: string;
  choice: string;
  reason: string;
}

function readJson<T>(file: string, fallback: T): T {
  const path = join(PACK, file);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    console.warn(`[pack] could not read ${file}: ${(err as Error).message}`);
    return fallback;
  }
}

const FALLBACK_SHEETS: StyleSheet[] = [
  {
    id: 'bittersweet_orchestral', name: 'Bittersweet orchestral',
    summary: 'A slow orchestral cue for piano and strings that starts delicately and builds to one earned arrival, more often still and bright than loud.',
    traits: ['slow compound pulse (12/8 near 70 BPM)', 'minor tonal centre with key changes', 'warm two-chord opening on major-seventh and ninth chords', 'piano and strings at scale', 'quiet start to one earned arrival', 'dark late turn with chromatic chords', 'planned peaks and lulls', 'constant development, little exact repetition', 'pedal tones', 'unresolved phrase endings', 'a pause before the arrival'],
  },
  {
    id: 'beat_driven', name: 'Beat-driven',
    summary: 'Steady electronic pulse with short motif cells, builds and drops.',
    traits: ['steady 4/4 pulse', 'sub bass', 'syncopated hats', 'short motif cells', 'filter builds and drops', 'sidechain pump'],
  },
  {
    id: 'playful', name: 'Playful',
    summary: 'Light, bright and nimble, with woodwinds and plucked strings.',
    traits: ['bright modes', 'pizzicato and staccato', 'woodwinds', 'bouncing rhythms', 'sudden stops', 'quick register jumps'],
  },
];

/** Which digest slices each of the engine's calls reads. */
const SLICE: Partial<Record<CallType, { calls: string[]; topics?: string[]; max: number }>> = {
  setup: { calls: ['setup'], max: 14 },
  // Every plan-tagged rule fits: at 16 the round robin cut the peak-shaping rules (one main peak, pull back before it).
  plan: { calls: ['plan'], max: 28 },
  plan_revision: { calls: ['plan'], topics: ['scoring_to_picture', 'dynamics_pacing', 'form', 'tension_release', 'departure_return'], max: 10 },
  theme_shape: { calls: ['theme_draft'], topics: ['melody', 'phrase_structure'], max: 14 },
  theme_note: { calls: ['theme_draft'], topics: ['melody'], max: 12 },
  theme_derive: { calls: ['theme_draft', 'phrase_direction'], topics: ['developing_variation', 'melody'], max: 10 },
  theme_judge: { calls: ['theme_judge'], max: 16 },
  phrase_direction: { calls: ['phrase_direction'], topics: ['developing_variation', 'departure_return', 'phrase_structure', 'melody', 'tension_release', 'dynamics_pacing', 'harmony', 'cadences', 'form', 'scoring_to_picture'], max: 32 },
  chord_path: { calls: ['phrase_direction', 'voice_leading'], topics: ['harmony', 'cadences', 'tension_release'], max: 22 },
  voice_leading: { calls: ['voice_leading'], topics: ['voice_leading', 'harmony'], max: 12 },
  phrase_judge: { calls: ['phrase_judge'], max: 16 },
  orchestration: { calls: ['orchestration'], max: 40 },
  hold: { calls: ['hold'], max: 8 },
  ending: { calls: ['ending'], max: 10 },
  // Scoring a video. These slices are empty unless the pack has scoring-to-picture rules.
  frame_reading: { calls: ['frame_reading'], max: 4 },
  tempo: { calls: ['tempo'], max: 6 },
  fit: { calls: ['fit'], max: 8 },
  live_read: { calls: ['live_read'], max: 6 },
};

const BOOK_SHORT: Record<string, string> = {};

class Pack {
  rules: Rule[] = [];
  sheets: StyleSheet[] = FALLBACK_SHEETS;
  examples: WorkedExample[] = [];
  private cache = new Map<string, string>();

  constructor() {
    this.reload();
  }

  reload() {
    this.cache.clear();
    this.rules = readJson<{ rules: Rule[] }>('digest.json', { rules: [] }).rules ?? [];
    // Optional extra rules for scoring to picture (only the video project ships this file). They go
    // first so the per-topic round robin in theory() always gives them room.
    const picture = readJson<{ rules: Rule[] }>('scoring-to-picture.json', { rules: [] }).rules ?? [];
    // Hand-written rules for the beat-driven sheet: the four books stop in 1900 and say nothing about grooves.
    const modern = readJson<{ rules: Rule[] }>('modern.json', { rules: [] }).rules ?? [];
    this.rules = [...picture, ...modern, ...this.rules];
    const sheets = readJson<StyleSheet[] | { sheets: StyleSheet[] }>('style-sheets.json', FALLBACK_SHEETS);
    const list = Array.isArray(sheets) ? sheets : sheets.sheets;
    if (list?.length === 3) this.sheets = list;
    this.examples = readJson<{ examples: WorkedExample[] }>('worked-examples.json', { examples: [] }).examples ?? [];
    const sources = readJson<any>('books/sources.json', null);
    const books: any[] = Array.isArray(sources) ? sources : sources?.books ?? [];
    for (const b of books) {
      const slug = b.slug ?? b.id;
      // Cite by surname: "Tchaikovsky, § 11, p. 13".
      if (slug && b.author) BOOK_SHORT[slug] = String(b.author).split(',')[0].trim().split(/\s+/).pop()!;
    }
  }

  sheet(id: StyleId): StyleSheet {
    return this.sheets.find((s) => s.id === id) ?? FALLBACK_SHEETS.find((s) => s.id === id)!;
  }

  styleText(id: StyleId): string {
    const s = this.sheet(id);
    return `STYLE   ${s.name}: ${s.summary}\n        traits: ${s.traits.join('; ')}${s.avoid?.length ? `\n        avoid: ${s.avoid.join('; ')}` : ''}`;
  }

  /** The theory rules one call type is given, in the order they are sent. */
  slice(callType: CallType, style?: StyleId): Rule[] {
    const spec = SLICE[callType];
    if (!spec || !this.rules.length) return [];
    let rules = this.rules.filter((r) => r.calls.some((c) => spec.calls.includes(c)) && (!r.styles || (!!style && r.styles.includes(style))));
    if (spec.topics) {
      const order = spec.topics;
      const rank = (r: Rule) => (r.styles ? -1 : order.indexOf(r.topic));
      rules = rules
        .filter((r) => !!r.styles || order.includes(r.topic))
        .sort((a, b) => rank(a) - rank(b));
    }
    // Spread the budget across topics rather than taking the first N of one topic.
    const byTopic = new Map<string, Rule[]>();
    for (const r of rules) byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r]);
    const picked: Rule[] = [];
    for (let i = 0; picked.length < spec.max; i++) {
      let any = false;
      for (const list of byTopic.values()) {
        if (list[i] && picked.length < spec.max) {
          picked.push(list[i]);
          any = true;
        }
      }
      if (!any) break;
    }
    return picked;
  }

  /** Call types that are given theory rules. */
  sliceTypes(): CallType[] {
    return Object.keys(SLICE) as CallType[];
  }

  /** The theory slice for one call type, as a text block for the state. */
  theory(callType: CallType, style?: StyleId): string {
    const cacheKey = `${callType}:${style ?? ''}`;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) return hit;
    let text = '';
    {
      const picked = this.slice(callType, style);
      if (picked.length) {
        text =
          'THEORY  (from the context pack; follow these when choosing)\n' +
          picked
            .map((r) => `        - ${r.text}${r.source ? ` [${BOOK_SHORT[r.source.book] ?? r.source.book}, ${r.source.ref}]` : ''}`)
            .join('\n');
      }
    }
    const ex = this.examples.filter((e) => e.call === callType).slice(0, 3);
    if (ex.length) {
      text +=
        (text ? '\n' : '') +
        'WORKED EXAMPLES\n' +
        ex.map((e) => `        - Given: ${e.state} Good choice: ${e.choice}. Why: ${e.reason}`).join('\n');
    }
    this.cache.set(cacheKey, text);
    return text;
  }
}

export const pack = new Pack();
