import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { defaultThreads } from "../../src/typescript/src/worker/evalPool.ts";
import { createNodeEvaluator } from "../../src/typescript/src/worker/nodePool.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 10 },
  population: { size: 37 },
};

describe("parallel evaluation", () => {
  it("picks one fewer thread than cores, between 1 and 8", () => {
    expect(defaultThreads(1)).toBe(1);
    expect(defaultThreads(4)).toBe(3);
    expect(defaultThreads(64)).toBe(8);
  });

  it("gives bit-identical generations to the serial run", async () => {
    const serial = new Evolution(cfg);
    const parallel = new Evolution(cfg);
    const pool = createNodeEvaluator(cfg, 3);
    try {
      for (let g = 0; g < 2; g++) {
        const a = serial.runGeneration();
        const b = await parallel.runGenerationWith(pool);
        expect(Array.from(b.result.fitness)).toEqual(Array.from(a.result.fitness));
        expect(b.result.bestIndex).toBe(a.result.bestIndex);
        expect(b.result.meanFitness).toBe(a.result.meanFitness);
        expect(Array.from(parallel.population.data)).toEqual(Array.from(serial.population.data));
      }
    } finally {
      pool.close();
    }
  }, 60_000);
});
