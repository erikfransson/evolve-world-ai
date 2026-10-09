import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Episode } from "../../src/typescript/src/sim/episode.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";

const cfg: SimConfig = { ...DEFAULT_CONFIG, population: { size: 20, epochSeconds: 10 } };

describe("Evolution", () => {
  it("runs a generation and breeds the next", () => {
    const evo = new Evolution(cfg);
    const first = evo.population;
    const { result, genomes } = evo.runGeneration();
    expect(result.generation).toBe(0);
    expect(genomes).toBe(first);
    expect(result.fitness.length).toBe(20);
    expect(evo.generation).toBe(1);
    expect(evo.population.length).toBe(20);
    expect(evo.bestEver).toBeGreaterThanOrEqual(result.bestFitness);
    expect(result.bestFitness).toBe(result.fitness[result.bestIndex]);
  });

  it("replays a creature to the same fitness", () => {
    const small: SimConfig = { ...cfg, population: { size: 6, epochSeconds: 3 } };
    const evo = new Evolution(small);
    const { result, genomes } = evo.runGeneration();
    for (const i of [0, 2, 5]) {
      const ep = new Episode(small, genomes[i]!, result.layoutSeed, i);
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
