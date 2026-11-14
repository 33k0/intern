// Small seeded random source so a run can be repeated from its seed.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Draw one key from a probability map. */
export function sampleFrom(probabilities: Record<string, number>, rng: Rng): string {
  const keys = Object.keys(probabilities);
  let total = 0;
  for (const k of keys) total += Math.max(0, probabilities[k]);
  if (total <= 0) return keys[Math.floor(rng() * keys.length)];
  let x = rng() * total;
  for (const k of keys) {
    x -= Math.max(0, probabilities[k]);
    if (x <= 0) return k;
  }
  return keys[keys.length - 1];
}

export function topOf(probabilities: Record<string, number>): string {
  let best = '';
  let bestP = -Infinity;
  for (const [k, p] of Object.entries(probabilities)) {
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}

export function shuffled<T>(items: T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const mod = (n: number, m: number) => ((n % m) + m) % m;
