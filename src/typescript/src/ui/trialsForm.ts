import { DEFAULT_CONFIG, POISON_LETHAL } from "../sim/config.ts";
import { planOf, planUpkeep } from "../sim/sensors.ts";
import type { SelectionMethod, SimConfig } from "../sim/config.ts";
import { items, mapFields, range } from "./settingsForm.ts";
import type { FormSpec, Section } from "./settingsForm.ts";

// Trials settings, built by buildForm in settingsForm.ts.
const defaultNeurons = DEFAULT_CONFIG.brain.hiddenLayers[0]!;
const r = range<SimConfig>;

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
      r({ id: "itemRadius", label: "Item size", tip: "Radius of food and poison pieces. Bigger pieces are easier to hit and to see.", min: 2, max: 10, step: 0.5, fmt: "size", advanced: true, get: (c) => c.world.itemRadius, set: (c, v) => { c.world.itemRadius = v; } }),
      r({ id: "foodEnergy", label: "Energy per food", tip: "Energy a creature gains from one piece of food.", min: 5, max: 100, step: 1, advanced: true, get: (c) => c.world.foodEnergy, set: (c, v) => { c.world.foodEnergy = v; } }),
      r({ id: "poisonClearRadius", label: "Poison-free start", tip: "No poison starts this close to the creature, so it does not die on the first step.", min: 0, max: 400, step: 10, fmt: "size", advanced: true, get: (c) => c.world.poisonClearRadius, set: (c, v) => { c.world.poisonClearRadius = v; } }),
    ],
  },
  {
    title: "Creature",
    fields: [
      r({ id: "rayCount", label: "Vision rays", tip: "How many laser rays each creature sees with. More rays give a finer view and more inputs to the brain.", min: 1, max: 16, step: 1, get: (c) => c.creature.rayCount, set: (c, v) => { c.creature.rayCount = v; } }),
      r({ id: "raySpread", label: "Vision angle", tip: "Total width of the fan of rays, centred on where the creature faces.", min: 10, max: 360, step: 5, fmt: "deg", get: (c) => Math.round((c.creature.raySpread * 180) / Math.PI), set: (c, v) => { c.creature.raySpread = (v * Math.PI) / 180; } }),
      r({ id: "rayLength", label: "Vision range", tip: "How far each vision ray reaches, in world units.", min: 40, max: 300, step: 5, fmt: "size", get: (c) => c.creature.rayLength, set: (c, v) => { c.creature.rayLength = v; } }),
    ],
  },
  {
    title: "Brain",
    note: (c) => `Base energy use ${planUpkeep(planOf(c), c).toFixed(2)} per second: living, vision and neurons. Thrust and turning cost extra.`,
    fields: [
      r({ id: "layers", label: "Hidden layers", tip: "How many layers of neurons sit between the creature's eyes and its muscles.", min: 1, max: 4, step: 1, get: (c) => c.brain.hiddenLayers.length, set: (c, v) => { c.brain.hiddenLayers = new Array<number>(v).fill(c.brain.hiddenLayers[0] ?? defaultNeurons); } }),
      r({ id: "neurons", label: "Neurons per layer", tip: "Neurons in each hidden layer. More can learn richer behaviour but evolve more slowly.", min: 4, max: 32, step: 1, get: (c) => c.brain.hiddenLayers[0] ?? defaultNeurons, set: (c, v) => { c.brain.hiddenLayers.fill(v); } }),
      r({ id: "memory", label: "Memory", tip: "Short- and long-term memory the brain can write to and read back on the next moment, so it can remember what it saw. 0 is none, 0.5 gives 4 short-term and 4 long-term memory units, 1 gives 8 of each.", min: 0, max: 1, step: 0.05, fmt: "dens", get: (c) => c.brain.memory, set: (c, v) => { c.brain.memory = v; } }),
    ],
  },
  {
    title: "Evolution",
    fields: [
      r({ id: "popSize", label: "Population", tip: "How many creatures are tested in each generation.", min: 4, max: 10000, step: 1, get: (c) => c.population.size, set: (c, v) => { c.population.size = v; } }),
      r({ id: "mutationRate", label: "Mutation rate", tip: "Chance that each number in a child's brain is randomly nudged. If a whole generation scores the same, the next one mutates three times as hard until selection has a signal again.", min: 0, max: 0.5, step: 0.01, fmt: "pct", get: (c) => c.ga.mutationRate, set: (c, v) => { c.ga.mutationRate = v; } }),
      r({ id: "immigrants", label: "Newcomers", tip: "Share of each generation that is brand new random creatures. They help when the population is stuck.", min: 0, max: 0.2, step: 0.01, fmt: "pct", get: (c) => c.ga.immigrantFraction, set: (c, v) => { c.ga.immigrantFraction = v; } }),
      r({ id: "bigMutations", label: "Wild children", tip: "Share of children that get a large mutation, some numbers flipping sign. Rarely better, but can break out of a rut.", min: 0, max: 0.2, step: 0.01, fmt: "pct", get: (c) => c.ga.bigMutationFraction, set: (c, v) => { c.ga.bigMutationFraction = v; } }),
      { kind: "choice", id: "selection", label: "Selection", tip: "How parents are picked. Truncation: the top 10% breed. Proportional: chance grows with score.", options: [["truncation", "Truncation"], ["proportional", "Proportional"]], get: (c) => c.ga.selection, set: (c, v) => { c.ga.selection = v as SelectionMethod; } },
    ],
  },
];

export const TRIALS_FORM: FormSpec<SimConfig> = { sections: TRIALS_SECTIONS, defaults: DEFAULT_CONFIG };
