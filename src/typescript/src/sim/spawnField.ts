import type { Rng } from "./types.ts";

// Where items (kind 0 food, 1 poison) may appear. A hand-designed map is one field (MapWeights); the random map uses UNIFORM_FIELD.
export interface SpawnField {
  usable(kind: number): boolean; // false when nowhere has weight for the kind
  accepts(kind: number, x: number, y: number, rng: Rng): boolean; // a draw from the field; UNIFORM_FIELD takes every spot and draws nothing
  limits(kind: number, density: number, perDensity: number): Int32Array | null; // items allowed per cap cell, null without local caps
  readonly exact: boolean; // false when a spot that used up its tries is as good as any other
}

export const UNIFORM_FIELD: SpawnField = { usable: () => true, accepts: () => true, limits: () => null, exact: false };
