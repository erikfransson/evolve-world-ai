// All tunable values of a run. Units: world units, seconds, energy points.

export type SelectionMethod = "truncation" | "proportional";

// Poison damage at or above this kills outright; below it poison drains that much energy.
export const POISON_LETHAL = 100;

export interface SimConfig {
  seed: number;
  dt: number; // seconds per tick
  world: {
    width: number;
    height: number;
    foodDensity: number; // 0 none, 1 about one item per DENSITY_CELL x DENSITY_CELL area
    poisonDensity: number; // same scale as foodDensity
    respawn: boolean; // eaten items reappear elsewhere; false makes food finite so lives end naturally
    itemRadius: number;
    foodEnergy: number;
    poisonDamage: number; // energy one poison item drains, POISON_LETHAL or more kills
    poisonClearRadius: number; // Trials: no poison starts this close to the creature
  };
  creature: {
    radius: number;
    startEnergy: number; // no upper limit on stored energy
    livingCost: number; // energy per second
    thrustCost: number; // energy per second at full thrust
    turnCost: number; // energy per second at full turn rate
    rayCost: number; // energy per second per ray of length 100, linear in length
    neuronCost: number; // energy per second per hidden neuron and memory unit
    maxThrust: number; // forward acceleration at full thrust, units/s^2; top speed = maxThrust / drag
    brakeThreshold: number; // thrust output below this brakes at maxBrake, between it and 0 the creature coasts
    maxBrake: number; // fixed deceleration while braking, units/s^2; free, never reverses
    wallBounce: number; // restitution of the walls in [0, 1]; 0 absorbs the velocity into the wall
    drag: number; // forward velocity decay rate, 1/s
    sideDrag: number; // sideways velocity decay rate, 1/s; higher than drag gives fish-like gliding turns
    maxTurnRate: number; // radians per second at full turn output
    turnDamping: number; // rate at which turning speed approaches its target, 1/s
    // rayCount, raySpread, rayLength and the brain's layers and memory form the config's body plan (planOf).
    rayCount: number;
    raySpread: number; // total fan angle in radians
    rayLength: number;
    seesCreatures: boolean; // rays also report other creatures (Ecosystem); changes the brain input layout
    maxLifeSeconds: number; // safety stop only, normally a life ends when energy runs out
  };
  brain: {
    hiddenLayers: number[]; // neurons per hidden layer, 1 to 4 layers of 4 to 32
    memory: number; // 0 to 1, see memoryUnits; each unit is a leaky average of one brain output fed back as an input next tick
    shortRate: number; // per tick: m += rate * (target - m)
    longRate: number;
  };
  population: {
    size: number;
  };
  ga: {
    selection: SelectionMethod;
    eliteFraction: number; // copied unchanged
    parentFraction: number; // truncation: top fraction allowed to breed
    crossover: boolean; // uniform crossover between two parents
    mutationRate: number; // probability per gene
    mutationStd: number; // std of Gaussian added to a mutated gene
    immigrantFraction: number; // share of each new generation that is fresh random genomes
    bigMutationFraction: number; // share of the children that get a large mutation (some genes flip sign)
  };
}

// The parts every mode shares; population and ga belong to Trials.
export type EngineConfig = Pick<SimConfig, "seed" | "dt" | "world" | "creature" | "brain">;

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  dt: 1 / 30,
  world: {
    width: 1600,
    height: 1000,
    foodDensity: 0.7,
    poisonDensity: 0.1,
    respawn: false,
    itemRadius: 4,
    foodEnergy: 20,
    poisonDamage: POISON_LETHAL,
    poisonClearRadius: 150,
  },
  creature: {
    radius: 12,
    startEnergy: 75,
    livingCost: 2,
    thrustCost: 4,
    turnCost: 0.5,
    rayCost: 0.02,
    neuronCost: 0.005,
    maxThrust: 200,
    brakeThreshold: -0.5,
    maxBrake: 200,
    wallBounce: 0.6,
    drag: 2.5,
    sideDrag: 8,
    maxTurnRate: 3,
    turnDamping: 6,
    rayCount: 8,
    raySpread: (125 * Math.PI) / 180,
    rayLength: 150,
    seesCreatures: false,
    maxLifeSeconds: 3600,
  },
  brain: { hiddenLayers: [6], memory: 0.25, shortRate: 0.3, longRate: 0.01 },
  population: { size: 150 },
  ga: {
    selection: "truncation",
    eliteFraction: 0.02,
    parentFraction: 0.1,
    crossover: true,
    mutationRate: 0.05,
    mutationStd: 0.3,
    immigrantFraction: 0.05,
    bigMutationFraction: 0.05,
  },
};

const MEMORY_UNITS = 16; // memory units at brain.memory 1, about 46% of the weights of the default brain

// Short and long memory units for a memory setting in [0, 1], independent of the network size; the odd unit is short-term.
export function memoryUnits(memory: number): { short: number; long: number } {
  const units = Math.round(MEMORY_UNITS * Math.min(1, Math.max(0, memory)));
  return { short: Math.ceil(units / 2), long: Math.floor(units / 2) };
}

const DENSITY_CELL = 100; // world units; density 1 = one item per 100 x 100 area

// Items at density 1 on this world. Independent of rayLength, so changing the vision range does not change the amount of food.
export function itemsPerDensity(config: Pick<EngineConfig, "world">): number {
  return (config.world.width * config.world.height) / DENSITY_CELL ** 2;
}

export function itemCounts(config: Pick<EngineConfig, "world">): { food: number; poison: number } {
  const perUnit = itemsPerDensity(config);
  return {
    food: Math.round(config.world.foodDensity * perUnit),
    poison: Math.round(config.world.poisonDensity * perUnit),
  };
}

export function maxLifeTicks(config: EngineConfig): number {
  return Math.round(config.creature.maxLifeSeconds / config.dt);
}

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const describe = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

// Writes over into target, which has the shape of a SimConfig branch. Arrays and scalars are replaced.
function applyOverrides(target: Record<string, unknown>, over: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(over)) {
    const where = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(target, key)) throw new Error(`unknown config key "${where}"`);
    if (value === undefined) continue;
    const current = target[key];
    if (isPlain(current)) {
      if (!isPlain(value)) throw new Error(`config "${where}" must be an object, got ${describe(value)}`);
      applyOverrides(current, value, where);
    } else if (Array.isArray(current)) {
      if (!Array.isArray(value)) throw new Error(`config "${where}" must be an array, got ${describe(value)}`);
      const itemType = typeof current[0];
      value.forEach((item, i) => {
        if (current.length > 0 && typeof item !== itemType) {
          throw new Error(`config "${where}[${i}]" must be a ${itemType}, got ${describe(item)}`);
        }
      });
      target[key] = value.slice();
    } else {
      if (typeof value !== typeof current) throw new Error(`config "${where}" must be a ${typeof current}, got ${describe(value)}`);
      target[key] = value;
    }
  }
}

// Returns a copy of base with overrides applied. Throws on unknown keys or values of the wrong type.
export function overrideConfig<T extends object>(base: T, overrides: DeepPartial<T>): T {
  if (!isPlain(overrides)) throw new Error(`config overrides must be an object, got ${describe(overrides)}`);
  const config = structuredClone(base);
  applyOverrides(config as Record<string, unknown>, overrides, "");
  return config;
}

export const withOverrides = (base: SimConfig, overrides: DeepPartial<SimConfig>): SimConfig => overrideConfig<SimConfig>(base, overrides);
