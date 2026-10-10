import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Episode } from "../../src/typescript/src/sim/episode.ts";
import { SerialEvaluator } from "../../src/typescript/src/sim/evaluator.ts";
import type { Evaluator } from "../../src/typescript/src/sim/evaluator.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { FRAME_FLOATS, MAX_RECORDED_FRAMES, MAX_TRAJECTORIES, TopFrames } from "../../src/typescript/src/sim/trajectory.ts";
import type { RecordOptions, Trajectories } from "../../src/typescript/src/sim/trajectory.ts";
import { Replay } from "../../src/typescript/src/ui/replay.ts";
import { createNodeEvaluator } from "../../src/typescript/src/worker/nodePool.ts";
import type { GenerationMessage } from "../../src/typescript/src/worker/protocol.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 10 },
  population: { size: 150 },
};
const SEED = 3; // seed 5 puts an item on the start position, so every creature dies at once

async function generation(evaluator: Evaluator, record: RecordOptions) {
  const population = new Evolution(cfg).population;
  const { fitness, frames } = await evaluator.evaluate(population, SEED, record);
  let bestIndex = 0;
  for (let i = 0; i < fitness.length; i++) if (fitness[i]! > fitness[bestIndex]!) bestIndex = i;
  return { population, fitness, bestIndex, frames: frames! };
}

// Creatures after the best, fittest first, ties to the lower index.
function expectedTop(fitness: Float64Array, bestIndex: number, count: number): number[] {
  const order = Array.from(fitness.keys()).filter((i) => i !== bestIndex);
  order.sort((a, b) => fitness[b]! - fitness[a]!);
  return order.slice(0, count);
}

function frameOf(t: Trajectories, k: number, f: number): number[] {
  const at = (t.offsets[k]! + f) * FRAME_FLOATS;
  return Array.from(t.data.subarray(at, at + FRAME_FLOATS));
}

function liveFrame(ep: Episode): number[] {
  return Array.from(Float32Array.of(ep.state.x, ep.state.y, ep.state.heading, ep.state.energy));
}

