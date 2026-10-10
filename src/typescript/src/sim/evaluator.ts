import type { SimConfig } from "./config.ts";
import { runEpisode } from "./episode.ts";
import type { Population } from "./population.ts";
import { FrameRecorder, assembleFrames } from "./trajectory.ts";
import type { ChunkFrames, RecordPlan } from "./trajectory.ts";

// Scores a whole population for one generation. Implementations must return identical fitness for identical input.
export interface Evaluator {
  evaluate(population: Population, layoutSeed: number): Promise<Float64Array>;
  // Frames of the plan's creatures from the last evaluate(), laid out by plan.offsets. Needs an evaluator that records.
  frames(plan: RecordPlan): Float32Array;
  close(): void;
}

// Fitness of creatures [start, end) into out[0..end-start). The genomes buffer holds creatures from index genomeOffset on.
// A recorder, when given, also collects every creature's frames.
export function evaluateRange(
  config: SimConfig,
  genomes: Float32Array,
  genomeLength: number,
  layoutSeed: number,
  start: number,
  end: number,
  out: Float64Array,
  genomeOffset = 0,
  recorder?: FrameRecorder,
): void {
  for (let i = start; i < end; i++) {
    const at = (i - genomeOffset) * genomeLength;
    out[i - start] = runEpisode(config, genomes.subarray(at, at + genomeLength), layoutSeed, i, recorder);
  }
}

export class SerialEvaluator implements Evaluator {
  private readonly config: SimConfig;
  private readonly recordFrames: boolean;
  private recorded: { size: number; frames: ChunkFrames } | null = null;

  constructor(config: SimConfig, recordFrames = false) {
    this.config = config;
    this.recordFrames = recordFrames;
  }

  evaluate(population: Population, layoutSeed: number): Promise<Float64Array> {
    const fitness = new Float64Array(population.size);
    const recorder = this.recordFrames ? new FrameRecorder(population.size) : undefined;
    evaluateRange(this.config, population.data, population.genomeLength, layoutSeed, 0, population.size, fitness, 0, recorder);
    if (recorder) this.recorded = { size: population.size, frames: recorder.result() };
    return Promise.resolve(fitness);
  }

  frames(plan: RecordPlan): Float32Array {
    if (!this.recorded) throw new Error("no recorded generation");
    return assembleFrames(plan, Math.max(1, this.recorded.size), [this.recorded.frames]);
  }

  close(): void {}
}
