import type { CreatureState } from "./types.ts";

export const MAX_TRAJECTORIES = 300; // fittest creatures besides the best that the replay plays back
export const MAX_RECORDED_FRAMES = 9000; // per creature, 300 s at dt 1/30; a longer life holds its last recorded frame in the replay
export const FRAME_FLOATS = 4; // x, y, heading, energy per frame
const FIRST_CAPACITY = 256; // frames reserved per creature up front, the buffer doubles when full

// Paths of several creatures in one flat buffer, creature k at frames [offsets[k], offsets[k + 1]).
// Frame f is the state after f steps; a path shorter than the creature's life was capped and the replay holds its last frame.
export interface Trajectories {
  offsets: Uint32Array; // count + 1 frame indices
  data: Float32Array; // FRAME_FLOATS per frame
}

// What to record during an evaluation, defaults as above.
export interface RecordOptions {
  maxOthers?: number; // creatures kept besides the best
  maxFrames?: number; // frames kept per creature
}

// Collects the frames of consecutive creatures. push() allocates only when the buffer doubles.
export class FrameRecorder {
  private buffer: Float32Array;
  private length = 0; // frames stored
  private first = 0; // first frame of the current creature
  private done = 0; // creatures finished
  private readonly offsets: Uint32Array;
  private readonly maxFrames: number;

  constructor(creatures: number, maxFrames = MAX_RECORDED_FRAMES) {
    this.buffer = new Float32Array(creatures * FIRST_CAPACITY * FRAME_FLOATS);
    this.offsets = new Uint32Array(creatures + 1);
    this.maxFrames = Math.max(1, maxFrames);
  }

  push(s: CreatureState): void {
    if (this.length - this.first >= this.maxFrames) return;
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
    this.offsets[++this.done] = this.length;
    this.first = this.length;
  }

  // Trimmed copy of everything recorded, ready to transfer.
  result(): Trajectories {
    return { offsets: this.offsets, data: this.buffer.slice(0, this.length * FRAME_FLOATS) };
  }
}

interface Kept {
  index: number;
  fitness: number;
  frames: Float32Array;
}

// Ranks by fitness, ties to the lower index (the order breed() picks the best in and the replay lists the others in).
function ranksBefore(fitness: number, index: number, other: Kept): boolean {
  return fitness > other.fitness || (fitness === other.fitness && index < other.index);
}

// Running top set of an evaluation: the best creature and the fittest others, with a copy of their frames only.
export class TopFrames {
  private readonly kept: Kept[] = []; // best first
  private readonly capacity: number;

  constructor(options: RecordOptions = {}) {
    this.capacity = (options.maxOthers ?? MAX_TRAJECTORIES) + 1;
  }

  // Takes in creatures start, start + 1, ... of one chunk; the chunk can be dropped afterwards.
  add(start: number, fitness: Float64Array, chunk: Trajectories): void {
    const kept = this.kept;
    for (let k = 0; k < fitness.length; k++) {
      const index = start + k;
      const f = fitness[k]!;
      if (kept.length === this.capacity && !ranksBefore(f, index, kept[kept.length - 1]!)) continue;
      let at = kept.length;
      while (at > 0 && ranksBefore(f, index, kept[at - 1]!)) at--;
      const frames = chunk.data.slice(chunk.offsets[k]! * FRAME_FLOATS, chunk.offsets[k + 1]! * FRAME_FLOATS);
      kept.splice(at, 0, { index, fitness: f, frames });
      if (kept.length > this.capacity) kept.pop();
    }
  }

  // The kept creatures without the best, fittest first.
  result(): Trajectories {
    const others = this.kept.slice(1);
    const offsets = new Uint32Array(others.length + 1);
    for (let k = 0; k < others.length; k++) offsets[k + 1] = offsets[k]! + others[k]!.frames.length / FRAME_FLOATS;
    const data = new Float32Array(offsets[others.length]! * FRAME_FLOATS);
    for (let k = 0; k < others.length; k++) data.set(others[k]!.frames, offsets[k]! * FRAME_FLOATS);
    return { offsets, data };
  }
}
