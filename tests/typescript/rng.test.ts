import { createRng, deriveSeed } from "../../src/typescript/src/sim/rng.ts";

function take(seed: number, n: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next());
}

describe("createRng", () => {
  it("reproduces the same sequence for the same seed and differs across seeds", () => {
    expect(take(42, 50)).toEqual(take(42, 50));
    expect(take(42, 50)).not.toEqual(take(43, 50));
  });

  it("keeps next() in [0, 1) and int() in bounds", () => {
    const rng = createRng(7);
    let bad = 0;
    for (let i = 0; i < 10000; i++) {
      const u = rng.next();
      const k = rng.int(5);
      if (!(u >= 0 && u < 1) || !Number.isInteger(k) || k < 0 || k >= 5) bad++;
    }
    expect(bad).toBe(0);
  });

  it("draws standard normals with mean near 0 and std near 1", () => {
    const rng = createRng(123);
    const n = 20000;
    const xs = Array.from({ length: n }, () => rng.normal());
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(Math.sqrt(variance) - 1)).toBeLessThan(0.05);
  });
});

describe("deriveSeed", () => {
  it("is deterministic and order sensitive", () => {
    expect(deriveSeed(1, 2)).toBe(deriveSeed(1, 2));
    const seeds = new Set([deriveSeed(1, 2), deriveSeed(2, 1), deriveSeed(1, 3)]);
    expect(seeds.size).toBe(3);
  });
});
