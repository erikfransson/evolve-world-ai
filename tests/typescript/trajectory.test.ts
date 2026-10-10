import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Episode } from "../../src/typescript/src/sim/episode.ts";
import { SerialEvaluator } from "../../src/typescript/src/sim/evaluator.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { FRAME_FLOATS, planRecording } from "../../src/typescript/src/sim/trajectory.ts";
import { Replay } from "../../src/typescript/src/ui/replay.ts";
import { createNodeEvaluator } from "../../src/typescript/src/worker/nodePool.ts";
import type { GenerationMessage } from "../../src/typescript/src/worker/protocol.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 10 },
  population: { size: 20 },
};
const SEED = 5;

async function generation() {
  const population = new Evolution(cfg).population;
  const fitness = await new SerialEvaluator(cfg).evaluate(population, SEED);
  let bestIndex = 0;
  for (let i = 0; i < fitness.length; i++) if (fitness[i]! > fitness[bestIndex]!) bestIndex = i;
  return { population, fitness, bestIndex };
}

describe("trajectory recording", () => {
  it("plans the fittest creatures without the best, with room for every frame", async () => {
    const { population, fitness, bestIndex } = await generation();
    const plan = planRecording(fitness, bestIndex, cfg.dt, 5);
    expect(plan.indices.length).toBe(5);
    expect(plan.indices).not.toContain(bestIndex);
    for (let k = 1; k < 5; k++) expect(fitness[plan.indices[k - 1]!]).toBeGreaterThanOrEqual(fitness[plan.indices[k]!]!);
    const frames = await new SerialEvaluator(cfg).record(population, SEED, plan);
    expect(frames.length).toBe(plan.offsets[5]! * FRAME_FLOATS);
  });

  it("stores the state after each step and holds the last frame", async () => {
    const { population, fitness, bestIndex } = await generation();
    const plan = planRecording(fitness, bestIndex, cfg.dt, 4);
    const frames = await new SerialEvaluator(cfg).record(population, SEED, plan);
    for (let k = 0; k < 4; k++) {
      const index = plan.indices[k]!;
      const ep = new Episode(cfg, population.genome(index), SEED, index);
      const first = plan.offsets[k]!;
      const last = plan.offsets[k + 1]! - 1;
      for (let f = 0; f <= last - first; f++) {
        const at = (first + f) * FRAME_FLOATS;
        expect(Array.from(frames.subarray(at, at + FRAME_FLOATS))).toEqual(
          Array.from(Float32Array.of(ep.state.x, ep.state.y, ep.state.heading, ep.state.energy)),
        );
        ep.step();
      }
      expect(ep.done).toBe(true);
    }
  });

  it("gives the same frames from the worker pool as from the serial evaluator", async () => {
    const { population, fitness, bestIndex } = await generation();
    const plan = planRecording(fitness, bestIndex, cfg.dt);
    const pool = createNodeEvaluator(cfg, 3);
    try {
      const a = await new SerialEvaluator(cfg).record(population, SEED, plan);
      const b = await pool.record(population, SEED, plan);
      expect(Array.from(b)).toEqual(Array.from(a));
    } finally {
      pool.close();
    }
  }, 60_000);
});

describe("replay playback", () => {
  it("places the others where a live episode would be", async () => {
    const { population, fitness, bestIndex } = await generation();
    const plan = planRecording(fitness, bestIndex, cfg.dt);
    const data = await new SerialEvaluator(cfg).record(population, SEED, plan);
    const msg = {
      type: "generation",
      result: { generation: 0, layoutSeed: SEED, fitness, bestIndex, bestFitness: fitness[bestIndex]!, meanFitness: 0 },
      bestEver: 0,
      genomes: population.data,
      genomeLength: population.genomeLength,
      populationSize: population.size,
      trajectories: { offsets: plan.offsets, data },
    } satisfies GenerationMessage;
    const replay = new Replay();
    replay.load(msg, cfg);
    expect(replay.others.length).toBe(population.size - 1);
    const live = replay.others.map((_, k) => new Episode(cfg, population.genome(plan.indices[k]!), SEED, plan.indices[k]!));
    for (const ticks of [0, 7, 26, 967]) { // increments between checks
      replay.advance(ticks, Infinity);
      for (let t = 0; t < ticks; t++) live.forEach((ep) => ep.step());
      replay.others.forEach((o, k) => {
        expect(o.x).toBeCloseTo(live[k]!.state.x, 3);
        expect(o.heading).toBeCloseTo(live[k]!.state.heading, 3);
        expect(o.energy).toBeCloseTo(live[k]!.state.energy, 3);
        expect(o.alive).toBe(live[k]!.state.alive);
      });
    }
  });
});
