import type { SimConfig } from "../sim/config.ts";
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
}
