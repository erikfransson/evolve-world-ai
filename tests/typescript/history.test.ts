import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { evaluateCreatures, SerialEvaluator } from "../../src/typescript/src/sim/evaluator.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { History, captureTop } from "../../src/typescript/src/sim/history.ts";
import type { PastGeneration } from "../../src/typescript/src/sim/history.ts";

function fake(generation: number, bytes = 100): PastGeneration {
  return { generation, layoutSeed: 0, genomeLength: bytes / 4, indices: new Uint32Array(0), genomes: new Float32Array(bytes / 4) };
}
const stat = (generation: number) => ({ generation, best: generation, mean: 0 });

describe("captureTop", () => {
  it("keeps the fittest first, ties to the lower index, with their genomes", () => {
    const fitness = Float64Array.from([1, 5, 3, 5, 2]);
    const genomes = Float32Array.from([10, 11, 20, 21, 30, 31, 40, 41, 50, 51]);
    const top = captureTop(7, 99, fitness, genomes, 2, 3);
    expect(Array.from(top.indices)).toEqual([1, 3, 2]);
    expect(Array.from(top.genomes)).toEqual([20, 21, 40, 41, 30, 31]);
    expect([top.generation, top.layoutSeed, top.genomeLength]).toEqual([7, 99, 2]);
  });
});

describe("History", () => {
  it("keeps everything under the cap and stats always", () => {
    const h = new History(5, 1e9);
    for (let g = 0; g < 20; g++) h.add(stat(g), fake(g));
    expect(h.keptGenerations.length).toBe(20);
    expect(h.stats.length).toBe(20);
  });

  it("thins older entries, keeps the recent window and the newest, spreads coverage", () => {
    const h = new History(5, 2000); // 20 entries of 100 bytes
    for (let g = 0; g < 200; g++) h.add(stat(g), fake(g));
    const kept = h.keptGenerations;
    expect(h.byteSize).toBeLessThanOrEqual(2000);
    expect(h.stats.length).toBe(200);
    expect(kept.slice(-5)).toEqual([195, 196, 197, 198, 199]);
    expect(kept[0]).toBe(0);
    const older = kept.slice(0, -5);
    expect(older.length).toBeGreaterThan(5);
    expect(Math.max(...older.map((g, k) => (k ? g - older[k - 1]! : 0)))).toBeLessThan(60); // no big hole in the old part
  });

  it("drops the oldest recent entries when the window alone is over the cap", () => {
    const h = new History(5, 250);
    for (let g = 0; g < 10; g++) h.add(stat(g), fake(g));
    expect(h.keptGenerations).toEqual([8, 9]);
  });

  it("finds the nearest kept generation and clears", () => {
    const h = new History(2, 400);
    for (let g = 0; g < 30; g++) h.add(stat(g), fake(g));
    const near = h.nearest(3)!;
    const kept = h.keptGenerations;
    expect(kept.every((g) => Math.abs(g - 3) >= Math.abs(near.generation - 3))).toBe(true);
    h.clear();
    expect(h.nearest(3)).toBeNull();
    expect(h.stats.length).toBe(0);
  });
});

describe("evaluateCreatures", () => {
  const cfg: SimConfig = { ...DEFAULT_CONFIG, creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 10 }, population: { size: 100 } };

  it("reproduces the original best fitness and trajectories from the kept creatures only", async () => {
    const evolution = new Evolution(cfg);
    const { result, population, frames } = await evolution.runGeneration(new SerialEvaluator(cfg), { maxOthers: 20 });
    const past = captureTop(result.generation, result.layoutSeed, result.fitness, population.data, population.genomeLength, 21);
    expect(past.indices[0]).toBe(result.bestIndex);
    const again = evaluateCreatures(cfg, past.genomes, past.genomeLength, past.layoutSeed, past.indices, { maxOthers: 20 });
    expect(again.fitness[0]).toBe(result.bestFitness);
    expect(Array.from(again.fitness)).toEqual(Array.from(past.indices, (i) => result.fitness[i]!));
    expect(Array.from(again.frames.offsets)).toEqual(Array.from(frames!.offsets));
    expect(Array.from(again.frames.data)).toEqual(Array.from(frames!.data));
  });
});
