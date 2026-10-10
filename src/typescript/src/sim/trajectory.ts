import type { CreatureState } from "./types.ts";

export const MAX_TRAJECTORIES = 300; // fittest creatures besides the best that the replay plays back
export const FRAME_FLOATS = 4; // x, y, heading, energy per frame
const FRAME_SLACK = 2; // frames beyond fitness / dt: the initial frame and the dying step
const FIRST_CAPACITY = 256; // frames reserved per creature up front, the buffer doubles when full

// Paths of several creatures in one flat buffer, creature k at frames [offsets[k], offsets[k + 1]).
// Frame f is the state after f steps; a path shorter than its slot repeats its last frame.
export interface Trajectories {
  offsets: Uint32Array; // count + 1 frame indices
  data: Float32Array; // FRAME_FLOATS per frame
}

// Which creatures to take and where their frames go.
export interface RecordPlan {
  indices: Int32Array; // population indices, fittest first, the best excluded
  offsets: Uint32Array; // frame offsets, one more than indices
}

// Frames of the creatures of one evaluation chunk, creature k at frames [k ? ends[k - 1] : 0, ends[k]).
export interface ChunkFrames {
  ends: Uint32Array;
  frames: Float32Array;
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

// Collects the frames of consecutive creatures. push() allocates only when the buffer doubles.
export class FrameRecorder {
  private buffer: Float32Array;
  private length = 0; // frames stored
  private done = 0; // creatures finished
  private readonly ends: Uint32Array;

  constructor(creatures: number) {
    this.buffer = new Float32Array(creatures * FIRST_CAPACITY * FRAME_FLOATS);
    this.ends = new Uint32Array(creatures);
  }

  push(s: CreatureState): void {
    let at = this.length * FRAME_FLOATS;
    if (at + FRAME_FLOATS > this.buffer.length) {
      const bigger = new Float32Array(Math.max(1, this.buffer.length) * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[at++] = s.x;
    this.buffer[at++] = s.y;
    this.buffer[at++] = s.heading;
    this.buffer[at] = s.energy;
    this.length++;
  }

  endCreature(): void {
    this.ends[this.done++] = this.length;
  }

  // Trimmed copy of everything recorded, ready to transfer.
  result(): ChunkFrames {
    return { ends: this.ends, frames: this.buffer.slice(0, this.length * FRAME_FLOATS) };
  }
}

// Copies the planned creatures' frames out of the evaluation chunks (chunk c holds creatures [c * chunkSize, ...)).
// A creature shorter than its slot holds its last frame.
export function assembleFrames(plan: RecordPlan, chunkSize: number, chunks: readonly ChunkFrames[]): Float32Array {
  const count = plan.indices.length;
  const out = new Float32Array(plan.offsets[count]! * FRAME_FLOATS);
  for (let k = 0; k < count; k++) {
    const index = plan.indices[k]!;
    const chunk = chunks[Math.floor(index / chunkSize)];
    if (!chunk) throw new Error("no recorded frames for creature " + index);
    const local = index % chunkSize;
    const from = local > 0 ? chunk.ends[local - 1]! : 0;
    const n = chunk.ends[local]! - from;
    const start = plan.offsets[k]!;
    const slot = plan.offsets[k + 1]! - start;
    if (n > slot) throw new Error("trajectory slot too short");
    const at = start * FRAME_FLOATS;
    out.set(chunk.frames.subarray(from * FRAME_FLOATS, (from + n) * FRAME_FLOATS), at);
    for (let f = n; f < slot; f++) out.copyWithin(at + f * FRAME_FLOATS, at + (f - 1) * FRAME_FLOATS, at + f * FRAME_FLOATS);
  }
  return out;
}
