import type { Genome } from "./types.ts";

// All genomes of one generation in a single flat buffer, genome i at [i * genomeLength, (i + 1) * genomeLength).
export class Population {
  readonly size: number;
  readonly genomeLength: number;
  readonly data: Float32Array;

  // Pass data to wrap an existing buffer without copying, e.g. one received from the worker.
  constructor(size: number, genomeLength: number, data: Float32Array = new Float32Array(size * genomeLength)) {
    if (data.length !== size * genomeLength) {
      throw new Error(`population data length ${data.length} does not match ${size} x ${genomeLength}`);
    }
    this.size = size;
    this.genomeLength = genomeLength;
    this.data = data;
  }

  // A view into data, not a copy.
  genome(i: number): Genome {
    return this.data.subarray(i * this.genomeLength, (i + 1) * this.genomeLength);
  }
}
