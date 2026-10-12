import { ITEM_RADIUS_RANGE, POISON_LETHAL } from "../sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "../sim/ecoConfig.ts";
import type { EcoConfig } from "../sim/ecoConfig.ts";
import { MAPS, mapSpec } from "../sim/maps/index.ts";
import { items, mapFields, perSecond, range, rangePair } from "./settingsForm.ts";
import type { FormSpec, Section } from "./settingsForm.ts";

// Ecosystem settings, built by buildForm in settingsForm.ts.
const defaultNeurons = DEFAULT_ECO_CONFIG.brain.hiddenLayers[0]!;

export const ECO_SECTIONS: readonly Section<EcoConfig>[] = [
  {
    title: "World",
    fields: [
      { kind: "seed", id: "seed", label: "Seed", tip: "Number that fixes all randomness. The same seed and settings give the same run." },
      range({ id: "worldWidth", label: "World width", tip: "Size of the box the creatures live in. For scale, the default vision range is 100 units.", min: 500, max: 40000, step: 50, fmt: "size", get: (c) => c.world.width, set: (c, v) => { c.world.width = v; } }),
      range({ id: "worldHeight", label: "World height", tip: "Size of the box the creatures live in. For scale, the default vision range is 100 units.", min: 500, max: 25000, step: 50, fmt: "size", get: (c) => c.world.height, set: (c, v) => { c.world.height = v; } }),
      range({ id: "foodDensity", label: "Start food", tip: "How much food lies around at the start. 1 means roughly one piece in every 100 × 100 area.", min: 0, max: 1, step: 0.005, fmt: "dens3", hint: (c) => items(c, c.world.foodDensity), get: (c) => c.world.foodDensity, set: (c, v) => { c.world.foodDensity = v; } }),
      range({ id: "poisonDensity", label: "Start poison", tip: "How much poison lies around at the start, on the same scale as food. 0 turns poison off.", min: 0, max: 1, step: 0.005, fmt: "dens3", hint: (c) => items(c, c.world.poisonDensity), get: (c) => c.world.poisonDensity, set: (c, v) => { c.world.poisonDensity = v; } }),
      { kind: "choice", id: "worldMap", label: "Map", tip: "A hand-designed map with its own ground, rock and richer and poorer regions, instead of random stones, mud and firm ground. It fixes the world size.", options: [["", "Random"], ...Object.values(MAPS).map((m): [string, string] => [m.name, m.title])], get: (c) => c.world.map ?? "", set: (c, v) => { c.world.map = v; const m = mapSpec(v); if (m) { c.world.width = m.width; c.world.height = m.height; } } },
      ...mapFields<EcoConfig>().map((f) => ({ ...f, enabledWhen: (c: EcoConfig) => !c.world.map })),
      range({ id: "itemRadius", label: "Item size", tip: "Radius of food and poison pieces. Bigger pieces are easier to hit and to see.", min: ITEM_RADIUS_RANGE[0], max: ITEM_RADIUS_RANGE[1], step: 0.1, fmt: "size1", get: (c) => c.world.itemRadius, set: (c, v) => { c.world.itemRadius = v; } }),
      range({ id: "poisonDamage", label: "Poison damage", tip: "Energy a creature loses from one piece of poison. The top step, Lethal, kills it at once.", min: 0, max: POISON_LETHAL, step: 5, fmt: "poison", get: (c) => c.world.poisonDamage, set: (c, v) => { c.world.poisonDamage = v; } }),
      range({ id: "foodEnergy", label: "Energy per food", tip: "Energy a creature gains from one piece of food.", min: 5, max: 100, step: 1, get: (c) => c.world.foodEnergy, set: (c, v) => { c.world.foodEnergy = v; } }),
    ],
  },
  {
    title: "Regrowth",
    fields: [
      range({ id: "foodRegrow", label: "Food regrowth", tip: "How fast new food appears, in the same density units as the start food, per second. Together with the energy per food this sets how many creatures the world can feed.", min: 0, max: 0.3, step: 0.001, fmt: "dens3", hint: (c) => perSecond(c, c.eco.foodRegrow), get: (c) => c.eco.foodRegrow, set: (c, v) => { c.eco.foodRegrow = v; } }),
      range({ id: "foodMaxDensity", label: "Food limit", tip: "Food stops regrowing when the world holds this much, on the density scale.", min: 0, max: 2, step: 0.005, fmt: "dens3", hint: (c) => items(c, c.eco.foodMaxDensity), get: (c) => c.eco.foodMaxDensity, set: (c, v) => { c.eco.foodMaxDensity = v; } }),
      { kind: "toggle", id: "seasons", label: "Seasons", tip: "When on, food regrowth swings over the year between full speed in summer and a fraction of it in winter. Poison is not affected. The run starts at mid-summer.", get: (c) => c.eco.seasons, set: (c, v) => { c.eco.seasons = v; } },
      range({ id: "yearMinutes", label: "Year length", tip: "Simulated minutes from one summer to the next. A season is a quarter of this. Only used when Seasons is on.", enabledWhen: (c) => c.eco.seasons, min: 4, max: 120, step: 1, fmt: "min", get: (c) => c.eco.yearMinutes, set: (c, v) => { c.eco.yearMinutes = v; } }),
      range({ id: "winterFood", label: "Winter food", tip: "Food regrowth at mid-winter as a share of the full rate. 30% means winter food grows at 0.3 times the summer speed. Only used when Seasons is on.", enabledWhen: (c) => c.eco.seasons, min: 0, max: 1, step: 0.01, fmt: "pct", get: (c) => c.eco.winterFood, set: (c, v) => { c.eco.winterFood = v; } }),
      range({ id: "poisonRegrow", label: "Poison regrowth", tip: "How fast new poison appears, per second, on the same scale as food regrowth.", min: 0, max: 0.05, step: 0.0001, fmt: "dens4", hint: (c) => perSecond(c, c.eco.poisonRegrow), get: (c) => c.eco.poisonRegrow, set: (c, v) => { c.eco.poisonRegrow = v; } }),
      range({ id: "poisonMaxDensity", label: "Poison limit", tip: "Poison stops regrowing when the world holds this much, so it cannot fill the board.", min: 0, max: 0.5, step: 0.005, fmt: "dens3", hint: (c) => items(c, c.eco.poisonMaxDensity), get: (c) => c.eco.poisonMaxDensity, set: (c, v) => { c.eco.poisonMaxDensity = v; } }),
    ],
  },
  {
    title: "Life cycle",
    fields: [
      range({ id: "initialPopulation", label: "Start creatures", tip: "How many creatures the run starts with, each with a random colour.", min: 10, max: 10000, step: 1, get: (c) => c.eco.initialPopulation, set: (c, v) => { c.eco.initialPopulation = v; } }),
      range({ id: "poolFraction", label: "Trained founders", tip: "Share of the start creatures copied, with small mutations, from a pool of creatures trained in Trials with many different eyes and brains. They keep their own rays and brain shape. The rest start with random brains.", min: 0, max: 1, step: 0.01, fmt: "pct", get: (c) => c.eco.poolFraction, set: (c, v) => { c.eco.poolFraction = v; } }),
      range({ id: "maxPopulation", label: "Population limit", tip: "Most creatures alive at once, of every kind together. Births wait while the world is full, and when there are more starting creatures than this, every kind starts with fewer in proportion.", min: 100, max: 10000, step: 10, get: (c) => c.eco.maxPopulation, set: (c, v) => { c.eco.maxPopulation = v; } }),
      ...rangePair<EcoConfig>({ id: "birthEnergy", label: "Birth energy", tip: "A creature with at least this much energy has a child. Each creature gets its own value, drawn between min and max for founders and nudged a little in every child, so evolution can pick. A creature's body is drawn full at the middle of the range.", min: 20, max: 10000, step: 1, get: (c) => c.eco.birthEnergyRange, set: (c, v) => { c.eco.birthEnergyRange = v; } }),
      ...rangePair<EcoConfig>({ id: "birthCost", label: "Birth cost", tip: "Energy the parent pays for a child, which is exactly the energy the child starts with. A parent that pays all it has gives it all to the child and dies. Each creature has its own value between min and max.", min: 10, max: 10000, step: 1, get: (c) => c.eco.birthCostRange, set: (c, v) => { c.eco.birthCostRange = v; } }),
      ...rangePair<EcoConfig>({ id: "birthCooldown", label: "Birth cooldown", tip: "Seconds a parent must wait before it can have another child. Each creature has its own value between min and max.", min: 0, max: 60, step: 0.1, fmt: "sec", get: (c) => c.eco.birthCooldownRange, set: (c, v) => { c.eco.birthCooldownRange = v; } }),
      range({ id: "birthDrift", label: "Birth drift", tip: "How much a child's birth energy, cost and cooldown may differ from its parent's, as a fraction of the value. 0 copies them exactly.", min: 0, max: 0.5, step: 0.01, fmt: "dens", get: (c) => c.eco.birthDrift, set: (c, v) => { c.eco.birthDrift = v; } }),
      range({ id: "birthSpeed", label: "Birth launch speed", tip: "A newborn is launched away from its parent at this speed, in a random direction, so families spread out.", min: 0, max: 200, step: 1, fmt: "speed", get: (c) => c.eco.birthSpeed, set: (c, v) => { c.eco.birthSpeed = v; } }),
      range({ id: "hueDrift", label: "Colour drift", tip: "How far a child's colour may wander from its parent's, in degrees. Related creatures keep similar colours.", min: 0, max: 45, step: 1, fmt: "deg", get: (c) => c.eco.hueDrift, set: (c, v) => { c.eco.hueDrift = v; } }),
      { kind: "toggle", id: "aging", label: "Aging", tip: "When on, old creatures need more food. After the start age their living cost grows steadily, so no family lives for ever without eating more.", get: (c) => c.eco.aging, set: (c, v) => { c.eco.aging = v; } },
      range({ id: "agingStart", label: "Aging starts at", tip: "Age in seconds after which a creature's living cost starts to grow. Only used when Aging is on.", enabledWhen: (c) => c.eco.aging, min: 30, max: 600, step: 1, fmt: "sec", get: (c) => c.eco.agingStart, set: (c, v) => { c.eco.agingStart = v; } }),
      range({ id: "agingRate", label: "Aging rate", tip: "How much the living cost grows for each minute of age past the start age, as a share of the normal cost. 50% means a creature one minute past the start pays half as much again. Only used when Aging is on.", enabledWhen: (c) => c.eco.aging, min: 0, max: 2, step: 0.01, fmt: "pct", get: (c) => c.eco.agingRate, set: (c, v) => { c.eco.agingRate = v; } }),
      { kind: "toggle", id: "collisions", label: "Collisions", tip: "When on, creatures bounce off each other. Rays see other creatures either way.", get: (c) => c.eco.collisions, set: (c, v) => { c.eco.collisions = v; } },
      { kind: "toggle", id: "collisionDamage", label: "Collision damage", tip: "When on, a bounce hurts both creatures, the harder the faster they hit. A creature that dies from a bounce gives the energy it had to the other one, so weak neighbours are worth bumping. Only used when Collisions is on.", enabledWhen: (c) => c.eco.collisions, get: (c) => c.eco.collisionDamage, set: (c, v) => { c.eco.collisionDamage = v; } },
      range({ id: "damagePerSpeed", label: "Damage per speed", tip: "Energy each creature loses per unit of speed at which they hit. The default 0.3 costs about 5 for a gentle touch and about 50 for two creatures colliding head-on at top speed. Only used when Collision damage is on.", enabledWhen: (c) => c.eco.collisions && c.eco.collisionDamage, min: 0, max: 1, step: 0.01, fmt: "dens", get: (c) => c.eco.damagePerSpeed, set: (c, v) => { c.eco.damagePerSpeed = v; } }),
      { kind: "toggle", id: "wasm", label: "Use WebAssembly", tip: "When on, creatures look at each other and think with faster WebAssembly code, if the browser supports it. It rounds numbers a little differently, so a run differs in detail from one with this off, but behaves the same on average.", get: (c) => c.eco.wasm, set: (c, v) => { c.eco.wasm = v; } },
    ],
  },
  {
    title: "Variation",
    fields: [
      { kind: "toggle", id: "foundersVary", label: "Varied founders", tip: "When on, every starting creature gets its own number of rays, vision angle and range, hidden neurons and memory. When off, all use the Creature and Brain settings below.", get: (c) => c.eco.foundersVary, set: (c, v) => { c.eco.foundersVary = v; } },
      range({ id: "planDrift", label: "Plan drift", tip: "How much a child's vision angle and range may differ from its parent's, as a fraction of the parent's value. 0 copies them exactly.", min: 0, max: 0.1, step: 0.001, fmt: "dens3", get: (c) => c.eco.planDrift, set: (c, v) => { c.eco.planDrift = v; } }),
      range({ id: "structuralRate", label: "Structural mutation rate", tip: "Chance that a newborn gains or loses one ray, hidden neuron or memory unit compared with its parent. A new part starts out doing nothing, so the child behaves like its parent at first.", min: 0, max: 0.2, step: 0.001, fmt: "pct1", get: (c) => c.eco.structuralRate, set: (c, v) => { c.eco.structuralRate = v; } }),
    ],
  },
  {
    title: "Creature",
    fields: [
      range({ id: "rayCount", label: "Vision rays", tip: "How many laser rays each creature sees with. More rays give a finer view and more inputs to the brain.", min: 1, max: 16, step: 1, get: (c) => c.creature.rayCount, set: (c, v) => { c.creature.rayCount = v; } }),
      range({ id: "raySpread", label: "Vision angle", tip: "Total width of the fan of rays, centred on where the creature faces.", min: 10, max: 360, step: 1, fmt: "deg", get: (c) => Math.round((c.creature.raySpread * 180) / Math.PI), set: (c, v) => { c.creature.raySpread = (v * Math.PI) / 180; } }),
      range({ id: "rayLength", label: "Vision range", tip: "How far each vision ray reaches, in world units.", min: 40, max: 300, step: 1, fmt: "size", get: (c) => c.creature.rayLength, set: (c, v) => { c.creature.rayLength = v; } }),
    ],
  },
  {
    title: "Brain",
    fields: [
      range({ id: "layers", label: "Hidden layers", tip: "How many layers of neurons sit between the creature's eyes and its muscles.", min: 1, max: 4, step: 1, get: (c) => c.brain.hiddenLayers.length, set: (c, v) => { c.brain.hiddenLayers = new Array<number>(v).fill(c.brain.hiddenLayers[0] ?? defaultNeurons); } }),
      range({ id: "neurons", label: "Neurons per layer", tip: "Neurons in each hidden layer. More can learn richer behaviour but evolve more slowly.", min: 4, max: 32, step: 1, get: (c) => c.brain.hiddenLayers[0] ?? defaultNeurons, set: (c, v) => { c.brain.hiddenLayers.fill(v); } }),
      range({ id: "memory", label: "Memory", tip: "Short- and long-term memory the brain can write to and read back on the next moment, so it can remember what it saw. 0 is none, 0.5 gives 4 short-term and 4 long-term memory units, 1 gives 8 of each.", min: 0, max: 1, step: 0.05, fmt: "dens", get: (c) => c.brain.memory, set: (c, v) => { c.brain.memory = v; } }),
    ],
  },
  {
    title: "Mutation",
    fields: [
      range({ id: "mutationRate", label: "Mutation rate", tip: "Chance that each number in a child's brain is randomly nudged.", min: 0, max: 0.5, step: 0.005, fmt: "pct1", get: (c) => c.mutation.rate, set: (c, v) => { c.mutation.rate = v; } }),
      range({ id: "mutationStd", label: "Mutation size", tip: "Typical size of a nudge. Larger values change a child's behaviour more.", min: 0, max: 1, step: 0.01, fmt: "dens", get: (c) => c.mutation.std, set: (c, v) => { c.mutation.std = v; } }),
    ],
  },
];

export const ECO_FORM: FormSpec<EcoConfig> = { sections: ECO_SECTIONS, defaults: DEFAULT_ECO_CONFIG };
