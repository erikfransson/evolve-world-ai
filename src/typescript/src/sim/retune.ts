import type { EcoConfig } from "./ecoConfig.ts";

// Settings Ecosystem.retune may change in a running world, by section and kind of value. Anything else (body, costs, ray and
// brain ranges, world size and start densities, wasm, species) is baked into creatures or buffers at construction, so it is rejected.
// range: [min, max] with min at most max (posrange: min above 0), needs a world without a species list (the species hold their own birth ranges).
export const LIVE_FIELDS = {
  eco: {
    foodRegrow: "nonneg", foodMaxDensity: "nonneg", poisonRegrow: "nonneg", poisonMaxDensity: "nonneg", // density units, the caps need free item slots
    seasons: "bool", yearMinutes: "positive", winterFood: "unit",
    birthEnergyRange: "posrange", birthCostRange: "posrange", birthCooldownRange: "range", // new founders and drift use the new range
    birthDrift: "nonneg", birthSpeed: "nonneg", hueDrift: "nonneg", planDrift: "nonneg", structuralRate: "unit",
    aging: "bool", agingStart: "nonneg", agingRate: "nonneg",
    collisions: "bool", collisionDamage: "bool", damagePerSpeed: "nonneg", maxPopulation: "count", birthReserve: "count",
  },
  world: { foodEnergy: "nonneg", poisonDamage: "nonneg" },
  mutation: { rate: "unit", std: "nonneg" },
} as const;

// Upper bounds of "section.field" values, the form maxima (regrowth and caps in density units); a value past one could hang or flood the world.
export const LIVE_MAX: Record<string, number> = {
  "eco.foodRegrow": 1, "eco.poisonRegrow": 1, "eco.foodMaxDensity": 10, "eco.poisonMaxDensity": 10, "eco.yearMinutes": 600,
  "eco.birthDrift": 0.5, "eco.birthSpeed": 200, "eco.hueDrift": 45, "eco.planDrift": 0.1, "eco.structuralRate": 0.2,
  "eco.agingStart": 3600, "eco.agingRate": 2, "eco.damagePerSpeed": 1, "eco.maxPopulation": 10000, "eco.birthReserve": 1000,
  "eco.birthEnergyRange": 10000, "eco.birthCostRange": 10000, "eco.birthCooldownRange": 600,
  "world.foodEnergy": 10000, "world.poisonDamage": 10000, "mutation.std": 1,
};

type Kind = "nonneg" | "positive" | "unit" | "bool" | "count" | "range" | "posrange";
type Live = typeof LIVE_FIELDS;
export type RetunePatch = {
  [S in keyof Live]?: { [K in keyof Live[S]]?: Live[S][K] extends "bool" ? boolean : Live[S][K] extends "range" | "posrange" ? number[] : number };
};
export type RetuneResult = { ok: true; changed: string[] } | { ok: false; reason: string };

function bad(kind: Kind, v: unknown, max = Infinity): boolean {
  if (kind === "bool") return typeof v !== "boolean";
  if (kind === "range" || kind === "posrange") return !Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max) || v[0] > v[1] || (kind === "posrange" && v[0] <= 0);
  if (typeof v !== "number" || !Number.isFinite(v) || v > max) return true;
  if (kind === "positive") return v <= 0;
  if (kind === "unit") return v < 0 || v > 1;
  if (kind === "count") return v < 0 || !Number.isInteger(v);
  return v < 0;
}

// The [section, field, value] triples of patch, or the reason it must be refused. Checks the shape and range of each value only.
export function checkRetune(patch: unknown, config: EcoConfig): { fields: [string, string, unknown][] } | { reason: string } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return { reason: "retune needs an object like { eco: { foodRegrow: 0.04 } }" };
  const fields: [string, string, unknown][] = [];
  for (const [section, values] of Object.entries(patch)) {
    const table = (LIVE_FIELDS as Record<string, Record<string, Kind>>)[section];
    if (!table) return { reason: `"${section}" cannot be changed live, only ${Object.keys(LIVE_FIELDS).join(", ")}` };
    if (typeof values !== "object" || values === null || Array.isArray(values)) return { reason: `"${section}" must be an object` };
    for (const [key, v] of Object.entries(values)) {
      const kind = table[key];
      if (!kind) return { reason: `${section}.${key} cannot be changed live` };
      if (bad(kind, v, LIVE_MAX[`${section}.${key}`])) return { reason: `${section}.${key} has an invalid value ${JSON.stringify(v)} (${kind}${LIVE_MAX[`${section}.${key}`] === undefined ? "" : `, at most ${LIVE_MAX[`${section}.${key}`]}`})` };
      if ((kind === "range" || kind === "posrange") && config.species?.length) return { reason: `${section}.${key} is set per species in this world` };
      fields.push([section, key, v]);
    }
  }
  return { fields };
}
