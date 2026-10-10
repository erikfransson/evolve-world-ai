import type { SimConfig } from "../sim/config.ts";
import { Episode } from "../sim/episode.ts";
import { Population } from "../sim/population.ts";
import { FRAME_FLOATS } from "../sim/trajectory.ts";
import type { Trajectories } from "../sim/trajectory.ts";
import type { Genome, PlaybackState } from "../sim/types.ts";
import type { GenerationMessage, PastMessage } from "../worker/protocol.ts";

// What a replay needs of one generation.
export interface ReplaySource {
  generation: number;
  layoutSeed: number;
  genome: Genome; // the best's
  creatureIndex: number; // the best's index in its generation, which seeds its randomness
  trajectories: Trajectories; // the fittest others, fittest first
}

export function sourceOfLive(msg: GenerationMessage): ReplaySource {
  const { result, genomes, genomeLength, populationSize } = msg;
  const genome = new Population(populationSize, genomeLength, genomes).genome(result.bestIndex);
  return { generation: result.generation, layoutSeed: result.layoutSeed, genome, creatureIndex: result.bestIndex, trajectories: msg.trajectories };
}

export function sourceOfPast(msg: PastMessage): ReplaySource {
  return { generation: msg.generation, layoutSeed: msg.layoutSeed, genome: msg.genome, creatureIndex: msg.bestIndex, trajectories: msg.trajectories };
}

// Replays one generation: the best creature is re-simulated live for its brain and rays,
// the fittest others are played back from the trajectories the worker recorded.
export class Replay {
  best: Episode | null = null;
  others: PlaybackState[] = []; // the fittest after the best, descending
  generation = -1; // generation being replayed
  private trajectories: Trajectories | null = null;
  private clock = 0; // ticks the best has run

  // The others always play, so switching the view never restarts the replay.
  load(source: ReplaySource, config: SimConfig): void {
    this.best = new Episode(config, source.genome, source.layoutSeed, source.creatureIndex);
    this.trajectories = source.trajectories;
    this.others = Array.from({ length: source.trajectories.offsets.length - 1 }, () => ({ x: 0, y: 0, heading: 0, energy: 0, alive: true }));
    this.generation = source.generation;
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
