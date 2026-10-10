import type { SimConfig } from "./config.ts";
import { HIT_FOOD, HIT_POISON, HIT_WALL } from "./types.ts";
import type { CreatureState, RayHit } from "./types.ts";

// Brain input layout: per ray these features, then the extras below.
export const RAY_FEATURE_LABELS = ["closeness", "food", "poison", "wall"] as const;
export const RAY_FEATURES = RAY_FEATURE_LABELS.length;
export const FEAT_CLOSENESS = 0;
export const FEAT_FOOD = 1;
export const FEAT_POISON = 2;
export const FEAT_WALL = 3;
export const INPUT_EXTRA_LABELS = ["energy", "speed", "lateral", "turn"] as const; // speed is forward, lateral is sideways
export const EXTRA_INPUTS = INPUT_EXTRA_LABELS.length;
// Brain outputs: turn and thrust (negative thrust acts as 0).
export const OUTPUT_LABELS = ["turn", "thrust"] as const;
export const OUTPUT_SIZE = OUTPUT_LABELS.length;
export const OUT_TURN = 0;
export const OUT_THRUST = 1;

export function inputSize(config: SimConfig): number {
  return config.creature.rayCount * RAY_FEATURES + EXTRA_INPUTS;
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

// Stored energy is unbounded, so squash it to [0, 1).
export function energySignal(energy: number, startEnergy: number): number {
  return 1 - Math.exp(-energy / startEnergy);
}

// Extras: squashed energy, forward and sideways speed / top speed, turnRate / maxTurnRate. Allocation-free.
export function encodeInputs(state: CreatureState, rays: readonly RayHit[], config: SimConfig, out: Float32Array, cosHeading: number, sinHeading: number): void {
  const c = config.creature;
  for (let i = 0; i < rays.length; i++) {
    const ray = rays[i];
    const k = i * RAY_FEATURES;
    out[k + FEAT_CLOSENESS] = ray.closeness;
    out[k + FEAT_FOOD] = ray.kind === HIT_FOOD ? 1 : 0;
    out[k + FEAT_POISON] = ray.kind === HIT_POISON ? 1 : 0;
    out[k + FEAT_WALL] = ray.kind === HIT_WALL ? 1 : 0;
  }
  const base = rays.length * RAY_FEATURES;
  out[base] = energySignal(state.energy, c.startEnergy);
  out[base + 1] = ((state.vx * cosHeading + state.vy * sinHeading) * c.drag) / c.maxThrust;
  out[base + 2] = ((state.vy * cosHeading - state.vx * sinHeading) * c.drag) / c.maxThrust;
  out[base + 3] = state.turnRate / c.maxTurnRate;
}
