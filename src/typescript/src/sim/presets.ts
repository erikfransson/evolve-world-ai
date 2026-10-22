import { POISON_LETHAL } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { DEFAULT_PREDATOR_CONFIG } from "./ecoConfig.ts";
import type { EcoConfig } from "./ecoConfig.ts";

// Preset worlds for Trials and Ecosystem. A preset fixes the world (and in Ecosystem the regrowth), never the creature, brain or evolution.
export const CUSTOM = "custom";

export interface PresetInfo {
  id: string;
  name: string;
  description: string; // one line
}

type World = SimConfig["world"];
type Regrowth = Pick<EcoConfig["eco"], "foodRegrow" | "foodMaxDensity" | "poisonRegrow" | "poisonMaxDensity">;
type SeasonFields = Pick<EcoConfig["eco"], "seasons" | "yearMinutes" | "winterFood">;

// Share of the world area covered by stones, ridges, slow and fast ground (terrain.ts): none, a few of each leaving most of the map open, and many.
type MapShare = Pick<World, "stoneDensity" | "ridgeDensity" | "slowDensity" | "fastDensity" | "slowSize" | "fastSize" | "map">;
const OPEN: MapShare = { stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0, slowSize: 1, fastSize: 1, map: "" };
const SOME: MapShare = { stoneDensity: 0.04, ridgeDensity: 0.03, slowDensity: 0.06, fastDensity: 0.05, slowSize: 1, fastSize: 1, map: "" };
const MANY: MapShare = { stoneDensity: 0.08, ridgeDensity: 0.06, slowDensity: 0.1, fastDensity: 0.08, slowSize: 1, fastSize: 1, map: "" };

export interface TrialsPreset extends PresetInfo {
  world: World;
}
export interface EcoPreset extends PresetInfo {
  world: Pick<World, "width" | "height" | "foodDensity" | "poisonDensity" | "itemRadius" | "foodEnergy" | "poisonDamage"> & MapShare;
  regrowth: Regrowth & Partial<SeasonFields>; // seasons are fixed only by presets that list them (Ecosystem)
}

const TRIALS_BASE: World = { width: 2300, height: 1400, foodDensity: 0.7, poisonDensity: 0.1, respawn: false, itemRadius: 4, foodEnergy: 20, poisonDamage: POISON_LETHAL, poisonClearRadius: 150, ...OPEN };

export const TRIALS_PRESETS: readonly TrialsPreset[] = [
  { id: "normal", name: "Normal", description: "A wide world with plenty of food and a little poison.", world: { ...TRIALS_BASE, foodDensity: 0.8, poisonDensity: 0.15, ...SOME } },
  { id: "poison", name: "Poison everywhere", description: "More than twice the usual poison and extra food to cross it. Every careless bite is the last.", world: { ...TRIALS_BASE, foodDensity: 1, poisonDensity: 0.35 } },
  { id: "starvation", name: "Starvation", description: "Little food, spread thin. Brutal with short sight, so give your creatures long vision.", world: { ...TRIALS_BASE, foodDensity: 0.25, foodEnergy: 50 } },
  { id: "giants", name: "Sparse giants", description: "Few, huge pieces of food and poison. Easy to see, costly to miss.", world: { ...TRIALS_BASE, foodDensity: 0.22, poisonDensity: 0.07, itemRadius: 9, foodEnergy: 60 } },
  { id: "highlands", name: "Highlands", description: "Huge stones and mountain ridges to steer around, with mud that slows and firm ground that speeds creatures up.", world: { ...TRIALS_BASE, foodDensity: 0.9, poisonDensity: 0.15, ...MANY } },
];

const ECO_BASE: EcoPreset["world"] = { width: 12000, height: 7500, foodDensity: 0.5, poisonDensity: 0.05, itemRadius: 4, foodEnergy: 20, poisonDamage: POISON_LETHAL, ...OPEN };
const ECO_REGROWTH: Regrowth & SeasonFields = { foodRegrow: 0.05, foodMaxDensity: 0.7, poisonRegrow: 0.005, poisonMaxDensity: 0.1, seasons: false, yearMinutes: 40, winterFood: 0.3 };

