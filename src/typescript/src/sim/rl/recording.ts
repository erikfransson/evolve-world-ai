import type { PoolEntry } from "../seedPool.ts";
import { HIT_NONE } from "../types.ts";
import { runEpisode } from "./env.ts";
import type { EnvSpec, EpisodeResult, Learner, Library } from "./env.ts";

// One episode as flat arrays, for the Arena to play back: frame f's items are itemData[3 * itemStart[f] ..] (x, y, kind),
// its creatures creatureData[CREATURE_FIELDS * creatureStart[f] ..], and the learner's rays rays[2 * rayCount * f ..] (closeness, kind).
export const CREATURE_FIELDS = 6; // x, y, heading, species, learner (1 or 0), energy

export interface Recording {
  width: number;
  height: number;
  dt: number; // simulated seconds per frame
  frames: number;
  itemStart: Int32Array; // frames + 1
  itemData: Float32Array;
  creatureStart: Int32Array; // frames + 1
  creatureData: Float32Array;
  rayCount: number;
  rayLength: number;
  rayOffsets: Float32Array;
  rays: Float32Array; // zeros after the learner dies
  inputSize: number; // 0 unless recorded with inputs
  inputs: Float32Array; // the learner's brain input per frame (inputSize each), to replay its brain; zeros after it dies
  result: EpisodeResult;
}

// Plays the episode like runEpisode and keeps every `every`-th tick.
export function recordEpisode(env: EnvSpec, learner: Learner, seed: number, pool: readonly PoolEntry[] | null, library: Library, every = 2, withInputs = false): Recording {
  const items: number[] = [];
  const creatures: number[] = [];
  const rays: number[] = [];
  const itemStart = [0];
  const creatureStart = [0];
  const rayCount = learner.plan.rayCount;
  let dt = 0;
  let tick = 0;
  let offsets = new Float32Array(rayCount);
  const inputs: number[] = [];
  let inputSize = 0;
  const result = runEpisode(env, learner, seed, pool, library, (eco) => {
    if (tick++ % every !== 0) return;
    dt = eco.config.dt * every;
    const w = eco.world;
    for (let i = 0; i < w.count; i++) if (w.kinds[i] !== HIT_NONE) items.push(w.xs[i]!, w.ys[i]!, w.kinds[i]!);
    itemStart.push(items.length / 3);
    for (const m of eco.members) {
      const s = m.creature.state;
      creatures.push(s.x, s.y, s.heading, m.species, m.id === 0 ? 1 : 0, s.energy);
    }
    creatureStart.push(creatures.length / CREATURE_FIELDS);
    const me = eco.get(0);
    if (me) offsets = Float32Array.from(me.creature.rayOffsets);
    if (withInputs) {
      const input = me?.creature.brain.layerActivations()[0];
      if (input && !inputSize) inputSize = input.length;
      for (let k = 0; k < inputSize; k++) inputs.push(input?.[k] ?? 0);
    }
    for (let r = 0; r < rayCount; r++) rays.push(me?.creature.rays[r]?.closeness ?? 0, me?.creature.rays[r]?.kind ?? HIT_NONE);
  });
  return {
    width: env.size[0],
    height: env.size[1],
    dt,
    frames: itemStart.length - 1,
    itemStart: Int32Array.from(itemStart),
    itemData: Float32Array.from(items),
    creatureStart: Int32Array.from(creatureStart),
    creatureData: Float32Array.from(creatures),
    rayCount,
    rayLength: learner.plan.rayLength,
    rayOffsets: offsets,
    rays: Float32Array.from(rays),
    inputSize,
    inputs: Float32Array.from(inputs),
    result,
  };
}

// The buffers of a recording, to transfer it to another thread.
export const recordingBuffers = (r: Recording): ArrayBuffer[] => [r.itemStart, r.itemData, r.creatureStart, r.creatureData, r.rayOffsets, r.rays, r.inputs].map((a) => a.buffer as ArrayBuffer);
