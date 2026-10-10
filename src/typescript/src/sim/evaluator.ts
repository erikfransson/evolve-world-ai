import type { SimConfig } from "./config.ts";
import { runEpisode } from "./episode.ts";
import type { Population } from "./population.ts";
import { FrameRecorder, TopFrames } from "./trajectory.ts";
import type { RecordOptions, Trajectories } from "./trajectory.ts";

export interface Evaluation {
  fitness: Float64Array;
  frames?: Trajectories; // when recording: the fittest creatures after the best, fittest first
}

// Scores a whole population for one generation. Implementations must return identical fitness for identical input.
export interface Evaluator {
  evaluate(population: Population, layoutSeed: number, record?: RecordOptions): Promise<Evaluation>;
  close(): void;
}

// Fitness of creatures [start, end) into out[0..end-start). The genomes buffer holds creatures from index genomeOffset on.
// With record, also returns the frames of each of these creatures.
export function evaluateRange(
  config: SimConfig,
  genomes: Float32Array,
  genomeLength: number,
  layoutSeed: number,
  start: number,
  end: number,
  out: Float64Array,
  genomeOffset = 0,
  record?: RecordOptions,
): Trajectories | undefined {
  const recorder = record ? new FrameRecorder(end - start, record.maxFrames) : undefined;
  for (let i = start; i < end; i++) {
    const at = (i - genomeOffset) * genomeLength;
    out[i - start] = runEpisode(config, genomes.subarray(at, at + genomeLength), layoutSeed, i, recorder);
  }
  return recorder?.result();
}

const SERIAL_CHUNK = 64; // creatures evaluated between two merges of recorded frames

// Re-simulates chosen creatures with recording. Creature k of the genomes buffer ran as creature indices[k] of its generation,
// and the buffer must be ordered best first (see History), so that frames holds the creatures after the best, in that order.
export function evaluateCreatures(
  config: SimConfig,
  genomes: Float32Array,
  genomeLength: number,
  layoutSeed: number,
  indices: ArrayLike<number>,
  record?: RecordOptions,
): { fitness: Float64Array; frames: Trajectories } {
  const count = indices.length;
  const fitness = new Float64Array(count);
  const top = new TopFrames({ ...record, maxOthers: count - 1 });
  for (let start = 0; start < count; start += SERIAL_CHUNK) {
    const end = Math.min(count, start + SERIAL_CHUNK);
    const recorder = new FrameRecorder(end - start, record?.maxFrames);
    for (let k = start; k < end; k++) {
      fitness[k] = runEpisode(config, genomes.subarray(k * genomeLength, (k + 1) * genomeLength), layoutSeed, indices[k]!, recorder);
    }
    top.add(start, fitness.subarray(start, end), recorder.result());
  }
  return { fitness, frames: top.result() };
}

export class SerialEvaluator implements Evaluator {
  private readonly config: SimConfig;

  constructor(config: SimConfig) {
    this.config = config;
  }

  evaluate(population: Population, layoutSeed: number, record?: RecordOptions): Promise<Evaluation> {
    const fitness = new Float64Array(population.size);
    const top = record ? new TopFrames(record) : undefined;
    for (let start = 0; start < population.size; start += SERIAL_CHUNK) {
      const end = Math.min(population.size, start + SERIAL_CHUNK);
      const part = fitness.subarray(start, end);
      const frames = evaluateRange(this.config, population.data, population.genomeLength, layoutSeed, start, end, part, 0, record);
      if (top) top.add(start, part, frames!);
    }
    return Promise.resolve({ fitness, frames: top?.result() });
  }

  close(): void {}
}
