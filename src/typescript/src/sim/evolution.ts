import { layerSizes, randomGenome } from "./brain.ts";
import type { SimConfig } from "./config.ts";
import { runEpisode } from "./episode.ts";
import { nextGeneration } from "./ga.ts";
import { createRng, deriveSeed } from "./rng.ts";
import type { GenerationResult, Genome } from "./types.ts";

export class Evolution {
  generation = 0;
  population: Genome[];
  bestEver = 0;

  private readonly config: SimConfig;

  constructor(config: SimConfig) {
    this.config = config;
    const sizes = layerSizes(config);
    const rng = createRng(deriveSeed(config.seed, 0xbeef));
    this.population = [];
    for (let i = 0; i < config.population.size; i++) this.population.push(randomGenome(sizes, rng));
  }

  layoutSeedFor(generation: number): number {
    return deriveSeed(this.config.seed, generation);
  }

  runGeneration(): { result: GenerationResult; genomes: Genome[] } {
    const generation = this.generation;
    const layoutSeed = this.layoutSeedFor(generation);
    const genomes = this.population;
    const fitness = new Float64Array(genomes.length);
    let bestIndex = 0;
    let sum = 0;
    for (let i = 0; i < genomes.length; i++) {
      fitness[i] = runEpisode(this.config, genomes[i], layoutSeed, i);
      sum += fitness[i];
      if (fitness[i] > fitness[bestIndex]) bestIndex = i;
    }
    const bestFitness = genomes.length ? fitness[bestIndex] : 0;
    const result: GenerationResult = {
      generation,
      layoutSeed,
      fitness,
      bestIndex,
      bestFitness,
      meanFitness: genomes.length ? sum / genomes.length : 0,
    };
    if (bestFitness > this.bestEver) this.bestEver = bestFitness;
    this.population = nextGeneration(genomes, fitness, this.config.ga, createRng(deriveSeed(this.config.seed, generation, 7)));
    this.generation = generation + 1;
    return { result, genomes };
  }
}
