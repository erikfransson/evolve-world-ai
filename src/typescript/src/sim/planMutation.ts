import type { EcoConfig } from "./ecoConfig.ts";
import { OUTPUT_SIZE } from "./sensors.ts";
import type { BodyPlan, InputLayout } from "./sensors.ts";
import type { Genome, Rng } from "./types.ts";

// Body plan variation in the Ecosystem: varied founders, drift and structural mutations with weight remapping.

type PlanRanges = Pick<EcoConfig["eco"], "rayCountRange" | "raySpreadRange" | "rayLengthRange" | "hiddenRange" | "memoryRange">;

const clamp = (v: number, range: readonly number[]): number => Math.min(range[1]!, Math.max(range[0]!, v));
const randInt = (range: readonly number[], rng: Rng): number => range[0]! + rng.int(range[1]! - range[0]! + 1);

// Draws a founder plan from the ranges into out, with as many hidden layers as out already has.
export function randomPlan(eco: PlanRanges, rng: Rng, out: BodyPlan): void {
  out.rayCount = randInt(eco.rayCountRange, rng);
  out.raySpread = rng.range(eco.raySpreadRange[0]!, eco.raySpreadRange[1]!);
  out.rayLength = rng.range(eco.rayLengthRange[0]!, eco.rayLengthRange[1]!);
  for (let l = 0; l < out.hiddenLayers.length; l++) out.hiddenLayers[l] = randInt(eco.hiddenRange, rng);
  out.memoryShort = randInt(eco.memoryRange, rng);
  out.memoryLong = randInt(eco.memoryRange, rng);
}

// Scales ray spread and length by 1 + drift x a standard normal each, kept within the ranges.
export function driftPlan(plan: BodyPlan, drift: number, eco: PlanRanges, rng: Rng): void {
  plan.raySpread = clamp(plan.raySpread * (1 + drift * rng.normal()), eco.raySpreadRange);
  plan.rayLength = clamp(plan.rayLength * (1 + drift * rng.normal()), eco.rayLengthRange);
}

// Per layer of the new network, the old index of each unit, or -1 for a new unit.
export type UnitMaps = Int32Array[];

function identity(n: number): Int32Array {
  return Int32Array.from({ length: n }, (_, j) => j);
}

// n units with count new ones at index at.
function inserted(n: number, at: number, count: number): Int32Array {
  return Int32Array.from({ length: n + count }, (_, j) => (j < at ? j : j < at + count ? -1 : j - count));
}

// n units without the count from index at.
function removed(n: number, at: number, count: number): Int32Array {
  return Int32Array.from({ length: n - count }, (_, j) => (j < at ? j : j + count));
}

// +1 grows, -1 shrinks, 0 when neither fits the range; the preferred direction first.
function direction(grow: boolean, n: number, range: readonly number[]): number {
  const up = n < range[1]! ? 1 : 0;
  const down = n > range[0]! ? -1 : 0;
  return grow ? up || down : down || up;
}

// Adds or removes one ray, hidden neuron or memory unit of plan in place, chosen at random within the ranges.
// layout and sizes describe the plan before the change. Returns the unit maps for remapWeights, or null when nothing changed.
export function mutateStructure(plan: BodyPlan, layout: InputLayout, sizes: readonly number[], eco: PlanRanges, rng: Rng): UnitMaps | null {
  const kind = rng.int(3);
  const grow = rng.next() < 0.5;
  const maps = sizes.map((n) => identity(n));
  const nIn = sizes[0]!;
  const nOut = sizes[sizes.length - 1]!;
  if (kind === 0) {
    const dir = direction(grow, plan.rayCount, eco.rayCountRange);
    if (dir === 0) return null;
    const F = layout.rayFeatures;
    const at = rng.int(dir > 0 ? plan.rayCount + 1 : plan.rayCount);
    maps[0] = dir > 0 ? inserted(nIn, at * F, F) : removed(nIn, at * F, F);
    plan.rayCount += dir;
  } else if (kind === 1) {
    const l = rng.int(plan.hiddenLayers.length);
    const n = plan.hiddenLayers[l]!;
    const dir = direction(grow, n, eco.hiddenRange);
    if (dir === 0) return null;
    maps[l + 1] = dir > 0 ? inserted(n, n, 1) : removed(n, rng.int(n), 1);
    plan.hiddenLayers[l] = n + dir;
  } else {
    const long = rng.next() < 0.5;
    const n = long ? plan.memoryLong : plan.memoryShort;
    const dir = direction(grow, n, eco.memoryRange);
    if (dir === 0) return null;
    // Index of the changed unit within the memory block: appended, or a random one removed.
    const unit = (long ? plan.memoryShort : 0) + (dir > 0 ? n : rng.int(n));
    maps[0] = dir > 0 ? inserted(nIn, layout.memoryAt + unit, 1) : removed(nIn, layout.memoryAt + unit, 1);
    maps[maps.length - 1] = dir > 0 ? inserted(nOut, OUTPUT_SIZE + unit, 1) : removed(nOut, OUTPUT_SIZE + unit, 1);
    if (long) plan.memoryLong += dir;
    else plan.memoryShort += dir;
  }
  return maps;
}

// Writes the genome of the network maps describes into out: kept connections keep their weights, removed ones drop out.
// A new unit gets random incoming weights at the initial scale and zero outgoing weights and bias, so the network computes as before.
// Adding or removing a ray re-spaces all ray angles, so the network computes the same but sees differently.
export function remapWeights(oldSizes: readonly number[], old: Genome, maps: UnitMaps, out: Genome, rng: Rng): void {
  let oldOffset = 0;
  let offset = 0;
  for (let l = 0; l + 1 < maps.length; l++) {
    const inMap = maps[l]!;
    const outMap = maps[l + 1]!;
    const nIn = inMap.length;
    const nOut = outMap.length;
    const oldIn = oldSizes[l]!;
    const oldBias = oldOffset + oldIn * oldSizes[l + 1]!;
    const scale = 1 / Math.sqrt(nIn);
    for (let j = 0; j < nOut; j++) {
      const oj = outMap[j]!;
      for (let i = 0; i < nIn; i++) {
        const oi = inMap[i]!;
        out[offset + j * nIn + i] = oi < 0 ? 0 : oj < 0 ? rng.normal() * scale : old[oldOffset + oj * oldIn + oi]!;
      }
    }
    offset += nIn * nOut;
    for (let j = 0; j < nOut; j++) out[offset + j] = outMap[j]! < 0 ? 0 : old[oldBias + outMap[j]!]!;
    offset += nOut;
    oldOffset = oldBias + oldSizes[l + 1]!;
  }
}
