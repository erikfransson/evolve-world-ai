import { DEFAULT_CONFIG, MAX_RUNS, runsOf } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { SerialEvaluator, evaluateCreatures, runSeed } from "../../src/typescript/src/sim/evaluator.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { FRAME_FLOATS, FrameRecorder } from "../../src/typescript/src/sim/trajectory.ts";
import { runEpisode } from "../../src/typescript/src/sim/episode.ts";

const base: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 10 },
  population: { size: 8 },
};
const withRuns = (runs: number): SimConfig => ({ ...base, population: { size: 8, runs } });

describe("runs per creature", () => {
  it("clamps to whole numbers in 1..MAX_RUNS and treats a missing value as 1", () => {
    expect(runsOf(base)).toBe(1);
    expect(runsOf(withRuns(0))).toBe(1);
    expect(runsOf(withRuns(-5))).toBe(1);
    expect(runsOf(withRuns(NaN))).toBe(1);
    expect(runsOf(withRuns(2.6))).toBe(3);
    expect(runsOf(withRuns(1000))).toBe(MAX_RUNS);
    expect(runsOf(withRuns(Infinity))).toBe(MAX_RUNS);
  });

  it("1 run gives the same fitness as a config without the field", async () => {
    const a = await new Evolution(base).runGeneration();
    const b = await new Evolution(withRuns(1)).runGeneration();
    expect(Array.from(b.result.fitness)).toEqual(Array.from(a.result.fitness));
  });

  it("run 0 uses the generation layout and the others distinct derived layouts", () => {
    expect(runSeed(123, 0)).toBe(123);
    const seeds = new Set(Array.from({ length: MAX_RUNS }, (_, r) => runSeed(123, r)));
    expect(seeds.size).toBe(MAX_RUNS);
  });

  it("fitness is the mean over the per-run layouts and is reproducible", async () => {
    const runs = 3;
    const evo = new Evolution(withRuns(runs));
    const pop = evo.population;
    const layoutSeed = 987654;
    const { fitness } = await new SerialEvaluator(withRuns(runs)).evaluate(pop, layoutSeed);
    const again = await new SerialEvaluator(withRuns(runs)).evaluate(pop, layoutSeed);
    expect(Array.from(again.fitness)).toEqual(Array.from(fitness));
    let differs = false;
    for (let i = 0; i < pop.size; i++) {
      const each = Array.from({ length: runs }, (_, r) => runEpisode(base, pop.genome(i), runSeed(layoutSeed, r), i));
      expect(fitness[i]).toBeCloseTo(each.reduce((s, v) => s + v, 0) / runs, 9);
      if (new Set(each).size > 1) differs = true;
    }
    expect(differs).toBe(true); // the layouts really differ
  });
});

describe("past-generation replay with several runs", () => {
  it("keeps the stored best-first order instead of re-ranking by run-0 scores", () => {
    const cfg = withRuns(3);
    const pop = new Evolution(cfg).population;
    const n = 6;
    const layoutSeed = 4242;
    const run0 = Array.from({ length: n }, (_, i) => runEpisode(base, pop.genome(i), layoutSeed, i));
    expect(new Set(run0).size).toBeGreaterThan(1);
    // stored order: ascending run-0 score, the opposite of what re-ranking would give
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => run0[a]! - run0[b]! || a - b);
    const genomes = new Float32Array(n * pop.genomeLength);
    order.forEach((c, k) => genomes.set(pop.genome(c), k * pop.genomeLength));
    const { frames } = evaluateCreatures(cfg, genomes, pop.genomeLength, layoutSeed, order);
    const want = order.slice(1).map((c) => {
      const rec = new FrameRecorder(1);
      runEpisode(base, pop.genome(c), layoutSeed, c, rec);
      return rec.result().data;
    });
    expect(frames.offsets.length).toBe(n);
    for (let k = 0; k < n - 1; k++) {
      const got = frames.data.subarray(frames.offsets[k]! * FRAME_FLOATS, frames.offsets[k + 1]! * FRAME_FLOATS);
      expect(Array.from(got)).toEqual(Array.from(want[k]!));
    }
  });
});
