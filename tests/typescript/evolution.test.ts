import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Episode } from "../../src/typescript/src/sim/episode.ts";
import { SerialEvaluator } from "../../src/typescript/src/sim/evaluator.ts";
import type { Evaluator } from "../../src/typescript/src/sim/evaluator.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import type { Population } from "../../src/typescript/src/sim/population.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";

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

  // Generation 3 gets a hopeless layout: everyone scores about the same tiny value, so ranking by it loses the best genomes.
  it.each([[5, true], [0, false]])("with hallOfFame %s, the best genome survives a hopeless generation: %s", async (hallOfFame, survives) => {
    const config: SimConfig = { ...withLife(40, 10), ga: { ...DEFAULT_CONFIG.ga, hallOfFame } };
    const serial = new SerialEvaluator(config);
    let generation = 0;
    const hopeless: Evaluator = {
      async evaluate(population, layoutSeed, record) {
        if (generation++ !== 3) return serial.evaluate(population, layoutSeed, record);
        const rng = createRng(11);
        return { fitness: Float64Array.from({ length: population.size }, () => 0.1 + 0.001 * rng.next()) };
      },
      close() {},
    };
    const has = (population: Population, genome: Float32Array) =>
      Array.from({ length: population.size }, (_, i) => population.genome(i)).some((g) => g.every((v, k) => v === genome[k]));
    const evo = new Evolution(config);
    let best: { genome: Float32Array; fitness: number } = { genome: new Float32Array(0), fitness: -Infinity };
    for (let g = 0; g < 3; g++) {
      const { result, population } = await evo.runGeneration(hopeless);
      if (result.bestFitness > best.fitness) best = { genome: population.genome(result.bestIndex).slice(), fitness: result.bestFitness };
    }
    expect(best.fitness).toBeGreaterThan(1);
    const seen: boolean[] = [];
    for (let g = 3; g < 6; g++) {
      const { population } = await evo.runGeneration(hopeless);
      seen.push(has(population, best.genome));
    }
    seen.push(has(evo.population, best.genome));
    expect(seen.slice(1)).toEqual([survives, survives, survives]); // generations 4, 5 and the next population
    expect(evo.hall.length).toBe(hallOfFame);
    if (survives) expect(evo.hall.some((e) => e.fitness === best.fitness)).toBe(true);
  });
});
