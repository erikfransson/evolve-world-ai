import type { SimConfig } from "../sim/config.ts";
import { Episode } from "../sim/episode.ts";
import { Population } from "../sim/population.ts";
import type { GenerationMessage } from "../worker/protocol.ts";

export const MAX_OTHERS = 300; // fittest creatures besides the best that are replayed and drawn

// Re-runs one generation from its genomes and layout seed, every shown creature in its own world copy.
export class Replay {
  best: Episode | null = null;
  others: Episode[] = []; // the fittest after the best, descending
  generation = -1; // generation being replayed
  private clock = 0; // ticks the best has run

  // Builds the others too, they always run so switching the view never restarts the replay.
  load(msg: GenerationMessage, config: SimConfig): void {
    const { result, genomes, genomeLength, populationSize: n } = msg;
    const population = new Population(n, genomeLength, genomes);
    const rest: number[] = [];
    for (let i = 0; i < n; i++) if (i !== result.bestIndex) rest.push(i);
    rest.sort((a, b) => result.fitness[b]! - result.fitness[a]!);
    const make = (i: number): Episode => new Episode(config, population.genome(i), result.layoutSeed, i);
    this.best = make(result.bestIndex);
    this.others = rest.slice(0, MAX_OTHERS).map(make);
    this.generation = result.generation;
    this.clock = 0;
  }

  clear(): void {
    this.best = null;
    this.others = [];
    this.generation = -1;
  }

  // Runs up to `ticks` ticks of the best and the others, stopping at the deadline (a performance.now() time).
  advance(ticks: number, deadline: number): void {
    const best = this.best;
    if (!best) return;
    const target = this.clock + ticks;
    while (this.clock < target && performance.now() < deadline) {
      best.step();
      this.clock++;
      for (let i = 0; i < this.others.length; i++) this.others[i]!.step(); // step() ignores finished episodes
    }
  }

  get done(): boolean {
    return this.best?.done ?? false; // the best outlives the others
  }
}
