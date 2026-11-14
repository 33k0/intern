// Small deterministic PRNG so humanisation, round robin starts and grain offsets repeat run to run.

export type Rng = () => number;

/** mulberry32: 32-bit state, good enough for musical jitter. Returns floats in [0, 1). */
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

/** Mix a few integers into one 32-bit seed. */
export function hashSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** Uniform in [lo, hi). */
export function range(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Uniform in [-amount, +amount). */
export function bipolar(rng: Rng, amount: number): number {
  return (rng() * 2 - 1) * amount;
}
