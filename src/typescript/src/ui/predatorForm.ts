import { DEFAULT_PREDATOR_CONFIG } from "../sim/ecoConfig.ts";
import type { EcoConfig } from "../sim/ecoConfig.ts";
import { resolveSpecies } from "../sim/species.ts";
import type { Species, SpeciesConfig } from "../sim/species.ts";
import { SPECIES_COLORS } from "./speciesStyle.ts";
import { ECO_SECTIONS } from "./ecoSettingsForm.ts";
import { items, perSecond, range, rangePair } from "./settingsForm.ts";
import type { Field, FormSpec, Section } from "./settingsForm.ts";

// The Great Hunt settings: world and regrowth, one card per species, predation, then the shared Ecosystem cards folded.


const sp = (c: EcoConfig, i: number): SpeciesConfig => c.species![i]!;
const value = <K extends keyof Species>(c: EcoConfig, i: number, key: K): Species[K] => resolveSpecies(c, sp(c, i))[key];
const assign = <K extends keyof Species>(c: EcoConfig, i: number, key: K, v: Species[K]): void => { sp(c, i)[key] = v; };
const shared = (title: string): readonly Field<EcoConfig>[] => ECO_SECTIONS.find((s) => s.title === title)!.fields;
const pick = (title: string, ids: readonly string[]): Field<EcoConfig>[] => shared(title).filter((f) => ids.includes(f.id));
const advanced = (fields: readonly Field<EcoConfig>[]): Field<EcoConfig>[] => fields.map((f) => ({ ...f, advanced: true }));

// One species' card: founders, speed and births up front, costs and vision under More settings.
function speciesFields(i: number, p: string, who: string, maxFounders: number): Field<EcoConfig>[] {
  return [
    range({ id: `${p}Founders`, label: "Start creatures", tip: `How many ${who} the run starts with.`, min: 0, max: maxFounders, step: 1, get: (c) => value(c, i, "founders"), set: (c, v) => { assign(c, i, "founders", v); } }),
    range({ id: `${p}Pool`, label: "Trained founders", tip: `Share of the starting ${who} copied, with small mutations, from a pool of creatures trained in Trials to find food. They keep their own rays and brain shape and start blind to other creatures. The rest start with random brains.`, min: 0, max: 1, step: 0.01, fmt: "pct", get: (c) => value(c, i, "poolFraction"), set: (c, v) => { assign(c, i, "poolFraction", v); } }),
    range({ id: `${p}Speed`, label: "Top speed", tip: `How fast ${who} can swim, compared with an Ecosystem creature. Faster costs nothing extra per second of thrust, so speed is a pure advantage.`, min: 0.5, max: 2, step: 0.01, fmt: "mult", get: (c) => value(c, i, "speed"), set: (c, v) => { assign(c, i, "speed", v); } }),
    ...rangePair<EcoConfig>({ id: `${p}BirthEnergy`, label: "Birth energy", tip: `One of the ${who} with at least this much energy has a child. Each has its own value between min and max, passed on with small changes. Its body is drawn full at the middle of the range.`, min: 20, max: 10000, step: 1, get: (c) => value(c, i, "birthEnergyRange"), set: (c, v) => { assign(c, i, "birthEnergyRange", v); } }),
    ...rangePair<EcoConfig>({ id: `${p}BirthCost`, label: "Birth cost", tip: "Energy the parent pays for a child, which is exactly the energy the child starts with. A parent that pays all it has dies. Each has its own value between min and max.", min: 10, max: 10000, step: 1, advanced: true, get: (c) => value(c, i, "birthCostRange"), set: (c, v) => { assign(c, i, "birthCostRange", v); } }),
    ...rangePair<EcoConfig>({ id: `${p}Cooldown`, label: "Birth cooldown", tip: "Seconds a parent must wait before it can have another child.", min: 0, max: 60, step: 0.1, fmt: "sec", advanced: true, get: (c) => value(c, i, "birthCooldownRange"), set: (c, v) => { assign(c, i, "birthCooldownRange", v); } }),
    range({ id: `${p}StartEnergy`, label: "Founder energy", tip: `Energy each starting creature has. It also sets the scale of how full a creature feels to its own brain.`, min: 10, max: 300, step: 1, advanced: true, get: (c) => value(c, i, "startEnergy"), set: (c, v) => { assign(c, i, "startEnergy", v); } }),
    range({ id: `${p}LivingCost`, label: "Living cost", tip: "Energy per second just for being alive.", min: 0, max: 6, step: 0.01, fmt: "dens", advanced: true, get: (c) => value(c, i, "livingCost"), set: (c, v) => { assign(c, i, "livingCost", v); } }),
    range({ id: `${p}ThrustCost`, label: "Thrust cost", tip: "Energy per second at full thrust.", min: 0, max: 12, step: 0.1, fmt: "dens", advanced: true, get: (c) => value(c, i, "thrustCost"), set: (c, v) => { assign(c, i, "thrustCost", v); } }),
    ...rangePair<EcoConfig>({ id: `${p}Ray`, label: "Vision", tip: "Founders and mutations keep each creature's vision range between these. Longer sight costs more upkeep.", min: 20, max: 400, step: 1, fmt: "size", advanced: true, get: (c) => value(c, i, "rayLengthRange"), set: (c, v) => { assign(c, i, "rayLengthRange", v); } }),
  ];
}

