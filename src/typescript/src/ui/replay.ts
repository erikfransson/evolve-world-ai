import type { SimConfig } from "../sim/config.ts";
import { Episode } from "../sim/episode.ts";
import { Population } from "../sim/population.ts";
import { FRAME_FLOATS } from "../sim/trajectory.ts";
import type { Trajectories } from "../sim/trajectory.ts";
import type { PlaybackState } from "../sim/types.ts";
import type { GenerationMessage } from "../worker/protocol.ts";

// Replays one generation: the best creature is re-simulated live for its brain and rays,
// the fittest others are played back from the trajectories the worker recorded.
export class Replay {
  best: Episode | null = null;
  others: PlaybackState[] = []; // the fittest after the best, descending
  generation = -1; // generation being replayed
  private trajectories: Trajectories | null = null;
  private clock = 0; // ticks the best has run

  // The others always play, so switching the view never restarts the replay.
  load(msg: GenerationMessage, config: SimConfig): void {
    const { result, genomes, genomeLength, populationSize: n } = msg;
    const population = new Population(n, genomeLength, genomes);
    this.best = new Episode(config, population.genome(result.bestIndex), result.layoutSeed, result.bestIndex);
    this.trajectories = msg.trajectories;
    this.others = Array.from({ length: msg.trajectories.offsets.length - 1 }, () => ({ x: 0, y: 0, heading: 0, energy: 0, alive: true }));
    this.generation = result.generation;
    this.clock = 0;
    this.placeOthers();
  }

  clear(): void {
    this.best = null;
    this.others = [];
    this.trajectories = null;
    this.generation = -1;
  }

  // Runs up to `ticks` ticks of the best, stopping at the deadline (a performance.now() time), and moves the others to match.
  advance(ticks: number, deadline: number): void {
    const best = this.best;
    if (!best) return;
    const target = this.clock + ticks;
    while (this.clock < target && performance.now() < deadline) {
      best.step();
      this.clock++;
    }
    this.placeOthers();
  }

  get done(): boolean {
    return this.best?.done ?? false; // the best outlives the others
  }

  // Others at the frame after `clock` steps; a finished path holds its last frame.
  private placeOthers(): void {
    const t = this.trajectories;
    if (!t) return;
    for (let k = 0; k < this.others.length; k++) {
      const frame = Math.min(t.offsets[k]! + this.clock, t.offsets[k + 1]! - 1);
      const at = frame * FRAME_FLOATS;
      const o = this.others[k]!;
      o.x = t.data[at]!;
      o.y = t.data[at + 1]!;
      o.heading = t.data[at + 2]!;
      o.energy = t.data[at + 3]!;
      o.alive = o.energy > 0;
    }
  }
}
