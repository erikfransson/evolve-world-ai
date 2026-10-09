import type { SimConfig } from "../sim/config.ts";
import { Episode } from "../sim/episode.ts";
import { Population } from "../sim/population.ts";
import type { GenerationMessage } from "../worker/protocol.ts";

// Re-runs one generation from its genomes and layout seed, every creature in its own world copy.
export class Replay {
  episodes: Episode[] = [];
  bestIndex = -1;
  generation = -1; // generation being replayed

  // Always builds every creature so switching the view never restarts the replay.
  load(msg: GenerationMessage, config: SimConfig): void {
    const { result, genomes, genomeLength, populationSize: n } = msg;
    const population = new Population(n, genomeLength, genomes);
    this.episodes = [];
    for (let i = 0; i < n; i++) this.episodes.push(new Episode(config, population.genome(i), result.layoutSeed, i));
    this.bestIndex = result.bestIndex;
    this.generation = result.generation;
  }

  clear(): void {
    this.episodes = [];
    this.bestIndex = -1;
    this.generation = -1;
  }

  advance(ticks: number): void {
    const eps = this.episodes;
    for (let t = 0; t < ticks; t++) {
      for (let i = 0; i < eps.length; i++) eps[i]!.step(); // step() ignores finished episodes
    }
  }

  get done(): boolean {
    for (let i = 0; i < this.episodes.length; i++) if (!this.episodes[i]!.done) return false;
    return this.episodes.length > 0;
  }

  get best(): Episode | null {
    return this.episodes[this.bestIndex] ?? null;
  }
}
