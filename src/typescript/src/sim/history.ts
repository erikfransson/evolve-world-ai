import { MAX_TRAJECTORIES } from "./trajectory.ts";

export const RECENT_GENERATIONS = 50; // newest generations whose replay data is always kept
export const MAX_HISTORY_BYTES = 200e6; // replay data cap, older generations are thinned to stay under it

export interface GenerationStat {
  generation: number;
  best: number;
  mean: number;
}

// What it takes to replay one generation: its fittest creatures, best first, with their creature indices in that generation.
export interface PastGeneration {
  generation: number;
  layoutSeed: number;
  genomeLength: number;
  indices: Uint32Array;
  genomes: Float32Array; // genome k at [k * genomeLength, (k + 1) * genomeLength)
}

const bytesOf = (g: PastGeneration): number => g.genomes.byteLength + g.indices.byteLength;

// The `count` fittest creatures by fitness, ties to the lower index, copied out of the population buffer.
export function captureTop(
  generation: number,
  layoutSeed: number,
  fitness: Float64Array,
  genomes: Float32Array,
  genomeLength: number,
  count = MAX_TRAJECTORIES + 1,
): PastGeneration {
  const order = Array.from(fitness.keys()).sort((a, b) => fitness[b]! - fitness[a]! || a - b).slice(0, count);
  const picked = new Float32Array(order.length * genomeLength);
  order.forEach((index, k) => picked.set(genomes.subarray(index * genomeLength, (index + 1) * genomeLength), k * genomeLength));
  return { generation, layoutSeed, genomeLength, indices: Uint32Array.from(order), genomes: picked };
}

// Stats of every generation, replay data of the recent ones and a thinned sample of the older ones within a byte cap.
export class History {
  readonly stats: GenerationStat[] = [];
  private readonly kept: PastGeneration[] = []; // ascending generation
  private bytes = 0;
  private readonly recent: number;
  private readonly maxBytes: number;

  constructor(recent = RECENT_GENERATIONS, maxBytes = MAX_HISTORY_BYTES) {
    this.recent = recent;
    this.maxBytes = maxBytes;
  }

  add(stat: GenerationStat, past: PastGeneration): void {
    this.stats.push(stat);
    this.kept.push(past);
    this.bytes += bytesOf(past);
    this.shrink();
  }

  clear(): void {
    this.stats.length = 0;
    this.kept.length = 0;
    this.bytes = 0;
  }

  get keptGenerations(): number[] {
    return this.kept.map((g) => g.generation);
  }

  get byteSize(): number {
    return this.bytes;
  }

  // The kept generation closest to `generation`, the earlier one on a tie.
  nearest(generation: number): PastGeneration | null {
    let best: PastGeneration | null = null;
    for (const g of this.kept) {
      if (best === null || Math.abs(g.generation - generation) < Math.abs(best.generation - generation)) best = g;
    }
    return best;
  }

  // Over the cap, drops the older entry (not the oldest) whose neighbours are closest together, which keeps coverage even.
  // With no older entries left to drop, drops the oldest recent ones (never the newest).
  private shrink(): void {
    while (this.bytes > this.maxBytes && this.kept.length > 1) {
      const kept = this.kept;
      const olderCount = kept.length - this.recent;
      if (olderCount < 2) {
        this.bytes -= bytesOf(kept.shift()!);
        continue;
      }
      let drop = 1;
      for (let k = 2; k < olderCount; k++) {
        if (kept[k + 1]!.generation - kept[k - 1]!.generation < kept[drop + 1]!.generation - kept[drop - 1]!.generation) drop = k;
      }
      this.bytes -= bytesOf(kept[drop]!);
      kept.splice(drop, 1);
    }
  }
}
