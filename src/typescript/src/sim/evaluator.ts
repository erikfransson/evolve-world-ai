import type { SimConfig } from "./config.ts";
import { runEpisode } from "./episode.ts";
import type { Population } from "./population.ts";
import { FRAME_FLOATS, gatherGenomes, recordRange } from "./trajectory.ts";
import type { RecordPlan } from "./trajectory.ts";

// Scores a whole population for one generation. Implementations must return identical fitness for identical input.
export interface Evaluator {
  evaluate(population: Population, layoutSeed: number): Promise<Float64Array>;
  // Frames of the plan's creatures laid out by plan.offsets, for the population and seed just evaluated.
  record(population: Population, layoutSeed: number, plan: RecordPlan): Promise<Float32Array>;
  close(): void;
}

// Fitness of creatures [start, end) into out[0..end-start). The genomes buffer holds creatures from index genomeOffset on.
export function evaluateRange(
  config: SimConfig,
  genomes: Float32Array,
  genomeLength: number,
  layoutSeed: number,
  start: number,
  end: number,
  out: Float64Array,
  genomeOffset = 0,
): void {
  for (let i = start; i < end; i++) {
    const at = (i - genomeOffset) * genomeLength;
    out[i - start] = runEpisode(config, genomes.subarray(at, at + genomeLength), layoutSeed, i);
  }
}

export class SerialEvaluator implements Evaluator {
  private readonly config: SimConfig;

  constructor(config: SimConfig) {
    this.config = config;
  }

  evaluate(population: Population, layoutSeed: number): Promise<Float64Array> {
    const fitness = new Float64Array(population.size);
    evaluateRange(this.config, population.data, population.genomeLength, layoutSeed, 0, population.size, fitness);
    return Promise.resolve(fitness);
  }

  record(population: Population, layoutSeed: number, plan: RecordPlan): Promise<Float32Array> {
    const out = new Float32Array(plan.offsets[plan.indices.length]! * FRAME_FLOATS);
    const genomes = gatherGenomes(population, plan.indices);
    recordRange(this.config, genomes, population.genomeLength, layoutSeed, plan.indices, plan.offsets, out);
    return Promise.resolve(out);
  }

  close(): void {}
}
