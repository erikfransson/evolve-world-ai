import { DEFAULT_CONFIG } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import type { SpeciesConfig } from "./species.ts";

// Ecosystem: all creatures share one world, food and poison regrow, creatures reproduce on their own.
export interface EcoConfig extends EngineConfig {
  eco: {
    initialPopulation: number; // founders, each with a random colour
    poolFraction: number; // 0 to 1: share of founders copied with mutation from the seed pool (when one is given), the rest random
    maxPopulation: number; // births wait while the world is full
    foodRegrow: number; // density units per second, same scale as world.foodDensity
    foodMaxDensity: number; // regrowth stops here
    seasons: boolean; // food regrowth swings between full (summer) and winterFood over each year
    yearMinutes: number; // length of a year in simulated minutes
    winterFood: number; // food regrowth multiplier at mid-winter, 0 to 1
    poisonRegrow: number;
    poisonMaxDensity: number; // keeps poison from filling the board
    birthEnergy: number; // a creature at or above this energy gives birth; also where the energy fill is full
    birthCost: number; // energy the parent pays
    childEnergy: number; // energy the child starts with
    birthCooldown: number; // seconds before a parent can give birth again
    birthSpeed: number; // units/s the child is launched at, in a random direction
    hueDrift: number; // std of the child's colour change, degrees
    aging: boolean; // old creatures pay more upkeep
    agingStart: number; // age in seconds after which the upkeep starts to grow
    agingRate: number; // upkeep grows by this fraction of itself per minute beyond agingStart
    collisions: boolean; // creatures bounce off each other
    collisionDamage: boolean; // a bounce costs both creatures energy; one that dies gives its energy to the other
    damagePerSpeed: number; // energy each loses per unit/s of approach speed; 0.3 gives 48 for a head-on hit at top speed (160)
    wasm: boolean; // sense and think on the WebAssembly SIMD kernels in src/sim/wasm/ when available (f32, not bit-identical to JS)
    foundersVary: boolean; // founders draw their body plans from the ranges below, otherwise all get the config plan
    planDrift: number; // relative std of the change of a child's ray spread and length
    structuralRate: number; // chance per birth that the child gains or loses one ray, hidden neuron or memory unit
    // [min, max] for varied founders, drift and structural mutations.
    rayCountRange: number[];
    raySpreadRange: number[]; // radians
    rayLengthRange: number[];
    hiddenRange: number[]; // neurons per hidden layer
    memoryRange: number[]; // short and long units each
  };
  mutation: { rate: number; std: number }; // per gene, as in Trials' ga
  // Predators & prey: the species, which replace eco.initialPopulation, poolFraction, the birth settings and the ray
  // ranges, and the creature's start energy, speed and costs (see species.ts). Absent for the Ecosystem's one species.
  species?: SpeciesConfig[];
}

// world.foodDensity and world.poisonDensity are the starting densities.
export const DEFAULT_ECO_CONFIG: EcoConfig = {
  seed: 1,
  dt: DEFAULT_CONFIG.dt,
  world: { ...DEFAULT_CONFIG.world, width: 12000, height: 7500, foodDensity: 0.5, poisonDensity: 0.05, respawn: false },
  creature: { ...DEFAULT_CONFIG.creature, startEnergy: 50, seesCreatures: true },
  brain: { ...DEFAULT_CONFIG.brain, hiddenLayers: [...DEFAULT_CONFIG.brain.hiddenLayers] },
  eco: {
    initialPopulation: 1000,
    poolFraction: 0.5,
    maxPopulation: 10000,
    foodRegrow: 0.05, // 200 items/s on the default world, about 4000 energy/s, so roughly 1200 creatures at equilibrium
    foodMaxDensity: 0.7,
    seasons: false,
    yearMinutes: 40,
    winterFood: 0.3,
    poisonRegrow: 0.005,
    poisonMaxDensity: 0.1,
    birthEnergy: 150,
    birthCost: 75,
    childEnergy: 50,
    birthCooldown: 10,
    birthSpeed: 60,
    hueDrift: 8,
    aging: false,
    agingStart: 120,
    agingRate: 0.5,
    collisions: true,
    collisionDamage: false,
    damagePerSpeed: 0.3,
    wasm: true,
    foundersVary: true,
    planDrift: 0.02,
    structuralRate: 0.02,
    rayCountRange: [2, 16],
    raySpreadRange: [(20 * Math.PI) / 180, 2 * Math.PI],
    rayLengthRange: [50, 250],
    hiddenRange: [4, 32],
    memoryRange: [0, 8],
  },
  mutation: { rate: DEFAULT_CONFIG.ga.mutationRate, std: DEFAULT_CONFIG.ga.mutationStd },
};

