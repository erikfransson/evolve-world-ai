// All tunable values of a run. Units: world units, seconds, energy points.

export type SelectionMethod = "truncation" | "proportional" | "tournament";

export interface SimConfig {
  seed: number;
  dt: number; // seconds per tick
  world: {
    width: number;
    height: number;
    foodCount: number;
    poisonEnabled: boolean;
    poisonCount: number;
    itemRadius: number;
    foodEnergy: number;
    poisonEnergy: number; // removed when eaten
  };
  creature: {
    radius: number;
    maxEnergy: number;
    startEnergy: number;
    livingCost: number; // energy per second
    moveCost: number; // energy per world unit travelled
    accelCost: number; // energy per (unit/s^2) of acceleration per second
    maxSpeed: number; // units per second, no reversing
    maxAccel: number; // units per second^2
    maxTurnRate: number; // radians per second
    rayCount: number;
    raySpread: number; // total fan angle in radians
    rayLength: number;
  };
  brain: {
    hiddenLayers: number[]; // neurons per hidden layer, 1 to 4 layers of 4 to 32
  };
  population: {
    size: number;
    epochSeconds: number;
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
    width: 1000,
    height: 1000,
    foodCount: 150,
    poisonEnabled: true,
    poisonCount: 60,
    itemRadius: 4,
    foodEnergy: 20,
    poisonEnergy: 35,
  },
  creature: {
    radius: 6,
    maxEnergy: 100,
    startEnergy: 50,
    livingCost: 1,
    moveCost: 0.01,
    accelCost: 0.002,
    maxSpeed: 80,
    maxAccel: 160,
    maxTurnRate: 3,
    rayCount: 8,
    raySpread: (75 * Math.PI) / 180,
    rayLength: 100,
  },
  brain: { hiddenLayers: [16] },
  population: { size: 300, epochSeconds: 120 },
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

export function epochTicks(config: SimConfig): number {
  return Math.round(config.population.epochSeconds / config.dt);
}

// Ray i points at heading + offsets[i], spread evenly from -spread/2 to +spread/2.
export function rayAngleOffsets(config: SimConfig): Float32Array {
  const { rayCount, raySpread } = config.creature;
  const offsets = new Float32Array(rayCount);
  for (let i = 0; i < rayCount; i++) {
    offsets[i] = rayCount === 1 ? 0 : -raySpread / 2 + (raySpread * i) / (rayCount - 1);
  }
  return offsets;
}
