import { MEMORY_UNITS, memoryUnits } from "../sim/config.ts";
import { PLAN_LIMITS } from "../sim/rl/creatureFile.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import type { TrainMethod } from "../worker/rlProtocol.ts";
import { range } from "./settingsForm.ts";
import type { FormSpec, Section } from "./settingsForm.ts";

// Arena settings, built by buildForm in settingsForm.ts like the other pages': the creature design and the run.
const toDeg = (rad: number): number => Math.round((rad * 180) / Math.PI);

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
  const [lo, hi] = [1, 4];
  return {
    rayCount: p.rayCount,
    raySpread: p.raySpread,
    rayLength: p.rayLength,
    layers: Math.min(hi, Math.max(lo, p.hiddenLayers.length)),
    neurons: p.hiddenLayers[0] ?? DEFAULT_DESIGN.neurons,
    memory: Math.min(1, (p.memoryShort + p.memoryLong) / MEMORY_UNITS),
  };
}

const L = PLAN_LIMITS;
const r = range<DesignConfig>;
const DESIGN_SECTIONS: readonly Section<DesignConfig>[] = [
  {
    title: "Creature",
    fields: [
      r({ id: "rayCount", label: "Vision rays", tip: "How many laser rays the creature sees with. More rays give a finer view and more inputs to the brain.", min: L.rayCount[0], max: L.rayCount[1], step: 1, get: (c) => c.rayCount, set: (c, v) => { c.rayCount = v; } }),
      r({ id: "raySpread", label: "Vision angle", tip: "Total width of the fan of rays, centred on where the creature faces. 360 looks all around.", min: 10, max: 360, step: 5, fmt: "deg", get: (c) => toDeg(c.raySpread), set: (c, v) => { c.raySpread = (v * Math.PI) / 180; } }),
      r({ id: "rayLength", label: "Sight length", tip: "How far each ray reaches, in world units. Longer sight costs more energy per second.", min: L.rayLength[0], max: L.rayLength[1], step: 10, fmt: "size", get: (c) => c.rayLength, set: (c, v) => { c.rayLength = v; } }),
    ],
  },
  {
    title: "Brain",
    fields: [
      r({ id: "layers", label: "Hidden layers", tip: "How many layers of neurons sit between the creature's eyes and its muscles.", min: L.layers[0], max: L.layers[1], step: 1, get: (c) => c.layers, set: (c, v) => { c.layers = v; } }),
      r({ id: "neurons", label: "Neurons per layer", tip: "Neurons in each hidden layer. More can learn richer behaviour and cost more energy per second.", min: L.neurons[0], max: L.neurons[1], step: 1, get: (c) => c.neurons, set: (c, v) => { c.neurons = v; } }),
      r({ id: "memory", label: "Memory", tip: "Short- and long-term memory the brain can write to and read back on the next moment, so it can remember what it saw. 0 is none, 0.5 gives 4 short-term and 4 long-term memory units, 1 gives 8 of each.", min: 0, max: 1, step: 0.05, fmt: "dens", get: (c) => c.memory, set: (c, v) => { c.memory = v; } }),
    ],
  },
];
export const DESIGN_FORM: FormSpec<DesignConfig> = { sections: DESIGN_SECTIONS, defaults: DEFAULT_DESIGN };

export const TILE_CHOICES = ["1", "4", "6", "12"] as const;

export interface RunConfig {
  method: TrainMethod;
  population: number; // candidates per iteration, even
  iterations: number;
  episodes: number;
  envsPerStep: number;
  sigma: number;
  lr: number;
  tiles: string; // one of TILE_CHOICES
  bpLr: number; // backprop learning rate
  bpEpisodes: number; // backprop episodes per update
}

export const DEFAULT_RUN: RunConfig = { method: "es", population: 500, iterations: 5000, episodes: 1, envsPerStep: 3, sigma: 0.08, lr: 0.02, tiles: "12", bpLr: 0.003, bpEpisodes: 16 };

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
      rr({ id: "population", label: "Population", tip: "Candidate brains tried per iteration. More is steadier and slower.", min: 10, max: 1000, step: 10, enabledWhen: es, get: (c) => c.population, set: (c, v) => { c.population = v; } }),
      rr({ id: "iterations", label: "Iterations", tip: "The run stops after this many iterations (updates for Backprop RL).", min: 100, max: 20000, step: 100, get: (c) => c.iterations, set: (c, v) => { c.iterations = v; } }),
      rr({ id: "episodes", label: "Episodes per candidate", tip: "Worlds each candidate plays per environment and iteration. More is less noisy and slower.", min: 1, max: 4, step: 1, enabledWhen: es, get: (c) => c.episodes, set: (c, v) => { c.episodes = v; } }),
      { kind: "choice", id: "tiles", label: "Tiles shown", tip: "How many replays of the trained creature to watch (Evolutionary RL: the iteration's best candidate; Backprop RL: the current policy). Tile k plays environment k, repeating if there are fewer environments, each time on a different layout.", options: TILE_CHOICES.map((n) => [n, n] as const), get: (c) => c.tiles, set: (c, v) => { c.tiles = v; } },
      rr({ id: "envsPerStep", label: "Worlds per iteration", tip: "With many environments chosen, each iteration trains on this many of them, taking turns, so iterations stay quick. The held-out score still checks all of them.", min: 1, max: 10, step: 1, advanced: true, enabledWhen: es, get: (c) => c.envsPerStep, set: (c, v) => { c.envsPerStep = v; } }),
      rr({ id: "sigma", label: "Mutation size", tip: "How far each candidate is nudged from the current brain (sigma).", min: 0.01, max: 0.3, step: 0.01, fmt: "dens", advanced: true, enabledWhen: es, get: (c) => c.sigma, set: (c, v) => { c.sigma = v; } }),
      rr({ id: "lr", label: "Learning rate", tip: "How far the brain moves toward the better-scoring direction each iteration.", min: 0.002, max: 0.1, step: 0.002, fmt: "dens3", advanced: true, enabledWhen: es, get: (c) => c.lr, set: (c, v) => { c.lr = v; } }),
      rr({ id: "bpLr", label: "Backprop learning rate", tip: "How far each gradient step moves the brain (Backprop RL).", min: 0.0005, max: 0.01, step: 0.0005, fmt: "dens4", advanced: true, enabledWhen: backprop, get: (c) => c.bpLr, set: (c, v) => { c.bpLr = v; } }),
      rr({ id: "bpEpisodes", label: "Episodes per update", tip: "Episodes the brain plays before each gradient update (Backprop RL). More is steadier and slower.", min: 4, max: 64, step: 4, advanced: true, enabledWhen: backprop, get: (c) => c.bpEpisodes, set: (c, v) => { c.bpEpisodes = v; } }),
    ],
  },
];
export const RUN_FORM: FormSpec<RunConfig> = { sections: RUN_SECTIONS, defaults: DEFAULT_RUN };
