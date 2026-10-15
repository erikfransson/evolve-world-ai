import type { EnvSpec } from "./env.ts"; // types only, so env.ts can import this module without a cycle at load time

export const PREY = 0; // species index of the forager / prey
export const PREDATOR = 1;

// The environment index. Ids are stable: keep an env's id when tuning it, add a new one for a new task.

// Small, quick tasks first: one idea each, a few items, short episodes. Each takes milliseconds, so a population of hundreds
// can train for thousands of iterations; slower foragers, the hunt envs and the Live-like "bigger" ones come after.
const small = (o: Pick<EnvSpec, "id" | "name" | "description" | "size" | "food" | "poison" | "seconds"> & Partial<EnvSpec> & { tags: string[] }): EnvSpec => ({
  world: "ecosystem",
  role: PREY,
  foodRegrow: 0,
  rivals: [],
  reward: { food: 1, fast: 0.1 },
  ...o,
  tags: ["small", "forager", ...o.tags],
});

// Live-like envs: 90 s, bumps hurt, a visitor's 300 start energy, and a seed pool crowd of `rivals` (at `rivalEnergy` when given).
const bigger = ({ rivals, rivalEnergy, ...o }: Pick<EnvSpec, "id" | "name" | "description" | "size" | "food" | "poison" | "foodRegrow" | "reward"> & { rivals: number; rivalEnergy?: number }): EnvSpec => ({
  ...o,
  world: "ecosystem",
  role: PREY,
  seconds: 90,
  collisionDamage: true,
  learnerEnergy: 300,
  rivals: [{ species: PREY, count: rivals, source: "pool", ...(rivalEnergy === undefined ? {} : { energy: rivalEnergy }) }],
  tags: ["forager", "bigger"],
});

