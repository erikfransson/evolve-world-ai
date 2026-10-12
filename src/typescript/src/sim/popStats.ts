import type { BirthTraits } from "./planMutation.ts";
import type { PlanView } from "./sensors.ts";

// Traits of a population's body plans, shown as small histograms. Values are in display units (angle in degrees).
export interface Trait {
  key: string;
  label: string;
  unit: string;
  integer: boolean; // counts: one bar per value when few
  of(plan: PlanView, birth: BirthTraits): number;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export const TRAITS: readonly Trait[] = [
  { key: "rays", label: "Vision rays", unit: "", integer: true, of: (p) => p.rayCount },
  { key: "range", label: "Ray length", unit: "", integer: false, of: (p) => p.rayLength },
  { key: "angle", label: "Vision angle", unit: "°", integer: false, of: (p) => (p.raySpread * 180) / Math.PI },
  { key: "hidden", label: "Hidden neurons", unit: "", integer: true, of: (p) => sum(p.hiddenLayers) },
  { key: "layers", label: "Hidden layers", unit: "", integer: true, of: (p) => p.hiddenLayers.length },
  { key: "memory", label: "Memory units", unit: "", integer: true, of: (p) => p.memoryShort + p.memoryLong },
  { key: "birthEnergy", label: "Birth energy", unit: "", integer: false, of: (_, b) => b.energy },
  { key: "birthCost", label: "Birth cost", unit: "", integer: false, of: (_, b) => b.cost },
  { key: "cooldown", label: "Birth cooldown", unit: " s", integer: false, of: (_, b) => b.cooldown },
];

export const TRAIT_BINS = 8;

export interface TraitHistogram {
  min: number;
  max: number;
  mean: number;
  bins: number[]; // counts, from min to max
}

// Values of each trait, one run of plans.length per trait, reused across calls (a page calls this about once a second).
let values = new Float64Array(0);

// One histogram per entry of TRAITS; null for an empty population. Integer traits with a narrow span get one bin per value.
export function traitStats(plans: readonly PlanView[], births: readonly BirthTraits[]): TraitHistogram[] | null {
  const count = plans.length;
  if (count === 0) return null;
  if (values.length < count * TRAITS.length) values = new Float64Array(count * TRAITS.length);
  return TRAITS.map((t, k) => {
    const at0 = k * count;
    let min = Infinity;
    let max = -Infinity;
    let total = 0;
    for (let i = 0; i < count; i++) {
      const v = t.of(plans[i]!, births[i]!);
      values[at0 + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
      total += v;
    }
    const n = t.integer ? Math.min(TRAIT_BINS, max - min + 1) : max > min ? TRAIT_BINS : 1;
    const bins = new Array<number>(n).fill(0);
    const span = max - min;
    for (let i = 0; i < count; i++) {
      const v = values[at0 + i]!;
      const at = t.integer && max - min + 1 <= TRAIT_BINS ? v - min : span > 0 ? Math.min(n - 1, Math.floor(((v - min) / span) * n)) : 0;
      bins[at]!++;
    }
    return { min, max, mean: total / count, bins };
  });
}
