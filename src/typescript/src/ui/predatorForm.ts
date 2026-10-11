import { DEFAULT_PREDATOR_CONFIG } from "../sim/ecoConfig.ts";
import type { EcoConfig } from "../sim/ecoConfig.ts";
import type { SpeciesConfig } from "../sim/species.ts";
import { ECO_SECTIONS, items, perSecond, range } from "./ecoSettingsForm.ts";
import type { EcoForm, Field, Section } from "./ecoSettingsForm.ts";

// Predators & prey settings: world and regrowth, one card per species, predation, then the shared Ecosystem cards folded.

export const PREY_COLOR = "#60a5fa";
export const PREDATOR_COLOR = "#f87171";

const sp = (c: EcoConfig, i: number): SpeciesConfig => c.species![i]!;
const shared = (title: string): readonly Field[] => ECO_SECTIONS.find((s) => s.title === title)!.fields;
const pick = (title: string, ids: readonly string[]): Field[] => shared(title).filter((f) => ids.includes(f.id));
const advanced = (fields: readonly Field[]): Field[] => fields.map((f) => ({ ...f, advanced: true }));

// One species' card: founders, speed and births up front, costs and vision under More settings.
function speciesFields(i: number, p: string, who: string, maxFounders: number): Field[] {
  return [
    range({ id: `${p}Founders`, label: "Start creatures", tip: `How many ${who} the run starts with.`, min: 0, max: maxFounders, step: maxFounders > 500 ? 10 : 1, get: (c) => sp(c, i).founders, set: (c, v) => { sp(c, i).founders = v; } }),
    range({ id: `${p}Pool`, label: "Trained founders", tip: `Share of the starting ${who} copied, with small mutations, from a pool of creatures trained in Trials to find food. They keep their own rays and brain shape and start blind to other creatures. The rest start with random brains.`, min: 0, max: 1, step: 0.05, fmt: "pct", get: (c) => sp(c, i).poolFraction, set: (c, v) => { sp(c, i).poolFraction = v; } }),
    range({ id: `${p}Speed`, label: "Top speed", tip: `How fast ${who} can swim, compared with an Ecosystem creature. Faster costs nothing extra per second of thrust, so speed is a pure advantage.`, min: 0.5, max: 2, step: 0.05, fmt: "mult", get: (c) => sp(c, i).speed, set: (c, v) => { sp(c, i).speed = v; } }),
    range({ id: `${p}BirthEnergy`, label: "Birth energy", tip: `One of the ${who} with at least this much energy can have a child. Its body is drawn full at this level.`, min: 40, max: 600, step: 5, get: (c) => sp(c, i).birthEnergy, set: (c, v) => { sp(c, i).birthEnergy = v; } }),
    range({ id: `${p}ChildEnergy`, label: "Child energy", tip: "Energy a newborn starts with. Less than the birth cost means each birth burns energy.", min: 10, max: 300, step: 5, get: (c) => sp(c, i).childEnergy, set: (c, v) => { sp(c, i).childEnergy = v; } }),
    range({ id: `${p}BirthCost`, label: "Birth cost", tip: "Energy the parent pays for a child.", min: 10, max: 400, step: 5, advanced: true, get: (c) => sp(c, i).birthCost, set: (c, v) => { sp(c, i).birthCost = v; } }),
    range({ id: `${p}Cooldown`, label: "Birth cooldown", tip: "Seconds a parent must wait before it can have another child.", min: 0, max: 60, step: 1, fmt: "sec", advanced: true, get: (c) => sp(c, i).birthCooldown, set: (c, v) => { sp(c, i).birthCooldown = v; } }),
    range({ id: `${p}StartEnergy`, label: "Founder energy", tip: `Energy each starting creature has. It also sets the scale of how full a creature feels to its own brain.`, min: 10, max: 300, step: 5, advanced: true, get: (c) => sp(c, i).startEnergy, set: (c, v) => { sp(c, i).startEnergy = v; } }),
    range({ id: `${p}LivingCost`, label: "Living cost", tip: "Energy per second just for being alive.", min: 0, max: 6, step: 0.1, fmt: "dens", advanced: true, get: (c) => sp(c, i).livingCost, set: (c, v) => { sp(c, i).livingCost = v; } }),
    range({ id: `${p}ThrustCost`, label: "Thrust cost", tip: "Energy per second at full thrust.", min: 0, max: 12, step: 0.5, fmt: "dens", advanced: true, get: (c) => sp(c, i).thrustCost, set: (c, v) => { sp(c, i).thrustCost = v; } }),
    range({ id: `${p}RayMin`, label: "Shortest vision", tip: "Founders and mutations keep each creature's vision range at or above this.", min: 20, max: 400, step: 5, fmt: "size", advanced: true, get: (c) => sp(c, i).rayLengthRange[0]!, set: (c, v) => { sp(c, i).rayLengthRange = [v, Math.max(v, sp(c, i).rayLengthRange[1]!)]; } }),
    range({ id: `${p}RayMax`, label: "Longest vision", tip: "Founders and mutations keep each creature's vision range at or below this. Longer sight costs more upkeep.", min: 20, max: 400, step: 5, fmt: "size", advanced: true, get: (c) => sp(c, i).rayLengthRange[1]!, set: (c, v) => { sp(c, i).rayLengthRange = [Math.min(v, sp(c, i).rayLengthRange[0]!), v]; } }),
  ];
}

