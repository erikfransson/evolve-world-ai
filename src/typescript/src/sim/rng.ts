import type { Rng } from "./types.ts";

// mulberry32: small, fast, seedable 32-bit generator.
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    normal: () => {
      // 1 - next() lies in (0, 1], so log never sees 0.
      const u1 = 1 - next();
      const u2 = next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

// murmur3 finalizer: avalanches all bits of a 32-bit value.
function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

// Folds parts in order, so (1, 2) and (2, 1) hash differently.
export function deriveSeed(...parts: number[]): number {
  let h = 0x12345678;
  for (const part of parts) {
    h = mix32((h ^ mix32((part >>> 0) + 0x9e3779b9)) + 0x7f4a7c15);
  }
  return h >>> 0;
}
