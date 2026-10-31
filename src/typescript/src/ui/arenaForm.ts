import { MEMORY_UNITS, memoryUnits } from "../sim/config.ts";
import { PLAN_LIMITS } from "../sim/rl/creatureFile.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import type { TrainMethod } from "../worker/rlProtocol.ts";
import { LAYOUT_CHOICES } from "./arenaLayout.ts";
import { planFields, range } from "./settingsForm.ts";
import type { FormSpec, Section } from "./settingsForm.ts";

// Arena settings, built by buildForm in settingsForm.ts like the other pages': the creature design and the run.

export interface DesignConfig {
  rayCount: number;
  raySpread: number; // radians
  rayLength: number;
  layers: number;
  neurons: number; // per hidden layer
  memory: number; // 0 to 1, see memoryUnits
}

export const DEFAULT_DESIGN: DesignConfig = { rayCount: 5, raySpread: (120 * Math.PI) / 180, rayLength: 180, layers: 1, neurons: 12, memory: 0.25 };

// The design as a body plan, every field inside PLAN_LIMITS.
export function designPlan(d: DesignConfig): BodyPlan {
  const { short, long } = memoryUnits(d.memory);
  return { rayCount: d.rayCount, raySpread: d.raySpread, rayLength: d.rayLength, hiddenLayers: new Array<number>(d.layers).fill(d.neurons), memoryShort: short, memoryLong: long };
}

// The design a plan comes closest to (uneven layers become their first width).
export function planDesign(p: BodyPlan): DesignConfig {
  const [lo, hi] = PLAN_LIMITS.layers;
  return {
    rayCount: p.rayCount,
    raySpread: p.raySpread,
    rayLength: p.rayLength,
    layers: Math.min(hi, Math.max(lo, p.hiddenLayers.length)),
    neurons: p.hiddenLayers[0] ?? DEFAULT_DESIGN.neurons,
    memory: Math.min(1, (p.memoryShort + p.memoryLong) / MEMORY_UNITS),
  };
}

const key = <K extends keyof DesignConfig>(k: K) => ({ get: (c: DesignConfig) => c[k], set: (c: DesignConfig, v: number) => { c[k] = v; } });
const plan = planFields<DesignConfig>({ rayCount: key("rayCount"), raySpread: key("raySpread"), rayLength: key("rayLength"), layers: key("layers"), neurons: key("neurons"), memory: key("memory") });
const DESIGN_SECTIONS: readonly Section<DesignConfig>[] = [
  { title: "Creature", fields: plan.creature },
  { title: "Brain", fields: plan.brain },
];
export const DESIGN_FORM: FormSpec<DesignConfig> = { sections: DESIGN_SECTIONS, defaults: DEFAULT_DESIGN };


export interface RunConfig {
  method: TrainMethod;
  population: number; // candidates per iteration, even
  iterations: number;
  episodes: number;
  sigma: number;
  lr: number;
  tiles: string; // replays per env, one of LAYOUT_CHOICES
  bpLr: number; // backprop learning rate
  bpEpisodes: number; // backprop episodes per update
}

export const DEFAULT_RUN: RunConfig = { method: "es", population: 100, iterations: 5000, episodes: 1, sigma: 0.08, lr: 0.02, tiles: "auto", bpLr: 0.003, bpEpisodes: 16 };

const rr = range<RunConfig>;
const es = (c: RunConfig): boolean => c.method === "es";
const backprop = (c: RunConfig): boolean => c.method === "backprop";
const METHODS = [["es", "Evolutionary RL"], ["backprop", "Backprop RL"]] as const;
const RUN_SECTIONS: readonly Section<RunConfig>[] = [
  {
    title: "Run",
    fields: [
      {
        kind: "choice",
        id: "method",
        label: "Training method",
        tip: "Evolutionary RL tries many nudged copies of the brain and moves toward the ones that score best. Backprop RL lets one brain act with a little randomness and learns from what worked by gradient descent, usually faster.",
        options: METHODS,
        get: (c) => c.method,
        set: (c, v) => { c.method = v as TrainMethod; },
      },
      rr({ id: "population", label: "Population", tip: "Candidate brains tried per iteration. More is steadier and slower.", min: 10, max: 5000, step: 10, log: true, enabledWhen: es, get: (c) => c.population, set: (c, v) => { c.population = v; } }),
      rr({ id: "iterations", label: "Iterations", tip: "The run stops after this many iterations (updates for Backprop RL).", min: 100, max: 200000, step: 100, log: true, get: (c) => c.iterations, set: (c, v) => { c.iterations = v; } }),
      rr({ id: "episodes", label: "Episodes per candidate", tip: "Worlds each candidate plays per environment and iteration. More is less noisy and slower.", min: 1, max: 40, step: 1, enabledWhen: es, get: (c) => c.episodes, set: (c, v) => { c.episodes = v; } }),
      { kind: "choice", id: "tiles", label: "Replays per environment", tip: "Every chosen environment gets its own tiles replaying the trained creature (Evolutionary RL: the iteration's best candidate; Backprop RL: the current policy), each on a different layout. Auto shows 4 layouts of a single environment, 2 each of two or three, and one each of more.", options: LAYOUT_CHOICES.map((n) => [n, n === "auto" ? "Auto" : n] as const), get: (c) => c.tiles, set: (c, v) => { c.tiles = v; } },
      rr({ id: "sigma", label: "Mutation size", tip: "How far each candidate is nudged from the current brain (sigma).", min: 0.01, max: 0.3, step: 0.01, fmt: "dens", advanced: true, enabledWhen: es, get: (c) => c.sigma, set: (c, v) => { c.sigma = v; } }),
      rr({ id: "lr", label: "Learning rate", tip: "How far the brain moves toward the better-scoring direction each iteration.", min: 0.002, max: 0.1, step: 0.002, fmt: "dens3", advanced: true, enabledWhen: es, get: (c) => c.lr, set: (c, v) => { c.lr = v; } }),
      rr({ id: "bpLr", label: "Backprop learning rate", tip: "How far each gradient step moves the brain (Backprop RL).", min: 0.0005, max: 0.01, step: 0.0005, fmt: "dens4", advanced: true, enabledWhen: backprop, get: (c) => c.bpLr, set: (c, v) => { c.bpLr = v; } }),
      rr({ id: "bpEpisodes", label: "Episodes per update", tip: "Episodes the brain plays before each gradient update (Backprop RL). More is steadier and slower.", min: 4, max: 320, step: 4, log: true, advanced: true, enabledWhen: backprop, get: (c) => c.bpEpisodes, set: (c, v) => { c.bpEpisodes = v; } }),
    ],
  },
];
export const RUN_FORM: FormSpec<RunConfig> = { sections: RUN_SECTIONS, defaults: DEFAULT_RUN };
