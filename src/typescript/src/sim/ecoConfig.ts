import { DEFAULT_CONFIG } from "./config.ts";
import type { EngineConfig } from "./config.ts";

// Ecosystem: all creatures share one world, food and poison regrow, creatures reproduce on their own.
export interface EcoConfig extends EngineConfig {
  eco: {
    initialPopulation: number; // founders, each with a random colour
    poolFraction: number; // 0 to 1: share of founders copied with mutation from the seed pool (when one is given), the rest random
    maxPopulation: number; // births wait while the world is full
    foodRegrow: number; // density units per second, same scale as world.foodDensity
    foodMaxDensity: number; // regrowth stops here
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
