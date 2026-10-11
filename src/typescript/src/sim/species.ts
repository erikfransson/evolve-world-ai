import type { EngineConfig } from "./config.ts";
import type { EcoConfig } from "./ecoConfig.ts";

// Species of a Great Hunt world (#12). Children keep their parent's species. A species is its identity and diet
// plus overrides of the shared settings: whatever it leaves out it takes from eco and creature, so the Ecosystem is
// the case of one species that overrides nothing.
export interface SpeciesConfig {
  name: string;
  hue: number; // centre of the species' colour band, degrees, or -1 for any colour; founders and children stay in the band
  hueSpread: number; // width of the colour band, degrees
  plants: boolean; // eats food items (and dies of poison); a species that does not passes over items
  prey: number[]; // indices of the species it eats on contact
  eatEfficiency: number; // share of a caught prey's energy the hunter gains
  eatBaseline: number; // energy gained per prey on top of that
  speed?: number; // multiplier on creature.maxThrust, so on the top speed; 1 when left out
  founders?: number; // eco.initialPopulation
  poolFraction?: number; // eco.poolFraction
  startEnergy?: number; // creature.startEnergy
  livingCost?: number; // creature.livingCost
  thrustCost?: number; // creature.thrustCost
  turnCost?: number; // creature.turnCost
  birthEnergyRange?: number[]; // eco.birthEnergyRange
  birthCostRange?: number[]; // eco.birthCostRange
  birthCooldownRange?: number[]; // eco.birthCooldownRange
  rayCountRange?: number[]; // eco.rayCountRange
  raySpreadRange?: number[]; // eco.raySpreadRange, radians
  rayLengthRange?: number[]; // eco.rayLengthRange
}

// A species with every override filled in from the shared settings.
export type Species = Required<SpeciesConfig>;

// Keys a species may override, each with the shared setting it falls back to.
export const SPECIES_OVERRIDES = {
  founders: ["eco", "initialPopulation"],
  poolFraction: ["eco", "poolFraction"],
  startEnergy: ["creature", "startEnergy"],
  livingCost: ["creature", "livingCost"],
  thrustCost: ["creature", "thrustCost"],
  turnCost: ["creature", "turnCost"],
  birthEnergyRange: ["eco", "birthEnergyRange"],
  birthCostRange: ["eco", "birthCostRange"],
  birthCooldownRange: ["eco", "birthCooldownRange"],
  rayCountRange: ["eco", "rayCountRange"],
  raySpreadRange: ["eco", "raySpreadRange"],
  rayLengthRange: ["eco", "rayLengthRange"],
} as const;

// The species of a world without a species list.
export const ONE_SPECIES: SpeciesConfig = { name: "creature", hue: -1, hueSpread: 360, plants: true, prey: [], eatEfficiency: 0, eatBaseline: 0 };

// sp with its left-out settings taken from config.
export function resolveSpecies(config: EcoConfig, sp: SpeciesConfig): Species {
  const out = { speed: 1, ...sp } as Record<string, unknown>;
  for (const [key, [part, field]] of Object.entries(SPECIES_OVERRIDES)) out[key] ??= (config[part] as Record<string, unknown>)[field];
  return out as Species;
}

// The species of a world, resolved: its list, or the one species.
export const speciesList = (config: EcoConfig): Species[] => (config.species?.length ? config.species : [ONE_SPECIES]).map((sp) => resolveSpecies(config, sp));

// All species read a seen creature's energy on one scale, the largest start energy, which for one species is its own.
export const seenEnergyScale = (species: readonly Species[]): number => Math.max(...species.map((x) => x.startEnergy));

// Where the body of a species is drawn full: the middle of its birth threshold range on a log scale.
export const fullEnergy = (sp: Pick<Species, "birthEnergyRange">): number => Math.sqrt(sp.birthEnergyRange[0]! * sp.birthEnergyRange[1]!);

// The engine config a creature of species sp runs on: its body, costs and speed. scale is seenEnergyScale of the world's species.
export function speciesEngine(config: EcoConfig, sp: Species, scale = seenEnergyScale(speciesList(config))): EngineConfig {
  const c = config.creature;
  return {
    ...config,
    seenEnergyScale: scale,
    creature: { ...c, maxThrust: c.maxThrust * sp.speed, startEnergy: sp.startEnergy, livingCost: sp.livingCost, thrustCost: sp.thrustCost, turnCost: sp.turnCost },
  };
}

// Ranges for randomPlan, driftPlan, mutateStructure and the birth traits: the species' ray and birth ranges with the shared brain ranges.
export function speciesRanges(config: EcoConfig, sp: Species): EcoConfig["eco"] {
  const { rayCountRange, raySpreadRange, rayLengthRange, birthEnergyRange, birthCostRange, birthCooldownRange } = sp;
  return { ...config.eco, rayCountRange, raySpreadRange, rayLengthRange, birthEnergyRange, birthCostRange, birthCooldownRange };
}

