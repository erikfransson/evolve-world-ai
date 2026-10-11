import type { CreatureKind } from "../sim/rl/creatureFile.ts";
import type { EnvSpec } from "../sim/rl/env.ts";
import type { EsOptions } from "../sim/rl/es.ts";
import type { StoredLearner } from "../sim/rl/library.ts";
import type { Recording } from "../sim/rl/recording.ts";

// Messages between the Arena page (#32) and its worker (rlWorker.ts).

export interface RlRunOptions extends Omit<EsOptions, "shaping">, Partial<Pick<EsOptions, "shaping">> {
  episodes: number; // seeds per candidate and env each iteration
  iterations: number; // the run stops after this many
}

export type RlInMessage =
  | {
      type: "start";
      kind: CreatureKind;
      envs: EnvSpec[]; // checked by the page (checkEnv for custom ones), all of the kind's world and species
      learner: StoredLearner;
      options: RlRunOptions;
      tiles: number; // episodes shown per iteration, 1 to 12; tile k plays envs[k % envs.length]
      seed: number;
      poolUrl: string;
      libraryUrl: string;
    }
  | { type: "envs"; envs: EnvSpec[] } // while paused: train on these from the next step on (checked like start's)
  | { type: "show" } // record the latest best candidate at the next step's end (the page asks when its tiles finished playing)
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" };

export interface RlIteration {
  iter: number;
  train: number; // mean reward of this iteration's candidates, over the envs
  best: number; // the best candidate's reward
  held: number | null; // the current genome's mean reward over the envs on held-out seeds, every few iterations
  perEnv: number[] | null; // the same per env, in the start message's order
  seconds: number; // wall time since the start
}

export type RlOutMessage =
  | { type: "ready"; held: number; perEnv: number[] } // the starting genome on the held-out seeds
  | { type: "iteration"; it: RlIteration }
  | { type: "show"; iter: number; genome: Float32Array; recordings: Recording[] } // the iteration's best candidate; recordings[0] carries brain inputs
  | { type: "learner"; iter: number; learner: StoredLearner } // the current (mean) genome, after each held-out check and at the end
  | { type: "rebased"; iter: number; held: number; perEnv: number[] } // after an envs change: the current genome on the new envs' held-out seeds
  | { type: "done"; iter: number }
  | { type: "error"; message: string };
