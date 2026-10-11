import { MEMORY_UNITS, memoryUnits } from "../sim/config.ts";
import { PLAN_LIMITS } from "../sim/rl/creatureFile.ts";
import type { BodyPlan } from "../sim/sensors.ts";
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
  population: number; // candidates per iteration, even
  iterations: number;
  episodes: number;
  sigma: number;
  lr: number;
  tiles: string; // one of TILE_CHOICES
}

export const DEFAULT_RUN: RunConfig = { population: 500, iterations: 5000, episodes: 1, sigma: 0.08, lr: 0.02, tiles: "12" };

const rr = range<RunConfig>;
const RUN_SECTIONS: readonly Section<RunConfig>[] = [
  {
    title: "Run",
    fields: [
      rr({ id: "population", label: "Population", tip: "Candidate brains tried per iteration. More is steadier and slower.", min: 10, max: 1000, step: 10, get: (c) => c.population, set: (c, v) => { c.population = v; } }),
      rr({ id: "iterations", label: "Iterations", tip: "The run stops after this many iterations.", min: 100, max: 20000, step: 100, get: (c) => c.iterations, set: (c, v) => { c.iterations = v; } }),
      rr({ id: "episodes", label: "Episodes per candidate", tip: "Worlds each candidate plays per environment and iteration. More is less noisy and slower.", min: 1, max: 4, step: 1, get: (c) => c.episodes, set: (c, v) => { c.episodes = v; } }),
      { kind: "choice", id: "tiles", label: "Tiles shown", tip: "How many replays of the best candidate to watch. Tile k plays environment k, repeating if there are fewer environments, each time on a different layout.", options: TILE_CHOICES.map((n) => [n, n] as const), get: (c) => c.tiles, set: (c, v) => { c.tiles = v; } },
      rr({ id: "sigma", label: "Mutation size", tip: "How far each candidate is nudged from the current brain (sigma).", min: 0.01, max: 0.3, step: 0.01, fmt: "dens", advanced: true, get: (c) => c.sigma, set: (c, v) => { c.sigma = v; } }),
      rr({ id: "lr", label: "Learning rate", tip: "How far the brain moves toward the better-scoring direction each iteration.", min: 0.002, max: 0.1, step: 0.002, fmt: "dens3", advanced: true, get: (c) => c.lr, set: (c, v) => { c.lr = v; } }),
    ],
  },
];
export const RUN_FORM: FormSpec<RunConfig> = { sections: RUN_SECTIONS, defaults: DEFAULT_RUN };
