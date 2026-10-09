// All tunable values of a run. Units: world units, seconds, energy points.

export type SelectionMethod = "truncation" | "proportional" | "tournament";

export interface SimConfig {
  seed: number;
  dt: number; // seconds per tick
  world: {
    width: number;
    height: number;
    foodDensity: number; // 0 none, 1 about one item per rayLength x rayLength area
    poisonDensity: number; // same scale as foodDensity
    respawn: boolean; // eaten items reappear elsewhere; false makes food finite so lives end naturally
    itemRadius: number;
    foodEnergy: number;
    poisonEnergy: number; // removed when eaten; above maxEnergy makes poison always lethal
  };
  creature: {
    radius: number;
    maxEnergy: number;
    startEnergy: number;
    livingCost: number; // energy per second
    thrustCost: number; // energy per second at full thrust
    maxThrust: number; // forward acceleration at full thrust, units/s^2; top speed = maxThrust / drag
    drag: number; // forward velocity decay rate, 1/s
    sideDrag: number; // sideways velocity decay rate, 1/s; higher than drag gives fish-like gliding turns
    maxTurnRate: number; // radians per second at full turn output
    turnDamping: number; // rate at which turning speed approaches its target, 1/s
    rayCount: number;
    raySpread: number; // total fan angle in radians
    rayLength: number;
  };
  brain: {
    hiddenLayers: number[]; // neurons per hidden layer, 1 to 4 layers of 4 to 32
  };
  population: {
    size: number;
    epochSeconds: number; // safety stop only, normally lives end when energy runs out
  };
  ga: {
    selection: SelectionMethod;
    eliteFraction: number; // copied unchanged
    parentFraction: number; // truncation: top fraction allowed to breed
    tournamentSize: number;
    crossover: boolean; // uniform crossover between two parents
    mutationRate: number; // probability per gene
    mutationStd: number; // std of Gaussian added to a mutated gene
  };
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  dt: 1 / 30,
  world: {
    width: 1600,
    height: 1000,
    foodDensity: 0.5,
    poisonDensity: 0.1,
    respawn: false,
    itemRadius: 4,
    foodEnergy: 20,
    poisonEnergy: 200,
  },
  creature: {
    radius: 6,
    maxEnergy: 100,
    startEnergy: 50,
    livingCost: 1,
    thrustCost: 2,
    maxThrust: 120,
    drag: 1.5,
    sideDrag: 8,
    maxTurnRate: 3,
    turnDamping: 6,
    rayCount: 8,
    raySpread: (75 * Math.PI) / 180,
    rayLength: 100,
  },
  brain: { hiddenLayers: [16] },
  population: { size: 150, epochSeconds: 3600 },
  ga: {
    selection: "truncation",
    eliteFraction: 0.02,
    parentFraction: 0.1,
    tournamentSize: 3,
    crossover: true,
    mutationRate: 0.05,
    mutationStd: 0.3,
  },
};

// Density 1 means one item per rayLength^2 of area on average, so something is usually in view.
export function itemCounts(config: SimConfig): { food: number; poison: number } {
  const perUnit = (config.world.width * config.world.height) / config.creature.rayLength ** 2;
  return {
    food: Math.round(config.world.foodDensity * perUnit),
    poison: Math.round(config.world.poisonDensity * perUnit),
  };
}

export function epochTicks(config: SimConfig): number {
  return Math.round(config.population.epochSeconds / config.dt);
}

// Ray i points at heading + offsets[i], spread evenly from -spread/2 to +spread/2.
// A full circle leaves out the last endpoint so no two rays coincide behind the creature.
export function rayAngleOffsets(config: SimConfig): Float32Array {
  const { rayCount, raySpread } = config.creature;
  const offsets = new Float32Array(rayCount);
  const gaps = raySpread >= 2 * Math.PI - 1e-9 ? rayCount : rayCount - 1;
  for (let i = 0; i < rayCount; i++) {
    offsets[i] = rayCount === 1 ? 0 : -raySpread / 2 + (raySpread * i) / gaps;
  }
  return offsets;
}
