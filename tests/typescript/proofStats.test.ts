import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { crossedBootstrap, curveSlope, pairedDiff, quantile, slope } from "../../src/typescript/src/sim/rl/proofStats.ts";

describe("proofStats", () => {
  it("slope and quantile", () => {
    expect(slope([0, 1, 2, 3], [1, 3, 5, 7])).toBeCloseTo(2);
    expect(slope([1, 1], [0, 5])).toBe(0);
    expect(quantile([0, 10, 20], 0.25)).toBeCloseTo(5);
    expect(quantile([0, 10, 20], 1)).toBe(20);
  });

  it("paired difference: a shift shows up, its interval excludes 0, and pairing removes the seed noise", () => {
    const rng = createRng(3);
    const base = Array.from({ length: 64 }, () => 5 * rng.normal()); // big seed-to-seed spread
    const better = base.map((v) => v + 0.3 + 0.1 * rng.normal());
    const d = pairedDiff([better], [base], 1000);
    expect(d.mean).toBeCloseTo(0.3, 1);
    expect(d.lo).toBeGreaterThan(0.2);
    expect(d.hi).toBeLessThan(0.4);
    const same = pairedDiff([base.map((v, i) => v + (i % 2 ? 0.1 : -0.1))], [base], 1000);
    expect(same.lo).toBeLessThan(0);
    expect(same.hi).toBeGreaterThan(0);
  });

  it("a shared baseline row serves every run, and run-to-run spread widens the interval", () => {
    const base = Array.from({ length: 32 }, (_, s) => s % 5);
    const steady = [1, 1, 1].map((g) => base.map((v) => v + g));
    const spread = [-1, 1, 3].map((g) => base.map((v) => v + g));
    const a = pairedDiff(steady, [base], 1000);
    const b = pairedDiff(spread, [base], 1000);
    expect(a.mean).toBeCloseTo(1);
    expect(b.mean).toBeCloseTo(1);
    expect(a.hi - a.lo).toBeLessThan(1e-9);
    expect(b.lo).toBeLessThan(0);
  });

  it("curve slope: rising curves give an interval above 0, flat ones straddle it", () => {
    const rng = createRng(5);
    const curves = (gain: number) => [0, 1, 2].map(() => [0, 0.5, 1].map((x) => Array.from({ length: 64 }, () => gain * x + rng.normal())));
    const rising = curveSlope(curves(1), [0, 0.5, 1], 1000);
    expect(rising.mean).toBeGreaterThan(0.5);
    expect(rising.lo).toBeGreaterThan(0);
    const flat = curveSlope(curves(0), [0, 0.5, 1], 1000);
    expect(flat.lo).toBeLessThan(0);
    expect(flat.hi).toBeGreaterThan(0);
  });

  it("bootstrap is deterministic for a seed", () => {
    const stat = (runs: readonly number[], seeds: readonly number[]) => runs.length + seeds.reduce((a, b) => a + b, 0);
    expect(crossedBootstrap(3, 10, stat, 200, 7)).toEqual(crossedBootstrap(3, 10, stat, 200, 7));
  });
});