// Founders per species: each its own count, all scaled down together when they would exceed the population limit.
export function founderCounts(species: readonly Species[], maxPopulation: number): number[] {
  const wanted = species.map((sp) => Math.max(0, sp.founders));
  const total = wanted.reduce((a, b) => a + b, 0);
  const cap = Math.max(0, maxPopulation);
  if (total <= cap) return wanted;
  // Largest remainder, ties to the earlier species, so the counts add up to the cap.
  const exact = wanted.map((w) => (w * cap) / total);
  const counts = exact.map(Math.floor);
  const order = exact.map((e, s) => s).sort((a, b) => exact[b]! - counts[b]! - (exact[a]! - counts[a]!) || a - b);
  for (let k = 0, left = cap - counts.reduce((a, b) => a + b, 0); k < left; k++) counts[order[k]!]!++;
  return counts;
}

const IDENTITY_TYPES: Record<string, "string" | "number" | "boolean" | "array"> = { name: "string", hue: "number", hueSpread: "number", plants: "boolean", prey: "array", eatEfficiency: "number", eatBaseline: "number", speed: "number" };
const RANGE_KEYS = new Set(["rayCountRange", "raySpreadRange", "rayLengthRange", "birthEnergyRange", "birthCostRange", "birthCooldownRange"]);

// Settings saved before birth traits were heritable held single birthEnergy, birthCost and birthCooldown values and a childEnergy.
// Returns a copy of obj (a pasted eco block or species item) with those turned into [v, v] ranges, childEnergy dropped, and a note per change.
export function migrateBirthKeys(obj: Record<string, unknown>, where: string, notes: string[]): Record<string, unknown> {
  const out = { ...obj };
  for (const key of ["birthEnergy", "birthCost", "birthCooldown"]) {
    if (!(key in out)) continue;
    const v = out[key];
    delete out[key];
    if (typeof v !== "number") continue; // left to the range keys' own checks
    out[`${key}Range`] ??= [v, v];
    notes.push(`${where}.${key} ${v} → ${key}Range [${v}, ${v}]`);
  }
  if ("childEnergy" in out) {
    delete out.childEnergy;
    notes.push(`${where}.childEnergy dropped (a child now starts with the birth cost)`);
  }
  return out;
}

// Throws when a [min, max] setting of obj (an eco block or species item) has min above max.
export function checkRanges(obj: Record<string, unknown>, where: string): void {
  for (const [key, v] of Object.entries(obj)) {
    if (key.endsWith("Range") && Array.isArray(v) && v.length === 2 && (v[0] as number) > (v[1] as number)) throw new Error(`config "${where}.${key}" must have min at most max, got [${v.join(", ")}].`);
  }
}

// A pasted species list merged item by item over the defaults. Throws a readable Error when the list does not have
// the defaults' length, an item has an unknown key or a wrong type, or a prey index names no other species.
export function mergeSpeciesList(value: unknown, defaults: readonly SpeciesConfig[], notes: string[] = []): SpeciesConfig[] {
  const n = defaults.length;
  if (!Array.isArray(value)) throw new Error(`config "species" must be a list of ${n} species.`);
  if (value.length !== n) throw new Error(`config "species" must list exactly ${n} species (${defaults.map((d) => d.name).join(", ")}), got ${value.length}.`);
  return value.map((item, i) => {
    const where = `species[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`config "${where}" must be an object.`);
    item = migrateBirthKeys(item as Record<string, unknown>, where, notes);
    const out = structuredClone(defaults[i]!) as unknown as Record<string, unknown>;
    for (const [key, v] of Object.entries(item as Record<string, unknown>)) {
      const type = IDENTITY_TYPES[key] ?? (RANGE_KEYS.has(key) ? "array" : key in SPECIES_OVERRIDES ? "number" : undefined);
      if (!type) throw new Error(`unknown config key "${where}.${key}"`);
      const ok = type === "array" ? Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)) : type === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === type;
      if (!ok) throw new Error(`config "${where}.${key}" must be ${type === "array" ? "a list of numbers" : `a ${type}`}.`);
      if (RANGE_KEYS.has(key) && (v as number[]).length !== 2) throw new Error(`config "${where}.${key}" must be [min, max].`);
      if (key === "prey" && !(v as number[]).every((p) => Number.isInteger(p) && p >= 0 && p < n && p !== i)) throw new Error(`config "${where}.prey" must list other species by index, 0 to ${n - 1}.`);
      out[key] = Array.isArray(v) ? v.slice() : v;
    }
    checkRanges(out, where);
    return out as unknown as SpeciesConfig;
  });
}

// A hue kept within the species' band (reflected at its edges); any hue for a species without a band.
export function bandHue(sp: SpeciesConfig, hue: number): number {
  if (sp.hue < 0 || sp.hueSpread >= 360) return (((hue % 360) + 360) % 360);
  const half = sp.hueSpread / 2;
  let d = hue - sp.hue;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  if (d > half) d = 2 * half - d;
  if (d < -half) d = -2 * half - d;
  d = Math.min(half, Math.max(-half, d));
  return (((sp.hue + d) % 360) + 360) % 360;
}
