import type { EngineConfig } from "./config.ts";
import { HIT_CREATURE, HIT_FOOD, HIT_POISON, HIT_WALL } from "./types.ts";
import type { CreatureState, RayHit } from "./types.ts";

// Brain input layout: per ray these features, then the extras below. inputLayout picks the ray features for a config.
export const RAY_FEATURE_LABELS = ["closeness", "food", "poison", "wall"] as const;
export const RAY_FEATURES = RAY_FEATURE_LABELS.length; // without creature features, as in Trials
export const CREATURE_RAY_FEATURE_LABELS = [...RAY_FEATURE_LABELS, "creature", "seen energy"] as const;
export const FEAT_CLOSENESS = 0;
export const FEAT_FOOD = 1;
export const FEAT_POISON = 2;
export const FEAT_WALL = 3;
export const FEAT_CREATURE = 4;
export const FEAT_SEEN_ENERGY = 5;
export const INPUT_EXTRA_LABELS = ["energy", "speed", "lateral", "turn"] as const; // speed is forward, lateral is sideways
export const EXTRA_INPUTS = INPUT_EXTRA_LABELS.length;

export interface InputLayout {
  readonly rayFeatureLabels: readonly string[];
  readonly rayFeatures: number;
  readonly rays: number;
  readonly size: number; // rays * rayFeatures + EXTRA_INPUTS
}

const rayFeatureLabels = (config: EngineConfig): readonly string[] =>
  config.creature.seesCreatures ? CREATURE_RAY_FEATURE_LABELS : RAY_FEATURE_LABELS;

export function inputLayout(config: EngineConfig): InputLayout {
  const labels = rayFeatureLabels(config);
  const rays = config.creature.rayCount;
  return { rayFeatureLabels: labels, rayFeatures: labels.length, rays, size: rays * labels.length + EXTRA_INPUTS };
}

// Brain outputs: turn and thrust (negative thrust acts as 0).
export const OUTPUT_LABELS = ["turn", "thrust"] as const;
export const OUTPUT_SIZE = OUTPUT_LABELS.length;
export const OUT_TURN = 0;
export const OUT_THRUST = 1;

export function inputSize(config: EngineConfig): number {
  return inputLayout(config).size;
}

// Ray i points at heading + offsets[i], spread evenly from -spread/2 to +spread/2.
// A full circle leaves out the last endpoint so no two rays coincide behind the creature.
export function rayAngleOffsets(config: EngineConfig): Float32Array {
  const { rayCount, raySpread } = config.creature;
  const offsets = new Float32Array(rayCount);
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

// Extras: squashed energy, forward and sideways speed / top speed, turnRate / maxTurnRate. Allocation-free.
export function encodeInputs(state: CreatureState, rays: readonly RayHit[], config: EngineConfig, out: Float32Array, cosHeading: number, sinHeading: number): void {
  const c = config.creature;
  const stride = rayFeatureLabels(config).length;
  for (let i = 0; i < rays.length; i++) {
    const ray = rays[i];
    const k = i * stride;
    out[k + FEAT_CLOSENESS] = ray.closeness;
    out[k + FEAT_FOOD] = ray.kind === HIT_FOOD ? 1 : 0;
    out[k + FEAT_POISON] = ray.kind === HIT_POISON ? 1 : 0;
    out[k + FEAT_WALL] = ray.kind === HIT_WALL ? 1 : 0;
    if (stride > RAY_FEATURES) {
      const seen = ray.kind === HIT_CREATURE;
      out[k + FEAT_CREATURE] = seen ? 1 : 0;
      out[k + FEAT_SEEN_ENERGY] = seen ? energySignal(ray.energy, c.startEnergy) : 0;
    }
  }
  const base = rays.length * stride;
  out[base] = energySignal(state.energy, c.startEnergy);
  out[base + 1] = ((state.vx * cosHeading + state.vy * sinHeading) * c.drag) / c.maxThrust;
  out[base + 2] = ((state.vy * cosHeading - state.vx * sinHeading) * c.drag) / c.maxThrust;
  out[base + 3] = state.turnRate / c.maxTurnRate;
}
