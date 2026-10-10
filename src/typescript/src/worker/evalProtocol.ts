import type { SimConfig } from "../sim/config.ts";

// Messages between an evaluator pool and one of its workers.
export interface EvalInit {
  type: "init";
  config: SimConfig;
}

// Creatures [start, end) of one generation; genomes holds only those creatures (transferred).
export interface EvalJob {
  type: "eval";
  job: number;
  start: number;
  end: number;
  layoutSeed: number;
  genomeLength: number;
  genomes: Float32Array;
}

export type EvalIn = EvalInit | EvalJob;

export interface EvalDone {
  type: "done";
  job: number;
  start: number;
  fitness: Float64Array; // transferred, one per creature of the job
}
