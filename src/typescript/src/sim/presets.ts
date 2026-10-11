import { POISON_LETHAL } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { DEFAULT_PREDATOR_CONFIG } from "./ecoConfig.ts";
import type { EcoConfig } from "./ecoConfig.ts";

// Preset worlds for Trials, Ecosystem and Predators & prey. A preset fixes the world (and in Ecosystem the regrowth), never the creature, brain or evolution.
export const CUSTOM = "custom";

export interface PresetInfo {
  id: string;
  name: string;
  description: string; // one line
}

type World = SimConfig["world"];
type Regrowth = Pick<EcoConfig["eco"], "foodRegrow" | "foodMaxDensity" | "poisonRegrow" | "poisonMaxDensity">;

export interface TrialsPreset extends PresetInfo {
  world: World;
}
export interface EcoPreset extends PresetInfo {
  world: Pick<World, "width" | "height" | "foodDensity" | "poisonDensity" | "itemRadius" | "foodEnergy" | "poisonDamage">;
  regrowth: Regrowth;
}

const TRIALS_BASE: World = { width: 2300, height: 1400, foodDensity: 0.7, poisonDensity: 0.1, respawn: false, itemRadius: 4, foodEnergy: 20, poisonDamage: POISON_LETHAL, poisonClearRadius: 150 };

export const TRIALS_PRESETS: readonly TrialsPreset[] = [
  { id: "normal", name: "Normal", description: "A wide world with plenty of food and a little poison.", world: TRIALS_BASE },
  { id: "poison", name: "Poison everywhere", description: "Three times the usual poison. Every careless bite is the last.", world: { ...TRIALS_BASE, poisonDensity: 0.3 } },
  { id: "starvation", name: "Starvation", description: "Little food, spread thin. Brutal with short sight, so give your creatures long vision.", world: { ...TRIALS_BASE, foodDensity: 0.25, foodEnergy: 35 } },
  { id: "giants", name: "Sparse giants", description: "Few, huge pieces of food and poison. Easy to see, costly to miss.", world: { ...TRIALS_BASE, foodDensity: 0.22, poisonDensity: 0.07, itemRadius: 9, foodEnergy: 60 } },
];

// foodEnergy 40 is the base the other presets keep on purpose; Normal alone overrides it to 20.
const ECO_BASE: EcoPreset["world"] = { width: 12000, height: 7500, foodDensity: 0.5, poisonDensity: 0.05, itemRadius: 4, foodEnergy: 40, poisonDamage: POISON_LETHAL };
const ECO_REGROWTH: Regrowth = { foodRegrow: 0.05, foodMaxDensity: 0.7, poisonRegrow: 0.005, poisonMaxDensity: 0.1 };

export const ECO_PRESETS: readonly EcoPreset[] = [
  { id: "normal", name: "Normal", description: "A vast world where food regrows fast enough for a large population.", world: { ...ECO_BASE, foodEnergy: 20 }, regrowth: ECO_REGROWTH },
  { id: "poison", name: "Poison everywhere", description: "Poison keeps regrowing and covers much of the world.", world: { ...ECO_BASE, poisonDensity: 0.3 }, regrowth: { ...ECO_REGROWTH, poisonRegrow: 0.02, poisonMaxDensity: 0.35 } },
  { id: "scarcity", name: "Scarcity", description: "Food regrows slowly, so only thrifty lineages survive.", world: { ...ECO_BASE, foodDensity: 0.4 }, regrowth: { ...ECO_REGROWTH, foodRegrow: 0.025, foodMaxDensity: 0.5 } },
  { id: "crowded", name: "Crowded", description: "A small world with rich regrowth. Creatures fill it and bump into each other.", world: { ...ECO_BASE, width: 2400, height: 1500 }, regrowth: { ...ECO_REGROWTH, foodRegrow: 0.15 } },
];

// Predators & prey: one preset, the tuned defaults (docs/tuning-notes.md).
const { width, height, foodDensity, poisonDensity, itemRadius, foodEnergy, poisonDamage } = DEFAULT_PREDATOR_CONFIG.world;
const { foodRegrow, foodMaxDensity, poisonRegrow, poisonMaxDensity } = DEFAULT_PREDATOR_CONFIG.eco;
export const PREDATOR_PRESETS: readonly EcoPreset[] = [
  {
    id: "normal",
    name: "Normal",
    description: "Plants regrow steadily. Prey graze, predators hunt them, and both rise and fall in turn.",
    world: { width, height, foodDensity, poisonDensity, itemRadius, foodEnergy, poisonDamage },
    regrowth: { foodRegrow, foodMaxDensity, poisonRegrow, poisonMaxDensity },
  },
];

// Form field ids a preset fixes; the forms disable them while a preset is chosen.
export const TRIALS_LOCKED: readonly string[] = ["worldWidth", "worldHeight", "foodDensity", "poisonDensity", "poisonDamage", "respawn"];
export const ECO_LOCKED: readonly string[] = ["worldWidth", "worldHeight", "foodDensity", "poisonDensity", "itemRadius", "foodEnergy", "poisonDamage", "foodRegrow", "foodMaxDensity", "poisonRegrow", "poisonMaxDensity"];

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

export const withPredatorPreset = (c: EcoConfig, id: string): EcoConfig => withEcoPreset(c, id, PREDATOR_PRESETS);
