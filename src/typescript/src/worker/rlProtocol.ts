import type { EsOptions } from "../sim/rl/es.ts";
import type { StoredLearner } from "../sim/rl/library.ts";
import type { Recording } from "../sim/rl/recording.ts";

// Messages between the Arena page (#32) and its worker (rlWorker.ts).

export type RlInMessage =
  | { type: "start"; env: string; learner: StoredLearner; options: Partial<EsOptions> & { episodes?: number }; seed: number; poolUrl: string; libraryUrl: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" };

export interface RlIteration {
  iter: number;
  train: number; // mean reward of this iteration's perturbed genomes
  held: number | null; // reward of the current genome on the held-out seeds, every few iterations
  seconds: number; // wall time since the start
}

export type RlOutMessage =
  | { type: "ready"; held: number } // the starting genome's held-out reward
  | { type: "iteration"; it: RlIteration }
  | { type: "show"; iter: number; recording: Recording } // an episode of the current genome, to watch
  | { type: "learner"; iter: number; learner: StoredLearner } // the current genome, after each held-out check
  | { type: "error"; message: string };