describe("trajectory recording", () => {
  it("returns exactly the fittest creatures after the best, every frame of each", async () => {
    const { population, fitness, bestIndex, frames } = await generation(new SerialEvaluator(cfg), { maxOthers: 12 });
    const top = expectedTop(fitness, bestIndex, 12);
    expect(frames.offsets.length).toBe(13);
    expect(frames.data.length).toBe(frames.offsets[12]! * FRAME_FLOATS);
    for (let k = 0; k < top.length; k++) {
      const index = top[k]!;
      const ep = new Episode(cfg, population.genome(index), SEED, index);
      let f = 0;
      for (; ; f++) {
        expect(frameOf(frames, k, f)).toEqual(liveFrame(ep));
        if (ep.done) break;
        ep.step();
      }
      expect(frames.offsets[k + 1]! - frames.offsets[k]!).toBe(f + 1); // exact slot
    }
  });

  it("keeps everyone but the best when the population is small", async () => {
    const { fitness, bestIndex, frames } = await generation(new SerialEvaluator(cfg), {});
    expect(frames.offsets.length).toBe(Math.min(fitness.length - 1, MAX_TRAJECTORIES) + 1);
    expect(expectedTop(fitness, bestIndex, MAX_TRAJECTORIES).length).toBe(frames.offsets.length - 1);
  });

  it("gives the same frames from the worker pool as from the serial evaluator", async () => {
    const options = { maxOthers: 20 };
    const serial = await generation(new SerialEvaluator(cfg), options);
    const pool = createNodeEvaluator(cfg, 3);
    try {
      const parallel = await generation(pool, options);
      expect(Array.from(parallel.fitness)).toEqual(Array.from(serial.fitness));
      expect(Array.from(parallel.frames.offsets)).toEqual(Array.from(serial.frames.offsets));
      expect(Array.from(parallel.frames.data)).toEqual(Array.from(serial.frames.data));
    } finally {
      pool.close();
    }
  }, 60_000);

  it("stops recording a creature at the frame cap", async () => {
    const cap = 40;
    const { population, fitness, bestIndex, frames } = await generation(new SerialEvaluator(cfg), { maxOthers: 10, maxFrames: cap });
    const top = expectedTop(fitness, bestIndex, 10);
    let capped = 0;
    for (let k = 0; k < top.length; k++) {
      const n = frames.offsets[k + 1]! - frames.offsets[k]!;
      expect(n).toBeLessThanOrEqual(cap);
      const index = top[k]!;
      const ep = new Episode(cfg, population.genome(index), SEED, index);
      for (let f = 0; f < n; f++) {
        expect(frameOf(frames, k, f)).toEqual(liveFrame(ep));
        ep.step();
      }
      if (n === cap) capped++;
    }
    expect(capped).toBeGreaterThan(0);
    expect(MAX_RECORDED_FRAMES).toBe(9000);
  });

  it("breaks fitness ties towards the lower index whatever the arrival order", () => {
    const chunk = (n: number): Trajectories => ({
      offsets: Uint32Array.from({ length: n + 1 }, (_, i) => i),
      data: Float32Array.from({ length: n * FRAME_FLOATS }, (_, i) => Math.floor(i / FRAME_FLOATS)), // frame value = local creature
    });
    const fitness = Float64Array.of(1, 3, 3, 2, 3, 2);
    for (const order of [[0, 2, 4], [4, 2, 0]]) {
      const top = new TopFrames({ maxOthers: 3 });
      for (const start of order) top.add(start, fitness.subarray(start, start + 2), chunk(2));
      const t = top.result();
      // best is index 1; then 2, 4 (fitness 3), then 3 (fitness 2, lower index than 5)
      expect(Array.from(t.offsets)).toEqual([0, 1, 2, 3]);
      expect(Array.from(t.data).filter((_, i) => i % FRAME_FLOATS === 0)).toEqual([0, 0, 1]); // local ids of 2, 4, 3
    }
  });
});

describe("replay playback", () => {
  async function replayOf(record: RecordOptions) {
    const { population, fitness, bestIndex, frames } = await generation(new SerialEvaluator(cfg), record);
    const msg = {
      type: "generation",
      result: { generation: 0, layoutSeed: SEED, fitness, bestIndex, bestFitness: fitness[bestIndex]!, meanFitness: 0 },
      bestEver: 0,
      genomes: population.data,
      genomeLength: population.genomeLength,
      populationSize: population.size,
      trajectories: frames,
    } satisfies GenerationMessage;
    const replay = new Replay();
    replay.load(msg, cfg);
    return { replay, population, fitness, bestIndex, top: expectedTop(fitness, bestIndex, record.maxOthers ?? MAX_TRAJECTORIES) };
  }

  it("places the others where a live episode would be", async () => {
    const { replay, population, top } = await replayOf({ maxOthers: 30 });
    expect(replay.others.length).toBe(30);
    const live = top.map((i) => new Episode(cfg, population.genome(i), SEED, i));
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

  it("draws a capped creature frozen and alive at its last recorded frame", async () => {
    const cap = 40;
    const { replay, population, top } = await replayOf({ maxOthers: 10, maxFrames: cap });
    const ep = top.map((i) => new Episode(cfg, population.genome(i), SEED, i));
    ep.forEach((e) => { for (let t = 0; t < cap - 1; t++) e.step(); });
    replay.advance(cap - 1, Infinity);
    const atCap = replay.others.map((o) => ({ ...o }));
    replay.advance(500, Infinity);
    let frozen = 0;
    replay.others.forEach((o, k) => {
      if (ep[k]!.state.alive) {
        frozen++;
        expect(o.alive).toBe(true);
        expect(o).toEqual(atCap[k]);
        expect(o.x).toBeCloseTo(ep[k]!.state.x, 3);
      }
    });
    expect(frozen).toBeGreaterThan(0);
  });
});
