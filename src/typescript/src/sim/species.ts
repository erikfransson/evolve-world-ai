import type { EngineConfig } from "./config.ts";
import type { EcoConfig } from "./ecoConfig.ts";

// Species of a Predators & prey world (#12). Children keep their parent's species. Each species has its own founders,
// diet, speed, costs, births and body plan ranges; everything else (world, brain, mutation) is shared.
export interface SpeciesConfig {
  name: string;
  hue: number; // base colour in degrees; founders and children vary around it
  founders: number;
  poolFraction: number; // share of founders copied from the seed pool, as eco.poolFraction
  plants: boolean; // eats food items (and dies of poison); a species that does not passes over items
  prey: number[]; // indices of the species it eats on contact
  eatEfficiency: number; // share of a caught prey's energy the hunter gains
  eatBaseline: number; // energy gained per prey on top of that
  speed: number; // multiplier on creature.maxThrust, so on the top speed
  startEnergy: number; // founder energy; also the scale of the squashed energy inputs
  livingCost: number;
  thrustCost: number;
  turnCost: number;
  birthEnergy: number;
  birthCost: number;
  childEnergy: number;
  birthCooldown: number;
  rayCountRange: number[];
  raySpreadRange: number[]; // radians
  rayLengthRange: number[];
}

// The one species of a world without a species list: the Ecosystem's own settings. hue -1 means founders take any colour.
export function implicitSpecies(config: EcoConfig): SpeciesConfig {
  const { eco, creature: c } = config;
  return {
    name: "creature",
    hue: -1,
    founders: eco.initialPopulation,
    poolFraction: eco.poolFraction,
    plants: true,
    prey: [],
    eatEfficiency: 0,
    eatBaseline: 0,
    speed: 1,
    startEnergy: c.startEnergy,
    livingCost: c.livingCost,
    thrustCost: c.thrustCost,
    turnCost: c.turnCost,
    birthEnergy: eco.birthEnergy,
    birthCost: eco.birthCost,
    childEnergy: eco.childEnergy,
    birthCooldown: eco.birthCooldown,
    rayCountRange: eco.rayCountRange,
    raySpreadRange: eco.raySpreadRange,
    rayLengthRange: eco.rayLengthRange,
  };
}

// The species of a world: its list, or the one implicit species.
export const speciesList = (config: EcoConfig): readonly SpeciesConfig[] => (config.species?.length ? config.species : [implicitSpecies(config)]);

// The engine config a creature of species s runs on: body, costs and speed of its species. Without a species list,
// the config itself, so a one-species world computes exactly as before.
export function speciesEngine(config: EcoConfig, s: number): EngineConfig {
  if (!config.species?.length) return config;
  const sp = config.species[s]!;
  const c = config.creature;
  return {
    ...config,
    creature: { ...c, maxThrust: c.maxThrust * sp.speed, startEnergy: sp.startEnergy, livingCost: sp.livingCost, thrustCost: sp.thrustCost, turnCost: sp.turnCost },
  };
}

// Ranges for randomPlan, driftPlan and mutateStructure: the species' ray ranges with the shared brain ranges.
export function speciesRanges(config: EcoConfig, sp: SpeciesConfig): EcoConfig["eco"] {
  return { ...config.eco, rayCountRange: sp.rayCountRange, raySpreadRange: sp.raySpreadRange, rayLengthRange: sp.rayLengthRange };
}
