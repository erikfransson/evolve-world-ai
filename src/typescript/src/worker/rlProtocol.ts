import type { EnvSpec } from "../sim/rl/env.ts";
import type { EsOptions } from "../sim/rl/es.ts";
import type { PpoOptions } from "../sim/rl/ppo.ts";
import type { StoredLearner } from "../sim/rl/library.ts";
import type { Recording } from "../sim/rl/recording.ts";

// Messages between the Arena page (#32) and its worker (rlWorker.ts).

export interface RlRunOptions extends Omit<EsOptions, "shaping">, Partial<Pick<EsOptions, "shaping">> {
  episodes: number; // seeds per candidate and env each iteration
  iterations: number; // the run stops after this many
  backprop?: Partial<Pick<PpoOptions, "lr" | "episodes">>; // with method "backprop"; the ES fields above then do not apply
}

export const ARENA_HELD_SEEDS = 12; // held-out seeds per env the Arena page asks for (#54); Live visitor training keeps the default 4

export type TrainMethod = "es" | "backprop"; // evolution strategies (Trainer) or PPO (BackpropTrainer)

export type RlInMessage =
  | {
      type: "start";
      envs: EnvSpec[]; // checked by the page (checkEnv for custom ones), all of the kind's world and species
      learner: StoredLearner;
      method: TrainMethod;
      options: RlRunOptions;
      tiles: number;
      held?: number; // held-out seeds per env (the fixed set heldSeeds(held)), 1 to 32; 4 when left out (Live visitor training) // episodes shown per iteration, 1 to 12; tile k plays envs[k % envs.length]
      seed: number;
      poolUrl: string;
      libraryUrl: string;
      playback?: boolean; // false (Max speed): no shows except the last one, see the "playback" message; default true
      gentle?: boolean; // Gentle on CPU: fewer helpers and idle time after each step (pacing only, same results)
      helpers?: number; // at most this many helper threads (each holds its own copy of the envs, pool and library), default from the cores
    }
  | { type: "envs"; envs: EnvSpec[] } // while paused: train on these from the next step on (checked like start's)
  | { type: "show" } // record the latest best candidate at the next step's end (the page asks when its tiles finished playing)
  | { type: "gentle"; on: boolean }
  | { type: "playback"; on: boolean } // off: the page plays no replays (Max speed), so no shows are recorded; on: record one at the next step's end
  | { type: "pause" }
  | { type: "resume" };

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
