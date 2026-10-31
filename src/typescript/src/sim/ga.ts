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

export interface HallEntry {
  genome: Genome;
  fitness: number; // the best score this genome reached
  generation: number; // the generation of that score
}

const sameGenome = (a: Genome, b: Genome): boolean => {
  for (let g = 0; g < a.length; g++) if (a[g] !== b[g]) return false;
  return true;
};

// Keeps hall as the `size` fittest distinct genomes seen so far, fittest first. A genome enters only by beating the last entry
// of a full hall, and a genome already in it keeps its best score. Ties keep the older entry.
export function updateHall(hall: HallEntry[], size: number, population: Population, fitness: ArrayLike<number>, generation: number): void {
  const cap = Math.min(Math.floor(size), population.size); // a hall bigger than the population would only cost memory and sorting
  if (!(cap >= 1)) {
    hall.length = 0;
    return;
  }
  if (hall.length > cap) hall.length = cap;
  for (let i = 0; i < population.size; i++) {
    const f = fitness[i];
    if (Number.isNaN(f) || (hall.length >= cap && f <= hall[hall.length - 1]!.fitness)) continue;
    const genome = population.genome(i);
    const known = hall.find((e) => sameGenome(e.genome, genome));
    if (known) {
      if (f <= known.fitness) continue;
      known.fitness = f;
      known.generation = generation;
    } else {
      hall.push({ genome: genome.slice(), fitness: f, generation });
    }
    hall.sort((a, b) => b.fitness - a.fitness);
    if (hall.length > cap) hall.length = cap;
  }
}

// Breeds the next generation: the kept genomes (the hall of fame) first, then this generation's elites that are not among them,
// then children, then fresh random immigrants (made by randomGenome) at the end.
// A stagnant generation (see isStagnant) breeds its children with STAGNATION_BOOST times the mutation std.
export function nextGeneration(
  population: Population,
  fitness: ArrayLike<number>,
  ga: GaConfig,
  rng: StatefulRng,
  randomGenome: (rng: StatefulRng) => Genome,
  keep: readonly Genome[] = [],
): Population {
  const n = population.size;
  const next = new Population(n, population.genomeLength);
  if (n === 0) return next;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => fitness[b] - fitness[a]);

  let elites = Math.min(n, Math.round(ga.eliteFraction * n));
  if (ga.eliteFraction > 0) elites = Math.max(1, elites);

  let eliteCount = Math.min(n, keep.length);
  for (let i = 0; i < eliteCount; i++) next.genome(i).set(keep[i]!);
  for (let k = 0; k < elites && eliteCount < n; k++) {
    const genome = population.genome(order[k]);
    if (keep.some((g) => sameGenome(g, genome))) continue;
    next.genome(eliteCount++).set(genome);
  }

  const immigrants = Math.min(n - eliteCount, Math.round(ga.immigrantFraction * n));
  const childEnd = n - immigrants;
  const bigEnd = Math.min(childEnd, eliteCount + Math.round(ga.bigMutationFraction * n));
  const std = ga.mutationStd * (isStagnant(fitness) ? STAGNATION_BOOST : 1);

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
        if (draw(s) < 0x80000000) child[g] = b[g];
      }
      rng.state = s;
    }
    if (i < bigEnd) bigMutate(child, rng);
    else mutate(child, ga.mutationRate, std, rng);
  }
  for (let i = childEnd; i < n; i++) next.genome(i).set(randomGenome(rng));
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

// The unsigned 32-bit draw of rng's mulberry32 stream at state s, which is already stepped by 0x6d2b79f5.
function draw(s: number): number {
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

// rng.normal() from its two draws a and b (Box-Muller; u1 = 1 - a / 2^32, u2 = b / 2^32).
function normalFrom(a: number, b: number): number {
  const u1 = 1 - (a >>> 0) / 4294967296;
  const u2 = (b >>> 0) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// WasmMembers.mutateHits: the scan of mutate in WebAssembly.
export interface MutateScan {
  mutateHits(n: number, state: number, limit: number): Int32Array;
  readonly endState: number;
}
const SCAN_MIN = 16; // genes; below this the loop is cheaper than the kernel call

// Adds mutationStd normal noise to each gene with probability mutationRate, drawing from rng exactly as rng.next() calls would.
// The scan between hits is its own tight loop (or scan's kernel), and the hit's two draws (rng.normal) run inline, so no call splits the loop.
export function mutate(child: Genome, rate: number, std: number, rng: StatefulRng, scan: MutateScan | null = null): void {
  const mutateBelow = rate * 4294967296; // next() < rate is next32 < rate * 2^32, exactly
  const n = child.length;
  if (scan && n >= SCAN_MIN && mutateBelow > 0 && mutateBelow <= 4294967295) {
    const hits = scan.mutateHits(n, rng.state, Math.ceil(mutateBelow)); // next32 < mutateBelow is next32 < ceil(mutateBelow) for an integer
    for (let k = 0; k < hits.length; k += 3) {
      child[hits[k]!] += normalFrom(hits[k + 1]!, hits[k + 2]!) * std;
    }
    rng.state = scan.endState;
    return;
  }
  let s = rng.state; // rng's mulberry32 stream, run inline for speed
  let g = 0;
  while (g < n) {
    for (; g < n; g++) {
      s = (s + 0x6d2b79f5) | 0;
      if (draw(s) < mutateBelow) break;
    }
    if (g === n) break;
    // normal(): u1 = 1 - next(), u2 = next()
    s = (s + 0x6d2b79f5) | 0;
    const a = draw(s);
    s = (s + 0x6d2b79f5) | 0;
    child[g++] += normalFrom(a, draw(s)) * std;
  }
  rng.state = s;
}
