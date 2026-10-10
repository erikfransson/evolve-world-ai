import { DEFAULT_CONFIG } from "./config.ts";
import type { EngineConfig } from "./config.ts";

// Ecosystem: all creatures share one world, food and poison regrow, creatures reproduce on their own.
export interface EcoConfig extends EngineConfig {
  eco: {
    initialPopulation: number; // founders with random genomes and colours
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
    collisions: boolean; // creatures bounce off each other
  };
  mutation: { rate: number; std: number }; // per gene, as in Trials' ga
}

// world.foodDensity and world.poisonDensity are the starting densities.
export const DEFAULT_ECO_CONFIG: EcoConfig = {
  seed: 1,
  dt: DEFAULT_CONFIG.dt,
  world: { ...DEFAULT_CONFIG.world, width: 4000, height: 2500, foodDensity: 0.5, poisonDensity: 0.05, respawn: false },
  creature: { ...DEFAULT_CONFIG.creature, startEnergy: 50, seesCreatures: true },
  brain: { hiddenLayers: [...DEFAULT_CONFIG.brain.hiddenLayers] },
  eco: {
    initialPopulation: 300,
    maxPopulation: 10000,
    foodRegrow: 0.05, // 50 items/s on the default world, about 1000 energy/s, so roughly 300 creatures at equilibrium
    foodMaxDensity: 0.7,
    poisonRegrow: 0.005,
    poisonMaxDensity: 0.1,
    birthEnergy: 150,
    birthCost: 75,
    childEnergy: 50,
    birthCooldown: 10,
    birthSpeed: 60,
    hueDrift: 8,
    collisions: true,
  },
  mutation: { rate: DEFAULT_CONFIG.ga.mutationRate, std: DEFAULT_CONFIG.ga.mutationStd },
};
