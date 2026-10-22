import { createRng } from "../rng.ts";

// Statistics for rlProof: paired differences and curve slopes over training runs x held-out seeds, with bootstrap 95% intervals.
// Runs and seeds are crossed (every run plays the same held-out seeds), so a bootstrap draw resamples runs and seeds, the seed draw shared by the runs.

export interface Interval {
  mean: number;
  lo: number; // 2.5% bootstrap quantile
  hi: number; // 97.5%
}

export const mean = (x: readonly number[]): number => x.reduce((a, b) => a + b, 0) / x.length;

// Least-squares slope of y on x.
export function slope(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    den += (x[i]! - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

// q-quantile of sorted values, linear between neighbours.
export function quantile(sorted: readonly number[], q: number): number {
  const at = q * (sorted.length - 1);
  const i = Math.floor(at);
  return i + 1 < sorted.length ? sorted[i]! + (at - i) * (sorted[i + 1]! - sorted[i]!) : sorted[i]!;
}

// stat(runs, seeds) on the data and on `reps` draws of runs and seeds with replacement. One run: only seeds are drawn.
export function crossedBootstrap(nRuns: number, nSeeds: number, stat: (runs: readonly number[], seeds: readonly number[]) => number, reps = 2000, seed = 1): Interval {
  const rng = createRng(seed);
  const all = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
  const draw = (n: number): number[] => Array.from({ length: n }, () => rng.int(n));
  const values: number[] = [];
  for (let r = 0; r < reps; r++) values.push(stat(nRuns > 1 ? draw(nRuns) : all(nRuns), draw(nSeeds)));
  values.sort((a, b) => a - b);
  return { mean: stat(all(nRuns), all(nSeeds)), lo: quantile(values, 0.025), hi: quantile(values, 0.975) };
}

// Mean of a[run][seed] - b[run][seed] (b may be one row shared by all runs, as a fixed baseline).
export function pairedDiff(a: readonly (readonly number[])[], b: readonly (readonly number[])[], reps = 2000, seed = 1): Interval {
  const row = (r: number): readonly number[] => b[b.length === 1 ? 0 : r]!;
  return crossedBootstrap(a.length, a[0]!.length, (runs, seeds) => {
    let sum = 0;
    for (const r of runs) for (const s of seeds) sum += a[r]![s]! - row(r)[s]!;
    return sum / (runs.length * seeds.length);
  }, reps, seed);
}

// Slope over x of the mean curve, curves[run][check][seed].
export function curveSlope(curves: readonly (readonly (readonly number[])[])[], x: readonly number[], reps = 2000, seed = 1): Interval {
  return crossedBootstrap(curves.length, curves[0]![0]!.length, (runs, seeds) => {
    const y = x.map((_, c) => {
      let sum = 0;
      for (const r of runs) for (const s of seeds) sum += curves[r]![c]![s]!;
      return sum / (runs.length * seeds.length);
    });
    return slope(x, y);
  }, reps, seed);
}