const deg = (d: number): number => (d * Math.PI) / 180;

// Predators & prey (#12): species A grazes the plants, species B hunts A. The prey take the shared creature and eco
// settings; the predators override theirs. Tuned in docs/tuning-notes.md.
export const DEFAULT_PREDATOR_CONFIG: EcoConfig = {
  ...DEFAULT_ECO_CONFIG,
  world: { ...DEFAULT_ECO_CONFIG.world, width: 6000, height: 4000, foodDensity: 0.5, poisonDensity: 0.02, foodEnergy: 40 },
  creature: { ...DEFAULT_ECO_CONFIG.creature, startEnergy: 50, livingCost: 2, thrustCost: 4, turnCost: 0.5 },
  brain: { ...DEFAULT_ECO_CONFIG.brain, hiddenLayers: [...DEFAULT_ECO_CONFIG.brain.hiddenLayers] },
  eco: {
    ...DEFAULT_ECO_CONFIG.eco,
    initialPopulation: 400,
    poolFraction: 0.5,
    foodRegrow: 0.05,
    foodMaxDensity: 0.7,
    poisonRegrow: 0.002,
    poisonMaxDensity: 0.04,
    birthEnergy: 120,
    birthCost: 60,
    childEnergy: 45,
    birthCooldown: 8,
    rayCountRange: [2, 16],
    raySpreadRange: [deg(20), deg(360)],
    rayLengthRange: [50, 250],
  },
  mutation: { ...DEFAULT_ECO_CONFIG.mutation },
  species: [
    { name: "Prey", hue: 205, hueSpread: 50, plants: true, prey: [], eatEfficiency: 0, eatBaseline: 0, speed: 1 },
    {
      name: "Predator",
      hue: 4,
      hueSpread: 30,
      plants: false,
      prey: [0],
      eatEfficiency: 0.7,
      eatBaseline: 40,
      speed: 1.3,
      founders: 40,
      poolFraction: 0.5,
      startEnergy: 120,
      livingCost: 2,
      thrustCost: 4,
      turnCost: 0.2,
      birthEnergy: 260,
      birthCost: 140,
      childEnergy: 110,
      birthCooldown: 10,
      rayCountRange: [4, 12],
      raySpreadRange: [deg(30), deg(180)],
      rayLengthRange: [150, 300],
    },
  ],
};
// Food regrowth multiplier at simulated time t seconds: 1 at mid-summer (t = 0), winterFood at mid-winter, a cosine in between.
export const seasonFactor = (eco: EcoConfig["eco"], t: number): number => eco.winterFood + (1 - eco.winterFood) * (1 - winterness(eco, t));

// 0 at mid-summer, 1 at mid-winter.
export const winterness = (eco: EcoConfig["eco"], t: number): number => (1 - Math.cos((2 * Math.PI * t) / (eco.yearMinutes * 60))) / 2;

const SEASONS = ["Summer", "Autumn", "Winter", "Spring"] as const;
// Name of the quarter of the year that t falls in, centred on the solstices.
export function seasonName(eco: EcoConfig["eco"], t: number): (typeof SEASONS)[number] {
  const year = eco.yearMinutes * 60;
  const p = (((t / year) % 1) + 1) % 1;
  return SEASONS[Math.floor(((p + 0.125) % 1) * 4)]!;
}
