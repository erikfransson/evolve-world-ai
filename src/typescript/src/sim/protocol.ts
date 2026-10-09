import type { SimConfig } from "./config.ts";
import type { Genome, GenerationResult } from "./types.ts";

export type InMessage = { type: "start"; config: SimConfig } | { type: "pause" } | { type: "resume" };

export interface GenerationMessage {
  type: "generation";
  result: GenerationResult;
  bestEver: number;
  genomes: Float32Array; // all genomes concatenated
  genomeLength: number;
}

export type OutMessage = GenerationMessage;

export function packGenomes(genomes: Genome[]): Float32Array {
  const genomeLength = genomes[0]?.length ?? 0;
  const flat = new Float32Array(genomes.length * genomeLength);
  genomes.forEach((g, i) => flat.set(g, i * genomeLength));
  return flat;
}

export function unpackGenome(flat: Float32Array, genomeLength: number, i: number): Genome {
  return flat.subarray(i * genomeLength, (i + 1) * genomeLength);
}