export const PREDATOR_SECTIONS: readonly Section<EcoConfig>[] = [
  {
    title: "World and regrowth",
    fields: [
      ...pick("World", ["seed", "worldWidth", "worldHeight"]),
      range({ id: "foodDensity", label: "Start plants", tip: "How many plants grow at the start. 1 means roughly one plant in every 100 × 100 area.", min: 0, max: 1, step: 0.005, fmt: "dens3", hint: (c) => items(c, c.world.foodDensity), get: (c) => c.world.foodDensity, set: (c, v) => { c.world.foodDensity = v; } }),
      range({ id: "foodRegrow", label: "Plant regrowth", tip: "How fast new plants appear, in the same density units as the start plants, per second. Together with the energy per plant this sets how many prey the world can feed.", min: 0, max: 0.2, step: 0.001, fmt: "dens3", hint: (c) => perSecond(c, c.eco.foodRegrow), get: (c) => c.eco.foodRegrow, set: (c, v) => { c.eco.foodRegrow = v; } }),
      range({ id: "foodMaxDensity", label: "Plant limit", tip: "Plants stop regrowing when the world holds this much, on the density scale.", min: 0, max: 1, step: 0.005, fmt: "dens3", hint: (c) => items(c, c.eco.foodMaxDensity), get: (c) => c.eco.foodMaxDensity, set: (c, v) => { c.eco.foodMaxDensity = v; } }),
      range({ id: "foodEnergy", label: "Energy per plant", tip: "Energy a prey gains from one plant. Poison takes the same amount away.", min: 5, max: 100, step: 1, get: (c) => c.world.foodEnergy, set: (c, v) => { c.world.foodEnergy = v; } }),
      ...pick("Regrowth", ["seasons"]),
      ...advanced(pick("Regrowth", ["yearMinutes", "winterFood"])),
      ...advanced(pick("World", ["poisonDensity", "poisonDamage", "itemRadius"])),
      ...advanced(pick("Regrowth", ["poisonRegrow", "poisonMaxDensity"])),
      ...advanced(pick("Life cycle", ["maxPopulation"])),
    ],
  },
  { title: "Prey", swatch: SPECIES_COLORS[0], fields: speciesFields(0, "prey", "prey", 3000) },
  { title: "Predators", swatch: SPECIES_COLORS[1], fields: speciesFields(1, "pred", "predators", 500) },
  {
    title: "Predation",
    fields: [
      range({ id: "eatEfficiency", label: "Meat efficiency", tip: "Share of a caught prey's stored energy the predator gains. Prey that have grazed well are worth more.", min: 0, max: 1, step: 0.01, fmt: "pct", get: (c) => sp(c, 1).eatEfficiency, set: (c, v) => { sp(c, 1).eatEfficiency = v; } }),
      range({ id: "eatBaseline", label: "Energy per catch", tip: "Energy a predator gains from every catch on top of the prey's stored energy, so even a starving prey is a meal.", min: 0, max: 200, step: 1, get: (c) => sp(c, 1).eatBaseline, set: (c, v) => { sp(c, 1).eatBaseline = v; } }),
    ],
  },
  { title: "Life cycle", folded: true, fields: shared("Life cycle").filter((f) => !["initialPopulation", "poolFraction", "maxPopulation", "birthEnergyMin", "birthEnergyMax", "birthCostMin", "birthCostMax", "birthCooldownMin", "birthCooldownMax"].includes(f.id)) },
  ...ECO_SECTIONS.filter((s) => ["Variation", "Brain", "Mutation"].includes(s.title)).map((s) => ({ ...s, folded: true })),
];

export const PREDATOR_FORM: FormSpec<EcoConfig> = { sections: PREDATOR_SECTIONS, defaults: DEFAULT_PREDATOR_CONFIG };

// Form fields a preset fixes on this page.
export const PREDATOR_LOCKED: readonly string[] = ["worldWidth", "worldHeight", "foodDensity", "poisonDensity", "itemRadius", "foodEnergy", "poisonDamage", "foodRegrow", "foodMaxDensity", "poisonRegrow", "poisonMaxDensity"];
