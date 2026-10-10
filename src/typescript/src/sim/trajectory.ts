import { Episode } from "./episode.ts";
import type { SimConfig } from "./config.ts";
import type { Population } from "./population.ts";

export const MAX_TRAJECTORIES = 300; // fittest creatures besides the best that are recorded for the replay
export const FRAME_FLOATS = 4; // x, y, heading, energy per frame
const FRAME_SLACK = 2; // frames beyond fitness / dt: the initial frame and the dying step

// Paths of several creatures in one flat buffer, creature k at frames [offsets[k], offsets[k + 1]).
// Frame f is the state after f steps; a path shorter than its slot repeats its last frame.
export interface Trajectories {
  offsets: Uint32Array; // count + 1 frame indices
  data: Float32Array; // FRAME_FLOATS per frame
}

// Which creatures to record and where their frames go.
export interface RecordPlan {
  indices: Int32Array; // population indices, fittest first, the best excluded
  offsets: Uint32Array; // frame offsets, one more than indices
}

// Fitness is ticksAlive * dt plus an energy term below dt, so fitness alone bounds the frames needed.
export function planRecording(fitness: Float64Array, bestIndex: number, dt: number, maxCount = MAX_TRAJECTORIES): RecordPlan {
  const order: number[] = [];
  for (let i = 0; i < fitness.length; i++) if (i !== bestIndex) order.push(i);
  order.sort((a, b) => fitness[b]! - fitness[a]!);
  const indices = Int32Array.from(order.slice(0, maxCount));
  const offsets = new Uint32Array(indices.length + 1);
  for (let k = 0; k < indices.length; k++) offsets[k + 1] = offsets[k]! + Math.ceil(fitness[indices[k]!]! / dt) + FRAME_SLACK;
  return { indices, offsets };
}

// Runs the episode to its end, writing frames into out[start * FRAME_FLOATS, end * FRAME_FLOATS). Allocation-free.
export function recordEpisode(episode: Episode, out: Float32Array, start: number, end: number): void {
  const s = episode.state;
  let at = start * FRAME_FLOATS;
  const stop = end * FRAME_FLOATS;
  for (;;) {
    if (at >= stop) throw new Error("trajectory slot too short");
    out[at] = s.x;
    out[at + 1] = s.y;
    out[at + 2] = s.heading;
    out[at + 3] = s.energy;
    at += FRAME_FLOATS;
    if (episode.done) break;
    episode.step();
  }
  while (at < stop) {
    out.copyWithin(at, at - FRAME_FLOATS, at);
    at += FRAME_FLOATS;
  }
}

// Genomes of the given creatures back to back, in the order of indices.
export function gatherGenomes(population: Population, indices: Int32Array): Float32Array {
  const out = new Float32Array(indices.length * population.genomeLength);
  for (let k = 0; k < indices.length; k++) out.set(population.genome(indices[k]!), k * population.genomeLength);
  return out;
}

// Records the creatures of a (sub)plan into out. Offsets are relative to out and genomes follow the order of indices.
export function recordRange(
  config: SimConfig,
  genomes: Float32Array,
  genomeLength: number,
  layoutSeed: number,
  indices: Int32Array,
  offsets: Uint32Array,
  out: Float32Array,
): void {
  for (let k = 0; k < indices.length; k++) {
    const genome = genomes.subarray(k * genomeLength, (k + 1) * genomeLength);
    recordEpisode(new Episode(config, genome, layoutSeed, indices[k]!), out, offsets[k]!, offsets[k + 1]!);
  }
}
