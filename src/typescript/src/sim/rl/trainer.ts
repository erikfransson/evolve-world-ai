import { createRng, deriveSeed } from "../rng.ts";
import type { StatefulRng } from "../rng.ts";
import { Es } from "./es.ts";
import type { EsOptions } from "./es.ts";

// One ES training loop for the rlTrain CLI and the Arena worker: score candidates over the envs on shared seeds, step, check on held-out seeds.

export const HELD_BASE = 0x5eed0000; // held-out seeds are HELD_BASE + k; training seeds are drawn below it, so they never meet
export const heldSeeds = (count: number): number[] => Array.from({ length: count }, (_, k) => HELD_BASE + k);

export interface RlTask {
  env: number; // index into the run's envs
  genome: Float32Array;
  seed: number;
}

// Plays episodes and returns their rewards in task order (an RlPool, or anything that runs episodes).
export interface Scorer {
  rewards(tasks: readonly RlTask[]): Promise<number[]>;
}

export interface Score {
  mean: number; // over the envs
  perEnv: number[]; // each the mean over the seeds
}

// Each genome on every env and seed (the same seeds for all, so candidates meet the same layouts). Sums seed by seed in a fixed
// order, so scores do not depend on how many threads played the episodes.
export async function scoreGenomes(scorer: Scorer, envs: number, genomes: readonly Float32Array[], seeds: readonly number[]): Promise<Score[]> {
  const tasks = genomes.flatMap((genome) => Array.from({ length: envs }, (_, env) => seeds.map((seed) => ({ env, genome, seed }))).flat());
  const rewards = await scorer.rewards(tasks);
  return genomes.map((_, g) => {
    const perEnv = Array.from({ length: envs }, (_, e) => {
      let sum = 0;
      for (let s = 0; s < seeds.length; s++) sum += rewards[(g * envs + e) * seeds.length + s]! / seeds.length;
      return sum;
    });
    return { mean: perEnv.reduce((a, b) => a + b, 0) / envs, perEnv };
  });
}

export interface StepResult {
  iter: number;
  train: number; // mean reward of the step's candidates
  best: number; // the best candidate's reward
  bestGenome: Float32Array;
}

export class Trainer {
  readonly es: Es;
  private readonly rng: StatefulRng;
  private scorer: Scorer;
  private envs: number;
  private readonly episodes: number;

  // envs: how many envs each candidate plays; episodes: fresh training seeds per step, shared by all candidates and envs.
  constructor(genome: Float32Array, options: Partial<EsOptions>, scorer: Scorer, envs: number, episodes: number, seed: number) {
    this.es = new Es(genome, options);
    this.rng = createRng(deriveSeed(seed, 0xe5));
    this.scorer = scorer;
    this.envs = envs;
    this.episodes = episodes;
  }

  // Plays the next steps on other envs (paused Arena runs can add or drop envs); the weights carry on.
  setEnvs(scorer: Scorer, envs: number): void {
    this.scorer = scorer;
    this.envs = envs;
  }

  get iter(): number {
    return this.es.step;
  }

  async step(): Promise<StepResult> {
    const seeds = Array.from({ length: this.episodes }, () => this.rng.int(HELD_BASE)); // fresh layouts each step, so none is learned by heart
    const candidates = this.es.ask(this.rng);
    const rewards = (await scoreGenomes(this.scorer, this.envs, candidates, seeds)).map((s) => s.mean);
    this.es.tell(rewards);
    let best = 0;
    for (let k = 1; k < rewards.length; k++) if (rewards[k]! > rewards[best]!) best = k;
    return { iter: this.es.step, train: rewards.reduce((a, b) => a + b, 0) / rewards.length, best: rewards[best]!, bestGenome: candidates[best]! };
  }

  // The current genome on the held-out seeds.
  async held(seeds: readonly number[]): Promise<Score> {
    return (await scoreGenomes(this.scorer, this.envs, [this.es.theta], seeds))[0]!;
  }
}
