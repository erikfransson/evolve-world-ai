import { DEFAULT_CONFIG, ITEM_RADIUS_RANGE, POISON_LETHAL } from "../sim/config.ts";
import { planOf, planUpkeep } from "../sim/sensors.ts";
import type { SelectionMethod, SimConfig } from "../sim/config.ts";
import { configPlanFields, items, mapFields, range } from "./settingsForm.ts";
import type { FormSpec, Section } from "./settingsForm.ts";

// Trials settings, built by buildForm in settingsForm.ts.
const defaultNeurons = DEFAULT_CONFIG.brain.hiddenLayers[0]!;
const r = range<SimConfig>;
const plan = configPlanFields<SimConfig>(defaultNeurons);

const SIZE_TIP = "Size of the box the creatures live in. For scale, the default vision range is 100 units.";

export const TRIALS_SECTIONS: readonly Section<SimConfig>[] = [
  {
    title: "World",
    fields: [
      { kind: "seed", id: "seed", label: "Seed", tip: "Number that fixes all randomness. The same seed and settings give the same run." },
      r({ id: "worldWidth", label: "World width", tip: SIZE_TIP, min: 200, max: 4000, step: 10, fmt: "size", get: (c) => c.world.width, set: (c, v) => { c.world.width = v; } }),
      r({ id: "worldHeight", label: "World height", tip: SIZE_TIP, min: 200, max: 3000, step: 10, fmt: "size", get: (c) => c.world.height, set: (c, v) => { c.world.height = v; } }),
      r({ id: "foodDensity", label: "Start food", tip: "How much food is in the world. 0 is none, 1 means roughly one piece in every 100 × 100 area.", min: 0, max: 1, step: 0.01, fmt: "dens", hint: (c) => items(c, c.world.foodDensity), get: (c) => c.world.foodDensity, set: (c, v) => { c.world.foodDensity = v; } }),
      r({ id: "poisonDensity", label: "Start poison", tip: "How much poison there is, on the same scale as food. 0 turns poison off.", min: 0, max: 1, step: 0.01, fmt: "dens", hint: (c) => items(c, c.world.poisonDensity), get: (c) => c.world.poisonDensity, set: (c, v) => { c.world.poisonDensity = v; } }),
      ...mapFields<SimConfig>(),
      r({ id: "poisonDamage", label: "Poison damage", tip: "Energy one piece of poison drains. The top step, Lethal, kills the creature at once. 0 makes poison harmless.", min: 0, max: POISON_LETHAL, step: 5, fmt: "poison", get: (c) => c.world.poisonDamage, set: (c, v) => { c.world.poisonDamage = v; } }),
      { kind: "toggle", id: "respawn", label: "Food regrows", tip: "When on, eaten food reappears elsewhere, so a skilled creature can live very long. When off, food is limited and every life ends.", get: (c) => c.world.respawn, set: (c, v) => { c.world.respawn = v; } },
      r({ id: "itemRadius", label: "Item size", tip: "Radius of food and poison pieces. Bigger pieces are easier to hit and to see.", min: ITEM_RADIUS_RANGE[0], max: ITEM_RADIUS_RANGE[1], step: 0.1, fmt: "size1", advanced: true, get: (c) => c.world.itemRadius, set: (c, v) => { c.world.itemRadius = v; } }),
      r({ id: "foodEnergy", label: "Energy per food", tip: "Energy a creature gains from one piece of food.", min: 5, max: 100, step: 1, advanced: true, get: (c) => c.world.foodEnergy, set: (c, v) => { c.world.foodEnergy = v; } }),
      r({ id: "poisonClearRadius", label: "Poison-free start", tip: "No poison starts this close to the creature, so it does not die on the first step.", min: 0, max: 400, step: 10, fmt: "size", advanced: true, get: (c) => c.world.poisonClearRadius, set: (c, v) => { c.world.poisonClearRadius = v; } }),
    ],
  },
  {
    title: "Creature",
    fields: plan.creature,
  },
  {
    title: "Brain",
    note: (c) => `Base energy use ${planUpkeep(planOf(c), c).toFixed(2)} per second: living, vision and neurons. Thrust and turning cost extra.`,
    fields: plan.brain,
  },
  {
    title: "Evolution",
    fields: [
      r({ id: "popSize", label: "Population", tip: "How many creatures are tested in each generation.", min: 4, max: 10000, step: 1, log: true, get: (c) => c.population.size, set: (c, v) => { c.population.size = v; } }),
      r({ id: "mutationRate", label: "Mutation rate", tip: "Chance that each number in a child's brain is randomly nudged. If a whole generation scores the same, the next one mutates three times as hard until selection has a signal again.", min: 0, max: 0.5, step: 0.005, fmt: "pct1", get: (c) => c.ga.mutationRate, set: (c, v) => { c.ga.mutationRate = v; } }),
      r({ id: "immigrants", label: "Newcomers", tip: "Share of each generation that is brand new random creatures. They help when the population is stuck.", min: 0, max: 0.2, step: 0.01, fmt: "pct", get: (c) => c.ga.immigrantFraction, set: (c, v) => { c.ga.immigrantFraction = v; } }),
      r({ id: "bigMutations", label: "Wild children", tip: "Share of children that get a large mutation, some numbers flipping sign. Rarely better, but can break out of a rut.", min: 0, max: 0.2, step: 0.01, fmt: "pct", get: (c) => c.ga.bigMutationFraction, set: (c, v) => { c.ga.bigMutationFraction = v; } }),
      { kind: "choice", id: "selection", label: "Selection", tip: "How parents are picked. Truncation: the top 10% breed. Proportional: chance grows with score.", options: [["truncation", "Truncation"], ["proportional", "Proportional"]], get: (c) => c.ga.selection, set: (c, v) => { c.ga.selection = v as SelectionMethod; } },
    ],
  },
];

export const TRIALS_FORM: FormSpec<SimConfig> = { sections: TRIALS_SECTIONS, defaults: DEFAULT_CONFIG };
