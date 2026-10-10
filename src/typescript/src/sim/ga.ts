import type { SelectionMethod, SimConfig } from "./config.ts";
import { Population } from "./population.ts";
import type { StatefulRng } from "./rng.ts";
import type { Genome, Rng } from "./types.ts";

type GaConfig = SimConfig["ga"];

// Returns a function that draws one parent index per call.
type PickerFactory = (
  fitness: ArrayLike<number>,
  order: number[],
  ga: GaConfig,
  rng: Rng,
) => () => number;

export const SELECTION_PICKERS: Record<SelectionMethod, PickerFactory> = {
  truncation: (fitness, order, ga, rng) => {
    const n = order.length;
    const top = Math.min(n, Math.max(1, Math.round(ga.parentFraction * n)));
    return () => order[rng.int(top)];
  },
  proportional: (fitness, order, _ga, rng) => {
    const n = order.length;
    let min = Infinity;
    for (let i = 0; i < n; i++) min = Math.min(min, fitness[i]);
    const cumulative = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += fitness[i] - min + 1e-9;
      cumulative[i] = total;
    }
    return () => {
      const r = rng.next() * total;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] > r) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
  },
};

export function nextGeneration(
  population: Population,
  fitness: ArrayLike<number>,
  ga: GaConfig,
  rng: StatefulRng,
): Population {
  const n = population.size;
  const next = new Population(n, population.genomeLength);
  if (n === 0) return next;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => fitness[b] - fitness[a]);

  let eliteCount = Math.min(n, Math.round(ga.eliteFraction * n));
  if (ga.eliteFraction > 0) eliteCount = Math.max(1, eliteCount);

  for (let i = 0; i < eliteCount; i++) next.genome(i).set(population.genome(order[i]));

  const pick = SELECTION_PICKERS[ga.selection](fitness, order, ga, rng);
  const length = population.genomeLength;
  for (let i = eliteCount; i < n; i++) {
    const child = next.genome(i);
    child.set(population.genome(pick()));
    if (ga.crossover) {
      const b = population.genome(pick());
      let s = rng.state; // rng's mulberry32 stream, run inline for speed
      for (let g = 0; g < length; g++) {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        if (((t ^ (t >>> 14)) >>> 0) < 0x80000000) child[g] = b[g];
      }
      rng.state = s;
    }
    mutate(child, ga, rng);
  }
  return next;
}

// Adds mutationStd normal noise to each gene with probability mutationRate, drawing from rng exactly as rng.next() calls would.
export function mutate(child: Genome, ga: Pick<GaConfig, "mutationRate" | "mutationStd">, rng: StatefulRng): void {
  const mutateBelow = ga.mutationRate * 4294967296; // next() < rate is next32 < rate * 2^32, exactly
  let s = rng.state; // rng's mulberry32 stream, run inline for speed; synced around normal()
  for (let g = 0; g < child.length; g++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    if (((t ^ (t >>> 14)) >>> 0) < mutateBelow) {
      rng.state = s;
      child[g] += rng.normal() * ga.mutationStd;
      s = rng.state;
    }
  }
  rng.state = s;
}