export const PREDATOR_SECTIONS: readonly Section[] = [
  {
    title: "World and regrowth",
    fields: [
      ...pick("World", ["seed", "worldWidth", "worldHeight"]),
      range({ id: "foodDensity", label: "Start plants", tip: "How many plants grow at the start. 1 means roughly one plant in every 100 × 100 area.", min: 0, max: 1, step: 0.01, fmt: "dens", hint: (c) => items(c, c.world.foodDensity), get: (c) => c.world.foodDensity, set: (c, v) => { c.world.foodDensity = v; } }),
      range({ id: "foodRegrow", label: "Plant regrowth", tip: "How fast new plants appear, in the same density units as the start plants, per second. Together with the energy per plant this sets how many prey the world can feed.", min: 0, max: 0.2, step: 0.005, fmt: "dens3", hint: (c) => perSecond(c, c.eco.foodRegrow), get: (c) => c.eco.foodRegrow, set: (c, v) => { c.eco.foodRegrow = v; } }),
      range({ id: "foodMaxDensity", label: "Plant limit", tip: "Plants stop regrowing when the world holds this much, on the density scale.", min: 0, max: 1, step: 0.01, fmt: "dens", hint: (c) => items(c, c.eco.foodMaxDensity), get: (c) => c.eco.foodMaxDensity, set: (c, v) => { c.eco.foodMaxDensity = v; } }),
      range({ id: "foodEnergy", label: "Energy per plant", tip: "Energy a prey gains from one plant. Poison takes the same amount away.", min: 5, max: 100, step: 1, get: (c) => c.world.foodEnergy, set: (c, v) => { c.world.foodEnergy = v; } }),
      ...pick("Regrowth", ["seasons"]),
      ...advanced(pick("Regrowth", ["yearMinutes", "winterFood"])),
      ...advanced(pick("World", ["poisonDensity", "poisonDamage", "itemRadius"])),
      ...advanced(pick("Regrowth", ["poisonRegrow", "poisonMaxDensity"])),
      ...advanced(pick("Life cycle", ["maxPopulation"])),
    ],
  },
  { title: "Prey", swatch: PREY_COLOR, fields: speciesFields(0, "prey", "prey", 3000) },
  { title: "Predators", swatch: PREDATOR_COLOR, fields: speciesFields(1, "pred", "predators", 500) },
  {
    title: "Predation",
    fields: [
      range({ id: "eatEfficiency", label: "Meat efficiency", tip: "Share of a caught prey's stored energy the predator gains. Prey that have grazed well are worth more.", min: 0, max: 1, step: 0.05, fmt: "pct", get: (c) => sp(c, 1).eatEfficiency, set: (c, v) => { sp(c, 1).eatEfficiency = v; } }),
      range({ id: "eatBaseline", label: "Energy per catch", tip: "Energy a predator gains from every catch on top of the prey's stored energy, so even a starving prey is a meal.", min: 0, max: 200, step: 5, get: (c) => sp(c, 1).eatBaseline, set: (c, v) => { sp(c, 1).eatBaseline = v; } }),
    ],
  },
  { title: "Life cycle", folded: true, fields: shared("Life cycle").filter((f) => !["initialPopulation", "poolFraction", "maxPopulation", "birthEnergy", "birthCost", "childEnergy", "birthCooldown"].includes(f.id)) },
  ...ECO_SECTIONS.filter((s) => ["Variation", "Brain", "Mutation"].includes(s.title)).map((s) => ({ ...s, folded: true })),
];

export const PREDATOR_FORM: EcoForm = { sections: PREDATOR_SECTIONS, defaults: DEFAULT_PREDATOR_CONFIG };

// Form fields a preset fixes on this page.
export const PREDATOR_LOCKED: readonly string[] = ["worldWidth", "worldHeight", "foodDensity", "poisonDensity", "itemRadius", "foodEnergy", "poisonDamage", "foodRegrow", "foodMaxDensity", "poisonRegrow", "poisonMaxDensity"];
