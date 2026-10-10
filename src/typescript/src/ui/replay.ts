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
  private othersClock = 0; // ticks the others have run, behind the clock while they were not stepped

  // Builds the others too so switching the view never restarts the replay.
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
    this.clock = this.othersClock = 0;
  }

  clear(): void {
    this.best = null;
    this.others = [];
    this.generation = -1;
  }

  // Runs up to `ticks` ticks of the best, and of the others when withOthers, stopping at the deadline (a performance.now() time).
  advance(ticks: number, withOthers: boolean, deadline: number): void {
    const best = this.best;
    if (!best) return;
    const target = this.clock + ticks;
    while (performance.now() < deadline) {
      if (withOthers && this.othersClock < this.clock) {
        this.stepOthers(); // catch up after the others sat out
      } else if (this.clock < target) {
        best.step();
        this.clock++;
        if (withOthers) this.stepOthers();
      } else {
        break;
      }
    }
  }

  private stepOthers(): void {
    for (let i = 0; i < this.others.length; i++) this.others[i]!.step(); // step() ignores finished episodes
    this.othersClock++;
  }

  get done(): boolean {
    return this.best?.done ?? false; // the best outlives the others
  }
}
