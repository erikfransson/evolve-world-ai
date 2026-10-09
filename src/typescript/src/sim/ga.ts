import type { SelectionMethod, SimConfig } from "./config.ts";
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
  tournament: (fitness, order, ga, rng) => {
    const n = order.length;
    const k = Math.max(1, Math.round(ga.tournamentSize));
    return () => {
      let best = rng.int(n);
      for (let j = 1; j < k; j++) {
        const c = rng.int(n);
        if (fitness[c] > fitness[best]) best = c;
      }
      return best;
    };
  },
};

export function nextGeneration(
  population: readonly Genome[],
  fitness: ArrayLike<number>,
  ga: GaConfig,
  rng: Rng,
): Genome[] {
  const n = population.length;
  if (n === 0) return [];
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => fitness[b] - fitness[a]);

  let eliteCount = Math.min(n, Math.round(ga.eliteFraction * n));
  if (ga.eliteFraction > 0) eliteCount = Math.max(1, eliteCount);

  const next: Genome[] = [];
  for (let i = 0; i < eliteCount; i++) next.push(new Float32Array(population[order[i]]));

  const pick = SELECTION_PICKERS[ga.selection](fitness, order, ga, rng);
  while (next.length < n) {
    const a = population[pick()];
    const child = new Float32Array(a);
    if (ga.crossover) {
      const b = population[pick()];
      for (let g = 0; g < child.length; g++) if (rng.next() < 0.5) child[g] = b[g];
    }
    for (let g = 0; g < child.length; g++) {
      if (rng.next() < ga.mutationRate) child[g] += rng.normal() * ga.mutationStd;
    }
    next.push(child);
  }
  return next;
}
