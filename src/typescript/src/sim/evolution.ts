import { genomeLength, layerSizes, randomGenome } from "./brain.ts";
import type { SimConfig } from "./config.ts";
import { SerialEvaluator } from "./evaluator.ts";
import type { Evaluator } from "./evaluator.ts";
import { nextGeneration } from "./ga.ts";
import { Population } from "./population.ts";
import { createRng, deriveSeed } from "./rng.ts";
import type { RecordOptions, Trajectories } from "./trajectory.ts";
import type { GenerationResult } from "./types.ts";

export class Evolution {
  generation = 0;
  population: Population;
  bestEver = 0;

  private readonly config: SimConfig;
  private readonly serial: Evaluator;

  constructor(config: SimConfig) {
    this.config = config;
    this.serial = new SerialEvaluator(config);
    const sizes = layerSizes(config);
    const rng = createRng(deriveSeed(config.seed, 0xbeef));
    this.population = new Population(config.population.size, genomeLength(sizes));
    for (let i = 0; i < config.population.size; i++) this.population.genome(i).set(randomGenome(sizes, rng));
  }

  private layoutSeedFor(generation: number): number {
    return deriveSeed(this.config.seed, generation);
  }

  // Returns the evaluated population; this.population becomes its children. Pass a worker pool to evaluate in parallel.
  // With record, also returns the frames of the fittest creatures after the best.
  async runGeneration(
    evaluator: Evaluator = this.serial,
    record?: RecordOptions,
  ): Promise<{ result: GenerationResult; population: Population; frames?: Trajectories }> {
    const layoutSeed = this.layoutSeedFor(this.generation);
    const population = this.population;
    const { fitness, frames } = await evaluator.evaluate(population, layoutSeed, record);
    if (population !== this.population) throw new Error("population changed during evaluation");
    return { ...this.breed(layoutSeed, fitness), frames };
  }

  private breed(layoutSeed: number, fitness: Float64Array): { result: GenerationResult; population: Population } {
    const generation = this.generation;
    const population = this.population;
    const n = population.size;
    let bestIndex = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += fitness[i];
      if (fitness[i] > fitness[bestIndex]) bestIndex = i;
    }
    const bestFitness = n ? fitness[bestIndex] : 0;
    const result: GenerationResult = {
      generation,
      layoutSeed,
      fitness,
      bestIndex,
      bestFitness,
      meanFitness: n ? sum / n : 0,
    };
    if (bestFitness > this.bestEver) this.bestEver = bestFitness;
    this.population = nextGeneration(population, fitness, this.config.ga, createRng(deriveSeed(this.config.seed, generation, 7)));
    this.generation = generation + 1;
    return { result, population };
  }
}
