import { genomeLength, layerSizes } from "./brain.ts";
import type { EngineConfig } from "./config.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import type { BirthTraits } from "./planMutation.ts";
import { PLAN_LIMITS } from "./rl/validate.ts";
import type { PlanView } from "./sensors.ts";
import type { Species } from "./species.ts";
import type { Terrain } from "./terrain.ts";

// Limits of a runtime insert (insertCreature): the plan limits of a creature file (rl/validate.ts), so an uploaded creature is never bigger than one the Arena makes.
export const MAX_INSERT_RAYS = PLAN_LIMITS.rayCount[1];
export const MAX_INSERT_RAY_LENGTH = 2000;
export const MAX_INSERT_MEMORY = PLAN_LIMITS.memory[1];
export const MAX_INSERT_LAYERS = PLAN_LIMITS.layers[1];
export const MAX_INSERT_NEURONS = PLAN_LIMITS.neurons[1];
export const MAX_INSERT_ENERGY = 100000;
export const MAX_NAME_LENGTH = 24;
export const MUTATION_SCALE_RANGE = [0.25, 4] as const; // what an inserted creature's mutationScale may be

export interface InsertSpec {
  genome: ArrayLike<number>; // sized for plan
  plan: PlanView;
  species?: number; // default 0
  x: number;
  y: number;
  hue: number; // degrees
  name: string; // short tag of the new lineage
  heading?: number; // default 0
  energy?: number; // default the species' start energy
  mutationScale?: number; // default 1: multiplies the mutation std of its descendants' genomes, within MUTATION_SCALE_RANGE
  birth?: Partial<BirthTraits>; // a missing trait takes the middle of the species' range (log scale, linear for a range from 0); all are clamped into the range
}
export type InsertResult = { ok: true; id: number } | { ok: false; reason: string };

const middle = (r: readonly number[]): number => (r[0]! > 0 ? Math.sqrt(r[0]! * r[1]!) : (r[0]! + r[1]!) / 2);

// What checkInsert needs to know of the world.
export interface InsertWorld {
  config: EcoConfig;
  species: readonly Species[];
  ranges: readonly EcoConfig["eco"][]; // per species
  engines: readonly EngineConfig[]; // per species
  population: number;
  terrain: Terrain;
}
export type InsertCheck = { ok: true; genome: Float32Array; sp: number; heading: number; energy: number; mutationScale: number } | { ok: false; reason: string };

// Checks a runtime insert without changing anything; on success the birth traits of the newcomer are in traits and its genome is copied.
export function checkInsert(spec: InsertSpec, w: InsertWorld, traits: BirthTraits): InsertCheck {
  const bad = (reason: string): InsertCheck => ({ ok: false, reason });
  const { radius } = w.config.creature;
  const { width, height } = w.config.world;
  const sp = spec.species ?? 0;
  if (!Number.isInteger(sp) || sp < 0 || sp >= w.species.length) return bad(`species must be 0 to ${w.species.length - 1}`);
  if (w.population >= w.config.eco.maxPopulation) return bad("the world is full");
  const p = spec.plan;
  const finite = (...v: number[]): boolean => v.every((x) => typeof x === "number" && Number.isFinite(x));
  const whole = (x: unknown, min: number, max: number): boolean => typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
  if (!p || !whole(p.rayCount, 1, MAX_INSERT_RAYS) || !finite(p.raySpread, p.rayLength) || !(p.raySpread > 0 && p.raySpread <= 2 * Math.PI) || !(p.rayLength > 0 && p.rayLength <= MAX_INSERT_RAY_LENGTH)) return bad(`plan needs 1 to ${MAX_INSERT_RAYS} rays, a spread up to a full turn and a ray length up to ${MAX_INSERT_RAY_LENGTH}`);
  if (!whole(p.memoryShort, 0, MAX_INSERT_MEMORY) || !whole(p.memoryLong, 0, MAX_INSERT_MEMORY)) return bad(`memory units must be whole numbers 0 to ${MAX_INSERT_MEMORY}`);
  if (!Array.isArray(p.hiddenLayers) || !whole(p.hiddenLayers.length, 1, MAX_INSERT_LAYERS) || !p.hiddenLayers.every((n) => whole(n, 1, MAX_INSERT_NEURONS))) return bad(`plan needs 1 to ${MAX_INSERT_LAYERS} hidden layers of 1 to ${MAX_INSERT_NEURONS} neurons`);
  if (!finite(spec.x, spec.y) || spec.x < radius || spec.x > width - radius || spec.y < radius || spec.y > height - radius) return bad("position must be inside the walls");
  if (w.terrain.touchesRock(spec.x, spec.y, radius)) return bad("position must be clear of rock");
  if (!finite(spec.hue)) return bad("hue must be a finite number");
  const heading = spec.heading ?? 0;
  if (!finite(heading)) return bad("heading must be a finite number");
  const energy = spec.energy ?? w.species[sp]!.startEnergy;
  if (!finite(energy) || energy <= 0 || energy > MAX_INSERT_ENERGY) return bad(`energy must be above 0 and at most ${MAX_INSERT_ENERGY}`);
  if (typeof spec.name !== "string" || spec.name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(spec.name)) return bad(`name must be text of at most ${MAX_NAME_LENGTH} characters without control characters`);
  const mutationScale = spec.mutationScale ?? 1;
  if (!finite(mutationScale) || mutationScale < MUTATION_SCALE_RANGE[0] || mutationScale > MUTATION_SCALE_RANGE[1]) return bad(`mutationScale must be a number from ${MUTATION_SCALE_RANGE[0]} to ${MUTATION_SCALE_RANGE[1]}`);
  const ranges = w.ranges[sp]!;
  traits.energy = spec.birth?.energy ?? middle(ranges.birthEnergyRange);
  traits.cost = spec.birth?.cost ?? middle(ranges.birthCostRange);
  traits.cooldown = spec.birth?.cooldown ?? middle(ranges.birthCooldownRange);
  if (!finite(traits.energy, traits.cost, traits.cooldown) || traits.energy <= 0 || traits.cost <= 0 || traits.cooldown < 0) return bad("birth energy and cost must be above 0 and the cooldown 0 or more");
  traits.energy = Math.min(ranges.birthEnergyRange[1]!, Math.max(ranges.birthEnergyRange[0]!, traits.energy));
  traits.cost = Math.min(ranges.birthCostRange[1]!, Math.max(ranges.birthCostRange[0]!, traits.cost));
  traits.cooldown = Math.min(ranges.birthCooldownRange[1]!, Math.max(ranges.birthCooldownRange[0]!, traits.cooldown));
  const need = genomeLength(layerSizes(w.engines[sp]!, p));
  const given = spec.genome?.length;
  if (given !== need) return bad(`genome has ${String(given)} numbers, the plan needs ${need}`);
  const genome = Float32Array.from(spec.genome);
  if (!genome.every(Number.isFinite)) return bad("genome must hold finite numbers");
  return { ok: true, genome, sp, heading, energy, mutationScale };
}
