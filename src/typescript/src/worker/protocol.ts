import type { SimConfig } from "../sim/config.ts";
import type { Trajectories } from "../sim/trajectory.ts";
import type { GenerationResult } from "../sim/types.ts";

// Asks for the replay data of a kept past generation; genomes and indices are a PastGeneration's, best first.
export interface PastRequest {
  type: "past";
  request: number; // echoed in the reply
  generation: number;
  layoutSeed: number;
  genomeLength: number;
  indices: Uint32Array;
  genomes: Float32Array;
}

export type InMessage = { type: "start"; config: SimConfig } | { type: "pause" } | { type: "resume" } | PastRequest;

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

// Re-simulated past generation: its best creature and the fittest others, as in a GenerationMessage.
export interface PastMessage {
  type: "past";
  request: number;
  generation: number;
  layoutSeed: number;
  fitness: Float64Array; // of the requested creatures (transferred), best first
  bestIndex: number; // creature index of the best in its generation
  genome: Float32Array; // the best's genome
  trajectories: Trajectories; // the others, fittest first (transferred)
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

// A past-generation replay failed; the run itself goes on.
export interface PastErrorMessage {
  type: "pastError";
  request: number;
  message: string;
}

export type OutMessage = GenerationMessage | PastMessage | PastErrorMessage | ErrorMessage;
