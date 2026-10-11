import { memoryUnits } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { HIT_CREATURE, HIT_FOOD, HIT_POISON, HIT_WALL } from "./types.ts";
import type { CreatureState, RayHit } from "./types.ts";

// A creature's body plan: senses and brain shape. Its genome is the plan plus a weight vector sized by layerSizes.
// Plain data, so it serialises as JSON.
export interface BodyPlan {
  rayCount: number;
  raySpread: number; // total fan angle in radians
  rayLength: number;
  hiddenLayers: number[]; // neurons per hidden layer
  memoryShort: number; // leaky memory units at brain.shortRate per tick
  memoryLong: number; // at brain.longRate
}

// A plan that callers may read but not change.
export type PlanView = Readonly<Omit<BodyPlan, "hiddenLayers">> & { readonly hiddenLayers: readonly number[] };

// The plan a config describes; Trials uses it for every creature.
export function planOf(config: EngineConfig): BodyPlan {
  const { rayCount, raySpread, rayLength } = config.creature;
  const { short, long } = memoryUnits(config.brain.memory);
  return { rayCount, raySpread, rayLength, hiddenLayers: config.brain.hiddenLayers.slice(), memoryShort: short, memoryLong: long };
}

// Copies from into to without allocating.
export function copyPlan(from: PlanView, to: BodyPlan): void {
  to.rayCount = from.rayCount;
  to.raySpread = from.raySpread;
  to.rayLength = from.rayLength;
  to.hiddenLayers.length = from.hiddenLayers.length;
  for (let i = 0; i < from.hiddenLayers.length; i++) to.hiddenLayers[i] = from.hiddenLayers[i]!;
  to.memoryShort = from.memoryShort;
  to.memoryLong = from.memoryLong;
}

// Brain input layout: per ray these features, then the extras, then the memory units (short first). inputLayout picks the ray features for a config.
// With creature features, one flag per species follows the wall (a single "creature" flag without a species list), then the seen energy.
export const RAY_FEATURE_LABELS = ["closeness", "food", "poison", "wall"] as const;
export const RAY_FEATURES = RAY_FEATURE_LABELS.length; // without creature features, as in Trials
export const CREATURE_RAY_FEATURE_LABELS = [...RAY_FEATURE_LABELS, "creature", "seen energy"] as const;
export const FEAT_CLOSENESS = 0;
export const FEAT_FOOD = 1;
export const FEAT_POISON = 2;
export const FEAT_WALL = 3;
export const FEAT_CREATURE = 4; // the first species flag
export const FEAT_SEEN_ENERGY = 5; // with one species; in general the last ray feature
export const INPUT_EXTRA_LABELS = ["energy", "speed", "lateral", "turn", "terrain"] as const; // speed is forward, lateral is sideways; terrain is -1 slow, 0 normal, 1 fast ground under the creature
export const EXTRA_INPUTS = INPUT_EXTRA_LABELS.length;
export const EXTRA_TERRAIN = 4; // index of the terrain input among the extras

// Brain outputs: turn and thrust (thrust below brakeThreshold brakes), then one target per memory unit.
export const OUTPUT_LABELS = ["turn", "thrust"] as const;
export const OUTPUT_SIZE = OUTPUT_LABELS.length; // outputs without memory targets
export const OUT_TURN = 0;
export const OUT_THRUST = 1;

export interface InputLayout {
  readonly rayFeatureLabels: readonly string[];
  readonly rayFeatures: number;
  readonly rays: number;
  readonly extras: readonly string[];
  readonly memoryShort: number;
  readonly memoryLong: number;
  readonly terrainAt: number; // input index of the terrain input
  readonly memoryAt: number; // input index of the first memory unit; its target is output OUTPUT_SIZE + unit
  readonly memoryLabels: readonly string[]; // s1.., l1.., for both the memory inputs and their targets
  readonly size: number; // rays * rayFeatures + EXTRA_INPUTS + memory units
  readonly outputs: number; // OUTPUT_SIZE + memory units
}

// Ray feature labels for creatures that see the given number of species (1 without a species list).
export const speciesFeatureLabels = (names: readonly string[]): readonly string[] =>
  names.length > 1 ? [...RAY_FEATURE_LABELS, ...names, "seen energy"] : CREATURE_RAY_FEATURE_LABELS;

const rayFeatureLabels = (config: EngineConfig): readonly string[] =>
  !config.creature.seesCreatures ? RAY_FEATURE_LABELS : config.species && config.species.length > 1 ? speciesFeatureLabels(config.species.map((s) => s.name)) : CREATURE_RAY_FEATURE_LABELS;

