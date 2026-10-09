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
  it("runs a generation and breeds the next", () => {
    const evo = new Evolution(cfg);
    const first = evo.population;
    const { result, population } = evo.runGeneration();
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

  it("replays a creature to the same fitness", () => {
    const small = withLife(6, 3);
    const evo = new Evolution(small);
    const { result, population } = evo.runGeneration();
    for (const i of [0, 2, 5]) {
      const ep = new Episode(small, population.genome(i), result.layoutSeed, i);
      while (!ep.done) ep.step();
      expect(ep.fitness()).toBe(result.fitness[i]);
    }
  });

  it("times one default generation", () => {
    const evo = new Evolution(DEFAULT_CONFIG);
    const t0 = performance.now();
    evo.runGeneration();
    console.log(`default generation: ${(performance.now() - t0).toFixed(0)} ms`);
  }, 120_000);
});
