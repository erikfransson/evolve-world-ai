import type { EnvSpec } from "./env.ts"; // types only, so env.ts can import this module without a cycle at load time

export const PREY = 0; // species index of the forager / prey
export const PREDATOR = 1;

// The environment index. Ids are stable: keep an env's id when tuning it, add a new one for a new task.

// Small, quick tasks first: one idea each, a few items, short episodes. Each takes milliseconds, so a population of hundreds
// can train for thousands of iterations; the bigger "advanced" envs below come after.
const small = (o: Pick<EnvSpec, "id" | "name" | "description" | "size" | "food" | "poison" | "seconds"> & Partial<EnvSpec> & { tags: string[] }): EnvSpec => ({
  world: "ecosystem",
  role: PREY,
  foodRegrow: 0,
  rivals: [],
  reward: { food: 1, fast: 0.1 },
  ...o,
  tags: ["small", "forager", ...o.tags],
});

export const ENVS: readonly EnvSpec[] = [
  // Finding food
  small({ id: "nibble", name: "Nibble", description: "Three bites of food in a tiny box. Find them fast.", size: [200, 200], food: 3, poison: 0, seconds: 15, tags: ["seek"] }),
  small({ id: "corridor", name: "Corridor", description: "A long, narrow room with food along it. Turn around at the ends.", size: [600, 150], food: 4, poison: 2, seconds: 25, tags: ["seek", "shape"] }),
  small({ id: "far-food", name: "Far food", description: "Three pieces of food somewhere in a bigger room. Search.", size: [400, 400], food: 3, poison: 0, seconds: 30, tags: ["search"] }),
  small({ id: "patch", name: "Patch", description: "All the food lies in one patch across the room. Find it, then clear it.", size: [450, 450], food: 10, poison: 4, seconds: 30, layout: { kind: "patch", radius: 70 }, tags: ["search"] }),
  // Avoiding poison and finding a way round
  small({ id: "minefield", name: "Minefield", description: "Four food hidden among twelve poison. One wrong bite ends it.", size: [300, 300], food: 4, poison: 12, seconds: 25, tags: ["caution"] }),
  small({ id: "fence", name: "Fence", description: "A wall of stinging poison with one gap. The food is on the other side.", size: [400, 400], food: 5, poison: 0, seconds: 30, layout: { kind: "fence", gap: 110 }, poisonDamage: 25, tags: ["navigate"] }),
  small({ id: "maze", name: "Zigzag", description: "Two walls of stinging poison with gaps at opposite ends. Weave through to the food.", size: [450, 450], food: 4, poison: 0, seconds: 40, layout: { kind: "maze", gap: 60 }, poisonDamage: 25, tags: ["navigate"] }),
  // Energy
  small({
    id: "lean-times",
    name: "Lean times",
    description: "Little energy, slow-growing food. Do not waste effort; end the minute alive with energy to spare.",
    size: [400, 400],
    food: 5,
    poison: 3,
    foodRegrow: 0.2,
    seconds: 60,
    learnerEnergy: 30,
    reward: { survive: 0.05, food: 0.3, energy: 2 },
    tags: ["energy"],
  }),
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
    tags: ["compete", "fight", "self-play"],
  }),
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
    tags: ["forager", "search", "advanced"],
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
    tags: ["forager", "caution", "advanced"],
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
    tags: ["forager", "competition", "advanced"],
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
    tags: ["forager", "thrift", "advanced"],
  },
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
];

export const envById = (id: string): EnvSpec | undefined => ENVS.find((e) => e.id === id);

// Categories for choosing envs, in display order; groupOf files an env under one by its tags.
export const ENV_GROUPS = ["Find food", "Avoid and find a way", "Energy", "Fight", "Compete", "Advanced", "Custom"] as const;
export type EnvGroup = (typeof ENV_GROUPS)[number];

export function groupOf(env: Pick<EnvSpec, "tags">): EnvGroup {
  const t = new Set(env.tags);
  if (t.has("custom")) return "Custom";
  if (t.has("advanced")) return "Advanced";
  if (t.has("compete")) return "Compete";
  if (t.has("fight")) return "Fight";
  if (t.has("energy")) return "Energy";
  if (t.has("caution") || t.has("navigate")) return "Avoid and find a way";
  return "Find food";
}
