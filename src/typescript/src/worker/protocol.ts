import type { SimConfig } from "../sim/config.ts";
import type { Trajectories } from "../sim/trajectory.ts";
import type { GenerationResult } from "../sim/types.ts";

export type InMessage = { type: "start"; config: SimConfig } | { type: "pause" } | { type: "resume" };

export interface GenerationMessage {
  type: "generation";
  result: GenerationResult;
  bestEver: number;
  // Evaluated population data (transferred); rebuild with new Population(populationSize, genomeLength, genomes).
  genomes: Float32Array;
  genomeLength: number;
  populationSize: number;
  // Paths of the fittest creatures after the best, fittest first (transferred), for the replay to play back.
  trajectories: Trajectories;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type OutMessage = GenerationMessage | ErrorMessage;
