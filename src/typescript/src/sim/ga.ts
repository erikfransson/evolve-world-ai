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

export const STAGNATION_SPREAD = 0.01; // (max - min) / mean below this counts as no selection signal
export const STAGNATION_BOOST = 3; // mutationStd factor for the children of a stagnant generation
export const BIG_MUTATION = { rate: 0.3, std: 1, flipChance: 0.25 }; // flipChance: a mutated gene flips sign instead of getting noise

// True when everyone scored (nearly) the same, so ranking carries no information.
export function isStagnant(fitness: ArrayLike<number>): boolean {
  const n = fitness.length;
  if (n < 2) return false;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    min = Math.min(min, fitness[i]);
    max = Math.max(max, fitness[i]);
    sum += fitness[i];
  }
  return max - min <= STAGNATION_SPREAD * (sum / n);
}

// Breeds the next generation: elites first, then children, then fresh random immigrants (made by randomGenome) at the end.
// A stagnant generation (see isStagnant) breeds its children with STAGNATION_BOOST times the mutation std.
export function nextGeneration(
  population: Population,
  fitness: ArrayLike<number>,
  ga: GaConfig,
  rng: StatefulRng,
  randomGenome?: (rng: StatefulRng) => Genome,
): Population {
  const n = population.size;
  const next = new Population(n, population.genomeLength);
  if (n === 0) return next;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => fitness[b] - fitness[a]);

  let eliteCount = Math.min(n, Math.round(ga.eliteFraction * n));
  if (ga.eliteFraction > 0) eliteCount = Math.max(1, eliteCount);

  for (let i = 0; i < eliteCount; i++) next.genome(i).set(population.genome(order[i]));

  const immigrants = randomGenome ? Math.min(n - eliteCount, Math.round(ga.immigrantFraction * n)) : 0;
  const childEnd = n - immigrants;
  const bigEnd = Math.min(childEnd, eliteCount + Math.round(ga.bigMutationFraction * n));
  const std = ga.mutationStd * (isStagnant(fitness) ? STAGNATION_BOOST : 1);
  const mutation = { mutationRate: ga.mutationRate, mutationStd: std };

  const pick = SELECTION_PICKERS[ga.selection](fitness, order, ga, rng);
  const length = population.genomeLength;
  for (let i = eliteCount; i < childEnd; i++) {
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
    if (i < bigEnd) bigMutate(child, rng);
    else mutate(child, mutation, rng);
  }
  for (let i = childEnd; i < n; i++) next.genome(i).set(randomGenome!(rng));
  return next;
}

// Large mutation: each gene with probability BIG_MUTATION.rate either flips sign or gets BIG_MUTATION.std noise.
export function bigMutate(child: Genome, rng: StatefulRng): void {
  for (let g = 0; g < child.length; g++) {
    if (rng.next() >= BIG_MUTATION.rate) continue;
    if (rng.next() < BIG_MUTATION.flipChance) child[g] = -child[g];
    else child[g] += rng.normal() * BIG_MUTATION.std;
  }
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