export const ECO_PRESETS: readonly EcoPreset[] = [
  { id: "normal", name: "Normal", description: "A vast world with mountains, mud and firm ground, where food regrows fast enough for a large population.", world: { ...ECO_BASE, ...SOME }, regrowth: ECO_REGROWTH },
  { id: "poison", name: "Poison everywhere", description: "Poison keeps regrowing and covers much of the world.", world: { ...ECO_BASE, ...SOME, poisonDensity: 0.12 }, regrowth: { ...ECO_REGROWTH, poisonRegrow: 0.008, poisonMaxDensity: 0.12 } },
  { id: "scarcity", name: "Scarcity", description: "Food regrows slowly, so only thrifty lineages survive.", world: { ...ECO_BASE, ...SOME }, regrowth: { ...ECO_REGROWTH, foodRegrow: 0.02 } },
  { id: "crowded", name: "Crowded", description: "A small world with rich regrowth. Creatures fill it and bump into each other.", world: { ...ECO_BASE, width: 2400, height: 1500 }, regrowth: { ...ECO_REGROWTH, foodRegrow: 0.25 } },
  { id: "seasons", name: "Seasons", description: "A wide, sparsely settled world where food regrowth swings over a 40 minute year. Winter thins the population and spring refills it.", world: { ...ECO_BASE, width: 16500, height: 9300, poisonDensity: 0.14, foodEnergy: 41, poisonDamage: 85 }, regrowth: { ...ECO_REGROWTH, foodRegrow: 0.005, poisonRegrow: 0.003, seasons: true } },
  { id: "highlands", name: "Highlands", description: "Mountain ranges and large stones split the world into valleys. Mud and firm ground change how fast creatures cross it.", world: { ...ECO_BASE, ...MANY }, regrowth: ECO_REGROWTH },
  { id: "inland-sea", name: "The Inland Sea", description: "A hand-designed world of 50000 by 31250 units: a shallow mud sea with islands, a poisoned north shore, dune fields, a drowned town and a cliff coast. Food and poison differ by region. A one hour year.", world: { ...ECO_BASE, ...OPEN, width: 50000, height: 31250, foodDensity: 0.1, poisonDensity: 0.005, foodEnergy: 50, map: "inland-sea" }, regrowth: { ...ECO_REGROWTH, foodRegrow: 0.003, foodMaxDensity: 1.4, poisonRegrow: 0.0003, poisonMaxDensity: 0.01, seasons: true, yearMinutes: 60 } },
];

// The two-species world of the benchmark (ecoBench --predators): one preset, the tuned defaults (docs/tuning-notes.md).
const { width, height, foodDensity, poisonDensity, itemRadius, foodEnergy, poisonDamage } = DEFAULT_PREDATOR_CONFIG.world;
const { foodRegrow, foodMaxDensity, poisonRegrow, poisonMaxDensity } = DEFAULT_PREDATOR_CONFIG.eco;
export const PREDATOR_PRESETS: readonly EcoPreset[] = [
  {
    id: "normal",
    name: "Normal",
    description: "Plants regrow steadily. Prey graze, predators hunt them, and both rise and fall in turn, around rock and over mud and firm ground.",
    world: { width, height, foodDensity, poisonDensity, itemRadius, foodEnergy, poisonDamage, ...SOME },
    regrowth: { foodRegrow, foodMaxDensity, poisonRegrow, poisonMaxDensity },
  },
];

// Form field ids a preset fixes; the forms disable them while a preset is chosen.
export const TRIALS_LOCKED: readonly string[] = ["worldWidth", "worldHeight", "foodDensity", "poisonDensity", "poisonDamage", "respawn", "itemRadius", "foodEnergy", "poisonClearRadius", "stoneDensity", "ridgeDensity", "slowDensity", "slowSize", "fastDensity", "fastSize"];
export const ECO_LOCKED: readonly string[] = ["worldWidth", "worldHeight", "foodDensity", "poisonDensity", "itemRadius", "foodEnergy", "poisonDamage", "foodRegrow", "foodMaxDensity", "poisonRegrow", "poisonMaxDensity", "seasons", "yearMinutes", "winterFood", "worldMap", "stoneDensity", "ridgeDensity", "slowDensity", "slowSize", "fastDensity", "fastSize"];

export const trialsPreset = (id: string): TrialsPreset | undefined => TRIALS_PRESETS.find((p) => p.id === id);
export const ecoPreset = (id: string, presets: readonly EcoPreset[] = ECO_PRESETS): EcoPreset | undefined => presets.find((p) => p.id === id);

// A copy of the config with the preset's world; unchanged for Custom or an unknown id.
export function withTrialsPreset(c: SimConfig, id: string): SimConfig {
  const p = trialsPreset(id);
  const out = structuredClone(c);
  if (p) out.world = { ...p.world };
  return out;
}

export function withEcoPreset(c: EcoConfig, id: string, presets: readonly EcoPreset[] = ECO_PRESETS): EcoConfig {
  const p = ecoPreset(id, presets);
  const out = structuredClone(c);
  if (p) {
    out.world = { ...out.world, ...p.world };
    out.eco = { ...out.eco, ...p.regrowth };
  }
  return out;
}