export const ENVS: readonly EnvSpec[] = [
  // Finding food
  small({ id: "nibble", name: "Nibble", description: "Three bites of food in a tiny box. Find them fast.", size: [200, 200], food: 3, poison: 0, seconds: 15, tags: ["seek"] }),
  small({ id: "corridor", name: "Corridor", description: "A long, narrow room with food along it. Turn around at the ends.", size: [600, 150], food: 4, poison: 2, seconds: 25, tags: ["seek", "shape"] }),
  small({ id: "far-food", name: "Far food", description: "Three pieces of food somewhere in a bigger room. Search.", size: [400, 400], food: 3, poison: 0, seconds: 30, tags: ["search"] }),
  small({ id: "patch", name: "Patch", description: "All the food lies in one patch across the room. Find it, then clear it.", size: [450, 450], food: 10, poison: 4, seconds: 30, layout: { kind: "patch", radius: 70 }, tags: ["search"] }),
  // Avoiding poison and finding a way round
  small({ id: "minefield", name: "Minefield", description: "Four food hidden among twelve poison. One wrong bite ends it.", size: [300, 300], food: 4, poison: 12, seconds: 25, tags: ["caution"] }),
  small({ id: "fence", name: "Fence", description: "A wall of stinging poison with one gap. The food is on the other side.", size: [400, 400], food: 6, poison: 0, seconds: 30, layout: { kind: "fence", gap: 110, near: 2 }, poisonDamage: 25, reward: { food: 1, fast: 0.1, cross: 1 }, tags: ["navigate"] }),
  small({ id: "rooms", name: "Four rooms", description: "A cross of stinging walls makes four rooms with a door in each wall. The food is in the other rooms.", size: [400, 400], food: 6, poison: 0, seconds: 40, layout: { kind: "rooms", gap: 70, near: 1 }, poisonDamage: 25, tags: ["navigate"] }),
  small({ id: "islands", name: "Islands", description: "Food on three small islands, stinging poison in the water between them. Hop from island to island.", size: [500, 500], food: 9, poison: 22, seconds: 35, layout: { kind: "islands", radius: 35 }, poisonDamage: 30, tags: ["search", "caution"] }),
  small({ id: "ring-road", name: "Ring road", description: "Food along a circular lane between two rings of stinging poison. Follow the curve; never cut across.", size: [450, 450], food: 8, poison: 0, seconds: 40, layout: { kind: "ring", lane: 64 }, poisonDamage: 30, reward: { food: 1, fast: 0.1, survive: 0.02 }, tags: ["navigate"] }),
  small({
    id: "bottleneck",
    name: "Bottleneck",
    description: "The fence again, but two foragers want the same gap. Get through without getting stuck behind them.",
    size: [450, 450],
    food: 8,
    poison: 0,
    seconds: 40,
    layout: { kind: "fence", gap: 110, near: 2 },
    poisonDamage: 25,
    rivals: [{ species: PREY, count: 2, source: "pool", energy: 60 }],
    reward: { food: 1, cross: 1, survive: 0.02 },
    tags: ["navigate"],
  }),
  // Memory: what it saw a moment ago decides where to go now
  // Each kept because the same body with memory beats it without over 6 seeds (docs/rl-envs.md); reward food only, as measured.
  small({ id: "flash", name: "Flash", description: "Five bites all around show for two seconds, then go dark but stay there. A creature can head for one; finding the others means remembering where they were.", size: [600, 600], food: 5, poison: 0, seconds: 15, foodVisibleFor: 2, layout: { kind: "flash" }, reward: { food: 1 }, tags: ["memory"] }),
  small({ id: "glimpse", name: "Glimpse", description: "A patch of food shows for a moment, then goes dark. Remember where it was and go there.", size: [500, 500], food: 12, poison: 0, seconds: 25, foodVisibleFor: 1.5, layout: { kind: "patch", radius: 60 }, reward: { food: 1 }, tags: ["memory"] }),
  small({ id: "truffles", name: "Truffles", description: "Food you can never see, packed in one patch. A bite is felt, not seen: stay and search close by.", size: [500, 500], food: 12, poison: 0, seconds: 30, foodVisibleFor: 0, layout: { kind: "patch", radius: 60 }, reward: { food: 1 }, tags: ["memory"] }),
  // Energy
  small({
    id: "lean-times",
    name: "Lean times",
    description: "Little energy, slow-growing food. Do not waste effort; end the minute alive with energy to spare.",
    size: [400, 400],
    food: 8,
    poison: 3,
    foodRegrow: 0.25,
    seconds: 60,
    learnerEnergy: 40,
    poisonDamage: 15, // stings: the lesson is spending energy well, not a single lethal bite
    reward: { survive: 0.05, food: 0.5, energy: 2 },
    tags: ["energy"],
  }),
  small({
    id: "sprint",
    name: "Sprint",
    description: "All the food waits at the far end of a long strip, and you start nearly empty. Go straight; wiggling costs the meal.",
    size: [600, 120],
    food: 5,
    poison: 2,
    seconds: 20,
    learnerEnergy: 100, // about 15 s at full thrust: straight across takes 7, a wandering search starves
    layout: { kind: "sprint", near: 1 },
    poisonDamage: 25,
    tags: ["energy"],
  }),
  small({
    id: "toll-road",
    name: "Toll road",
    description: "A closed belt of mild poison with most of the food behind it. Paying one sting is worth it; wandering along the belt is not. Hard.",
    size: [400, 300],
    food: 6,
    poison: 0,
    seconds: 35,
    learnerEnergy: 30,
    layout: { kind: "fence", gap: 0, near: 1 },
    poisonDamage: 8,
    reward: { food: 1, energy: 2 },
    tags: ["energy"],
  }),
  small({ id: "wait", name: "Wait for it", description: "A small room where food grows back slowly, and little energy to start. Rushing about burns it; staying calm and taking each bite as it comes pays.", size: [260, 260], food: 3, poison: 0, foodRegrow: 0.4, seconds: 60, learnerEnergy: 60, reward: { energy: 2, survive: 0.05 }, tags: ["energy"] }),
  // Fighting
  small({
    id: "aggressor",
    name: "Aggressor",
    description: "You are big and full of energy among weak grazers. Ram them: a kill hands you their energy.",
    size: [400, 400],
    food: 10,
    poison: 0,
    foodRegrow: 0.4,
    seconds: 30,
    collisionDamage: true,
    learnerEnergy: 200,
    rivals: [{ species: PREY, count: 6, source: "pool", energy: 30 }],
    reward: { ram: 1, energy: 1 },
    tags: ["fight"],
  }),
  small({
    id: "escape",
    name: "Escape",
    description: "Graze while trained aggressors try to ram you. Stay out of reach and keep eating.",
    size: [500, 500],
    food: 8,
    poison: 0,
    foodRegrow: 0.3,
    seconds: 40,
    collisionDamage: true,
    rivals: [{ species: PREY, count: 2, source: "library:aggressor", energy: 200 }],
    reward: { survive: 0.05, food: 0.5 },
    tags: ["fight", "league"],
  }),
  // Competing (self-play: rivals are the learner's own current brain and its recent best candidates)
  small({ id: "duel", name: "Duel", description: "Six food and one trained rival from the seed pool who wants them too.", size: [300, 300], food: 6, poison: 0, seconds: 25, rivals: [{ species: PREY, count: 1, source: "pool" }], tags: ["compete"] }),
  small({
    id: "crowd",
    name: "Crowd",
    description: "Ten slow grazers fill the room and every bump costs energy. Thread through the crowd to the food.",
    size: [450, 450],
    food: 6,
    poison: 0,
    foodRegrow: 0.3,
    seconds: 30,
    collisionDamage: true,
    learnerEnergy: 100,
    rivals: [{ species: PREY, count: 10, source: "random", energy: 150 }],
    reward: { food: 1, survive: 0.02 },
    tags: ["compete"],
  }),
  small({
    id: "melee",
    name: "Melee",
    description: "You and four copies of your own best selves share slowly regrowing food. Out-eat yourself.",
    size: [500, 500],
    food: 10,
    poison: 2,
    foodRegrow: 0.4,
    seconds: 30,
    rivals: [{ species: PREY, count: 4, source: "self" }],
    reward: { food: 1 },
    tags: ["compete", "self-play"],
  }),
  small({
    id: "brawl",
    name: "Brawl",
    description: "Melee with collision damage: copies of yourself fight over food, and a kill takes the loser's energy.",
    size: [400, 400],
    food: 6,
    poison: 0,
    foodRegrow: 0.3,
    seconds: 30,
    collisionDamage: true,
    rivals: [{ species: PREY, count: 3, source: "self" }],
    reward: { food: 1, ram: 1, survive: 0.02 },
    tags: ["fight", "self-play"],
  }),
  // Bigger, slower forager envs, filed with the groups above by their tags
  {
    id: "forage-sparse",
    name: "Sparse plains",
    description: "A wide world with food spread thin. Search well and keep moving.",
    world: "ecosystem",
    role: PREY,
    size: [1800, 1800],
    food: 14,
    poison: 4,
    foodRegrow: 0,
    seconds: 60,
    rivals: [],
    reward: { food: 1 },
    tags: ["forager", "search"],
  },
  {
    id: "poison-field",
    name: "Poison field",
    description: "Food scattered among dense poison. One wrong bite ends the run.",
    world: "ecosystem",
    role: PREY,
    size: [900, 900],
    food: 16,
    poison: 70,
    foodRegrow: 0,
    seconds: 45,
    rivals: [],
    reward: { food: 1, survive: 0.05 },
    tags: ["forager", "caution"],
  },
  {
    id: "rivals",
    name: "Rivals",
    description: "Six trained foragers compete for the same slowly regrowing food.",
    world: "ecosystem",
    role: PREY,
    size: [900, 900],
    food: 18,
    poison: 6,
    foodRegrow: 0.3,
    seconds: 60,
    rivals: [{ species: PREY, count: 6, source: "pool" }],
    reward: { food: 1 },
    tags: ["forager", "compete"],
  },
  {
    id: "endurance",
    name: "Endurance",
    description: "Food regrows slowly over two minutes. Stay alive and end with energy to spare.",
    world: "ecosystem",
    role: PREY,
    size: [1400, 1400],
    food: 20,
    poison: 10,
    foodRegrow: 0.25,
    seconds: 120,
    rivals: [],
    reward: { survive: 0.1, energy: 4 },
    tags: ["forager", "energy"],
  },
  // Advanced: hunters and prey (hidden while the Arena trains foragers only)
  {
    id: "hunt-wanderers",
    name: "Hunt: wanderers",
    description: "Catch untrained prey that drift around a small box.",
    world: "hunt",
    role: PREDATOR,
    size: [800, 800],
    food: 12,
    poison: 0,
    foodRegrow: 0.2,
    seconds: 45,
    rivals: [{ species: PREY, count: 8, source: "random" }],
    reward: { kill: 1 },
    tags: ["hunter", "basic", "advanced"],
  },
  {
    id: "hunt-grazers",
    name: "Hunt: grazers",
    description: "Catch trained foragers that move with purpose towards food.",
    world: "hunt",
    role: PREDATOR,
    size: [1000, 1000],
    food: 20,
    poison: 2,
    foodRegrow: 0.3,
    seconds: 60,
    rivals: [{ species: PREY, count: 8, source: "pool" }],
    reward: { kill: 1 },
    tags: ["hunter", "advanced"],
  },
  {
    id: "hunt-evaders",
    name: "Hunt: evaders",
    description: "Catch prey that were trained to escape hunters (from Evade), the hardest hunt.",
    world: "hunt",
    role: PREDATOR,
    size: [1000, 1000],
    food: 20,
    poison: 2,
    foodRegrow: 0.3,
    seconds: 60,
    rivals: [{ species: PREY, count: 8, source: "library:evade" }],
    reward: { kill: 1 },
    tags: ["hunter", "league", "advanced"],
  },
  {
    id: "evade",
    name: "Evade",
    description: "Graze while trained hunters (from Hunt: grazers) chase you. Survive and eat.",
    world: "hunt",
    role: PREY,
    size: [1000, 1000],
    food: 24,
    poison: 2,
    foodRegrow: 0.3,
    seconds: 60,
    rivals: [{ species: PREDATOR, count: 3, source: "library:hunt-grazers" }],
    reward: { survive: 0.1, food: 0.5 },
    tags: ["prey", "league", "advanced"],
  },
  // Bigger: patches of the Live World (regrowing food, lethal poison, seed pool crowds, bumps hurt), starting at a visitor's 300 energy.
  bigger({ id: "live-patch", name: "Live patch", description: "A slice of the Live World: regrowing food, lethal poison and a crowd of trained foragers. Bumps hurt.", size: [1200, 1200], food: 60, poison: 20, foodRegrow: 2, rivals: 20, reward: { food: 1, survive: 0.03 } }),
  bigger({ id: "live-famine", name: "Feast and famine", description: "A wide, thinly fed land with a few rivals. Range far to find the food before it runs out.", size: [2200, 2200], food: 35, poison: 15, foodRegrow: 0.3, rivals: 8, reward: { food: 1, survive: 0.03 } }),
  bigger({ id: "live-poison", name: "Poison country", description: "More poison than food over a big land, with rivals. Tell the two apart or die.", size: [1500, 1500], food: 40, poison: 90, foodRegrow: 1, rivals: 12, reward: { food: 1, survive: 0.05 } }),
  bigger({ id: "live-commons", name: "Crowded commons", description: "Little food and many weak foragers. Ramming them pays.", size: [1000, 1000], food: 20, poison: 10, foodRegrow: 0.5, rivals: 25, rivalEnergy: 25, reward: { food: 0.5, ram: 2, survive: 0.02 } }),
];

export const envById = (id: string): EnvSpec | undefined => ENVS.find((e) => e.id === id);

// Categories for choosing envs, in display order; groupOf files an env under one by its tags.
export const ENV_GROUPS = ["Find food", "Avoid and find a way", "Memory", "Energy", "Fight", "Compete", "Advanced", "Bigger", "Custom"] as const;
export type EnvGroup = (typeof ENV_GROUPS)[number];
export const FOLDED_GROUPS: ReadonlySet<EnvGroup> = new Set(["Advanced", "Bigger"]); // the slow ones, folded in the gallery until opened

export function groupOf(env: Pick<EnvSpec, "tags">): EnvGroup {
  const t = new Set(env.tags);
  if (t.has("custom")) return "Custom";
  if (t.has("bigger")) return "Bigger";
  if (t.has("advanced")) return "Advanced";
  if (t.has("compete")) return "Compete";
  if (t.has("fight")) return "Fight";
  if (t.has("energy")) return "Energy";
  if (t.has("memory")) return "Memory";
  if (t.has("caution") || t.has("navigate")) return "Avoid and find a way";
  return "Find food";
}
