import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Episode } from "../../src/typescript/src/sim/episode.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";

const withLife = (size: number, maxLifeSeconds: number): SimConfig => ({
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds },
  population: { size },
});
const cfg = withLife(20, 10);

describe("Evolution", () => {
  it("runs a generation and breeds the next", async () => {
    const evo = new Evolution(cfg);
    const first = evo.population;
    const { result, population } = await evo.runGeneration();
    expect(result.generation).toBe(0);
    expect(population).toBe(first);
    expect(evo.population).not.toBe(first);
    expect(result.fitness.length).toBe(20);
    expect(evo.generation).toBe(1);
    expect(evo.population.size).toBe(20);
    expect(evo.population.genomeLength).toBe(first.genomeLength);
    expect(evo.bestEver).toBeGreaterThanOrEqual(result.bestFitness);
    expect(result.bestFitness).toBe(result.fitness[result.bestIndex]);
  });

  it("replays a creature to the same fitness", async () => {
    const small = withLife(6, 3);
    const evo = new Evolution(small);
    const { result, population } = await evo.runGeneration();
    for (const i of [0, 2, 5]) {
      const ep = new Episode(small, population.genome(i), result.layoutSeed, i);
      while (!ep.done) ep.step();
      expect(ep.fitness()).toBe(result.fitness[i]);
    }
  });

  it.each([0, 1])("evolves deterministically with memory %s and sizes genomes by it", async (memory) => {
    const config: SimConfig = { ...cfg, brain: { ...cfg.brain, memory } };
    const run = async () => {
      const evo = new Evolution(config);
      const fitness: number[] = [];
      for (let g = 0; g < 3; g++) fitness.push(...(await evo.runGeneration()).result.fitness);
      return { fitness, genomeLength: evo.population.genomeLength };
    };
    const a = await run();
    expect(a).toEqual(await run());
    expect(a.fitness.every((f) => Number.isFinite(f) && f > 0)).toBe(true);
    expect(a.genomeLength).toBe(genomeLength(layerSizes(config)));
  });

  it("times one default generation", async () => {
    const evo = new Evolution(DEFAULT_CONFIG);
    const t0 = performance.now();
    await evo.runGeneration();
    console.log(`default generation: ${(performance.now() - t0).toFixed(0)} ms`);
  }, 120_000);
});
