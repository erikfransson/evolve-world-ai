// Shared contracts between simulation modules, the worker and the renderer.

export type Genome = Float32Array;

export const HIT_NONE = 0;
export const HIT_FOOD = 1;
export const HIT_POISON = 2;
export const HIT_WALL = 3;
export type HitKind = typeof HIT_NONE | typeof HIT_FOOD | typeof HIT_POISON | typeof HIT_WALL;

export interface Rng {
  next(): number; // uniform in [0, 1)
  range(min: number, max: number): number;
  int(maxExclusive: number): number;
  normal(): number; // standard normal
}

export interface RayHit {
  closeness: number; // 0 nothing within range, 1 touching
  kind: HitKind;
}

export interface CreatureState {
  x: number;
  y: number;
  heading: number; // radians, 0 = +x
  vx: number;
  vy: number;
  turnRate: number; // radians per second
  energy: number;
  alive: boolean;
  ticksAlive: number;
}

// Read-only view of a world's item slots.
export interface WorldView {
  readonly count: number; // slot capacity
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly kinds: Uint8Array; // HIT_FOOD or HIT_POISON, HIT_NONE for a free slot
}

// What the replay draws of a creature it plays back rather than simulates.
export type PlaybackState = Pick<CreatureState, "x" | "y" | "heading" | "energy" | "alive">;

export interface EpisodeView {
  readonly state: CreatureState;
  readonly rays: readonly RayHit[]; // last sensed, one per ray
  readonly rayOffsets: Float32Array; // ray i points at heading + rayOffsets[i]; treat as read-only
  readonly world: WorldView;
}

export interface GenerationResult {
  generation: number;
  layoutSeed: number;
  fitness: Float64Array; // per creature, seconds survived plus energy tiebreak
  bestIndex: number;
  bestFitness: number;
  meanFitness: number;
}