// rayFeatureLabels(config).length without allocating.
export function rayFeatureCount(config: EngineConfig): number {
  if (!config.creature.seesCreatures) return RAY_FEATURES;
  const species = config.species?.length ?? 1;
  return RAY_FEATURES + Math.max(1, species) + 1;
}

export function inputLayout(config: EngineConfig, plan: PlanView = planOf(config)): InputLayout {
  const labels = rayFeatureLabels(config);
  const rays = plan.rayCount;
  const { memoryShort, memoryLong } = plan;
  const memory = memoryShort + memoryLong;
  const memoryAt = rays * labels.length + EXTRA_INPUTS;
  const terrainAt = rays * labels.length + EXTRA_TERRAIN;
  const memoryLabels = [...Array.from({ length: memoryShort }, (_, i) => `s${i + 1}`), ...Array.from({ length: memoryLong }, (_, i) => `l${i + 1}`)];
  return {
    rayFeatureLabels: labels,
    rayFeatures: labels.length,
    rays,
    extras: INPUT_EXTRA_LABELS,
    memoryShort,
    memoryLong,
    terrainAt,
    memoryAt,
    memoryLabels,
    size: memoryAt + memory,
    outputs: OUTPUT_SIZE + memory,
  };
}

export function inputSize(config: EngineConfig, plan?: BodyPlan): number {
  return inputLayout(config, plan).size;
}

// Thrust command for stepBody from the raw thrust output: below brakeThreshold a full brake (-1), otherwise coasting or thrust.
export function thrustCommand(out: number, brakeThreshold: number): number {
  return out < brakeThreshold ? -1 : Math.max(0, out);
}

// Energy per second a creature of this plan pays besides thrust and turning: living, sensing and neurons.
export function planUpkeep(plan: PlanView, config: EngineConfig): number {
  const c = config.creature;
  let neurons = plan.memoryShort + plan.memoryLong;
  for (const n of plan.hiddenLayers) neurons += n;
  return c.livingCost + (c.rayCost * plan.rayCount * plan.rayLength) / 100 + c.neuronCost * neurons;
}

// Ray i points at heading + offsets[i], spread evenly from -spread/2 to +spread/2.
// A full circle leaves out the last endpoint so no two rays coincide behind the creature.
export function rayAngleOffsets(plan: Pick<BodyPlan, "rayCount" | "raySpread">, offsets = new Float32Array(plan.rayCount)): Float32Array {
  const { rayCount, raySpread } = plan;
  const gaps = raySpread >= 2 * Math.PI - 1e-9 ? rayCount : rayCount - 1;
  for (let i = 0; i < rayCount; i++) {
    offsets[i] = rayCount === 1 ? 0 : -raySpread / 2 + (raySpread * i) / gaps;
  }
  return offsets;
}

// Stored energy is unbounded, so squash it to [0, 1).
export function energySignal(energy: number, startEnergy: number): number {
  return 1 - Math.exp(-energy / startEnergy);
}

// Extras: squashed energy, forward and sideways speed / top speed, turnRate / maxTurnRate, terrain (valueAt of the ground). Allocation-free.
export function encodeInputs(state: CreatureState, rays: readonly RayHit[], config: EngineConfig, out: Float32Array, cosHeading: number, sinHeading: number, terrain = 0): void {
  const c = config.creature;
  const stride = rayFeatureCount(config);
  for (let i = 0; i < rays.length; i++) {
    const ray = rays[i];
    const k = i * stride;
    out[k + FEAT_CLOSENESS] = ray.closeness;
    out[k + FEAT_FOOD] = ray.kind === HIT_FOOD ? 1 : 0;
    out[k + FEAT_POISON] = ray.kind === HIT_POISON ? 1 : 0;
    out[k + FEAT_WALL] = ray.kind === HIT_WALL ? 1 : 0;
    if (stride > RAY_FEATURES) {
      const seen = ray.kind === HIT_CREATURE;
      for (let f = FEAT_CREATURE; f < stride - 1; f++) out[k + f] = 0;
      if (seen) out[k + FEAT_CREATURE + ray.species] = 1;
      out[k + stride - 1] = seen ? energySignal(ray.energy, config.seenEnergyScale ?? c.startEnergy) : 0;
    }
  }
  const base = rays.length * stride;
  out[base] = energySignal(state.energy, c.startEnergy);
  out[base + 1] = ((state.vx * cosHeading + state.vy * sinHeading) * c.drag) / c.maxThrust;
  out[base + 2] = ((state.vy * cosHeading - state.vx * sinHeading) * c.drag) / c.maxThrust;
  out[base + 3] = state.turnRate / c.maxTurnRate;
  out[base + EXTRA_TERRAIN] = terrain;
}
