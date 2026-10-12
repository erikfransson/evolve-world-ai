import { genomeLength, layerSizes, randomGenome } from "../brain.ts";
import { itemsPerDensity } from "../config.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../ecoConfig.ts";
import type { EcoConfig } from "../ecoConfig.ts";
import { Ecosystem } from "../ecosystem.ts";
import type { CastMember } from "../ecosystem.ts";
import type { Creature } from "../creature.ts";
import { SenseKernels } from "../wasm/senseKernels.ts";
import { randomPlan } from "../planMutation.ts";
import { createRng, deriveSeed } from "../rng.ts";
import { trialsToEcoGenome } from "../seedPool.ts";
import type { PoolEntry } from "../seedPool.ts";
import { energySignal, planOf } from "../sensors.ts";
import type { BodyPlan, PlanView } from "../sensors.ts";
import { speciesList, speciesRanges } from "../species.ts";
import type { Species } from "../species.ts";
import type { Genome } from "../types.ts";
import { plainText } from "./validate.ts";
import { envById } from "./envs.ts";
import { LAYOUT_KINDS, placeLayout } from "./layouts.ts";
import type { Layout } from "./layouts.ts";

// RL environments (#27): short episodes on the Ecosystem engine, so a creature trained here acts exactly as it would in the
// Ecosystem or The Great Hunt. An environment is plain data: a small world, the learner's species, rivals, and reward weights.

export type EnvWorld = "ecosystem" | "hunt"; // the input layout: one species, or prey (0) and predators (1)
export { PREDATOR, PREY } from "./envs.ts";

// Who the other creatures are: random genomes, seed-pool founders, or trained creatures from the library (by env id).
// "self": copies of the learner's own current weights and its recent best candidates (self-play; the trainer keeps the
// list in the library under SELF), so it always meets rivals of its own level.
export type RivalSource = "random" | "pool" | "self" | `library:${string}`;
export const SELF = "self";

export interface Rivals {
  species: number;
  count: number;
  source: RivalSource;
  energy?: number; // start energy, the species' when left out
}

export interface EnvSpec {
  id: string; // stable; results and library entries refer to it
  name: string;
  description: string; // one line, what the learner has to do
  world: EnvWorld;
  role: number; // the learner's species
  size: [number, number]; // world width and height
  food: number; // items at the start
  poison: number;
  foodRegrow: number; // items per second, up to food
  seconds: number; // episode length; it ends early when the learner dies
  rivals: Rivals[];
  layout?: Layout; // items placed by a pattern (walls, patches) instead of scattered
  collisionDamage?: boolean; // bumps cost energy and a creature killed by one gives its energy to the other
  learnerEnergy?: number; // the learner's start energy, the species' when left out
  poisonDamage?: number; // energy one poison item drains; lethal when left out (POISON_LETHAL)
  foodVisibleFor?: number; // seconds: after this, rays pass through food (it stays edible), so finding it takes memory
  // Per item, per kill, per second alive, x energy signal at the end, and per second left when the learner has eaten all the
  // starting food itself (without regrowth the episode then ends early, the learner counting as alive to the end).
  // ram: per rival that dies touching the learner while collision damage is on.
  // cross: per poison wall of the layout the learner got past (at any moment), a first reward on the way to food beyond it.
  reward: { food?: number; kill?: number; survive?: number; energy?: number; fast?: number; ram?: number; cross?: number };
  tags: string[];
}

// A creature that trains: its plan and its genome in the input layout of the env's world.
export interface Learner {
  plan: PlanView;
  genome: Genome;
}

// Trained creatures by env id, rivals for later envs (the league).
export type Library = Record<string, Learner[]>;

export interface EpisodeResult {
  reward: number;
  food: number;
  kills: number;
  rams: number; // rivals killed by bumping into the learner
  seconds: number; // alive
  energy: number; // at the end, or when it died
}

const BIRTHLESS = 1e9; // birth energy no creature reaches

// WebAssembly kernels for an episode's sense and brain phase (false keeps the JS path). With compiled modules cached they are
// faster for every brain size. Their f32 arithmetic differs slightly from the JS path, but each creature's result depends only
// on its own inputs, so rewards stay deterministic per seed whatever the thread count or episode order.
export const RL_WASM = true;
const useWasm = (env: EnvSpec): boolean => RL_WASM && env.foodVisibleFor === undefined; // hidden food needs the JS sense path

// The engine config of an env: its world on the base of the Ecosystem or The Great Hunt, no births, no structural change.
export function envConfig(env: EnvSpec, seed: number): EcoConfig {
  const base = structuredClone(env.world === "hunt" ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG);
  const [width, height] = env.size;
  base.seed = seed;
  base.world = { ...base.world, width, height, ...(env.poisonDamage === undefined ? {} : { poisonDamage: env.poisonDamage }) };
  const per = itemsPerDensity(base);
  base.world.foodDensity = env.food / per;
  base.world.poisonDensity = env.poison / per;
  const total = env.rivals.reduce((a, r) => a + r.count, 1);
  base.eco = {
    ...base.eco,
    wasm: useWasm(env), // f32 kernels give the same numbers in Node and every browser
    maxPopulation: total,
    foodRegrow: env.foodRegrow / per,
    foodMaxDensity: env.food / per,
    poisonRegrow: 0,
    poisonMaxDensity: env.poison / per,
    collisionDamage: env.collisionDamage ?? false,
    birthEnergyRange: [BIRTHLESS, BIRTHLESS],
    birthDrift: 0,
    planDrift: 0,
    structuralRate: 0,
  };
  if (base.species) base.species = base.species.map((sp) => ({ ...sp, birthEnergyRange: [BIRTHLESS, BIRTHLESS] }));
  return base;
}

// The episode config of an env, built once and reused with the seed swapped (the engine only reads it); the key guards an env edited in place.
const configs = new WeakMap<EnvSpec, { key: string; config: EcoConfig }>();
function episodeConfig(env: EnvSpec, seed: number): EcoConfig {
  const key = `${env.world} ${env.size[0]} ${env.size[1]} ${env.food} ${env.poison} ${env.foodRegrow} ${env.collisionDamage} ${env.poisonDamage} ${env.rivals.reduce((a, r) => a + r.count, 1)} ${env.foodVisibleFor}`; // foodVisibleFor sets eco.wasm
  let c = configs.get(env);
  if (c?.key !== key) configs.set(env, (c = { key, config: envConfig(env, 0) }));
  return { ...c.config, seed };
}

const converted: Record<EnvWorld, WeakMap<PoolEntry, Learner>> = { ecosystem: new WeakMap(), hunt: new WeakMap() };
const layouts: Partial<Record<EnvWorld, EcoConfig>> = {}; // per world, for plans and genome layouts only; the seed does not matter, so treat as read only

// The config that fixes a world's input layout, for plan and genome sizes only.
export function layoutConfig(world: EnvWorld): EcoConfig {
  return (layouts[world] ??= envConfig({ ...BLANK_ENV, world }, 1));
}

// The genome length a creature of this plan needs in the world's input layout.
export const genomeLengthIn = (world: EnvWorld, plan: PlanView): number => genomeLength(layerSizes(layoutConfig(world), plan));

// True when creatures trained in env `id` fit a rival slot of this species in this world (same input layout and species).
export const libraryFits = (id: string, world: EnvWorld, species: number): boolean => {
  const from = envById(id);
  return from !== undefined && from.world === world && from.role === species;
};

// The pool founder's genome in the env world's layout; converted once per entry and world, so treat the result as read only.
export function poolLearner(env: Pick<EnvSpec, "world">, entry: PoolEntry): Learner {
  let l = converted[env.world].get(entry);
  if (!l) converted[env.world].set(entry, (l = { plan: entry.plan, genome: trialsToEcoGenome(entry.plan, entry.genome, layoutConfig(env.world)) }));
  return l;
}

// A random plan within the species' ranges and a random genome for it.
export function randomLearner(env: Pick<EnvSpec, "world" | "role">, seed: number): Learner {
  const config = layoutConfig(env.world);
  const rng = createRng(deriveSeed(seed, 0x1ea7));
  const plan: BodyPlan = planOf(config);
  randomPlan(speciesRanges(config, speciesList(config)[env.role]!), rng, plan);
  return { plan, genome: randomGenome(layerSizes(config, plan), rng) };
}

export const BLANK_ENV: EnvSpec = { id: "", name: "", description: "", world: "ecosystem", role: 0, size: [400, 400], food: 0, poison: 0, foodRegrow: 0, seconds: 1, rivals: [], reward: {}, tags: [] };

// Random rivals depend only on the env, the episode seed and their own seed, and a candidate is scored on the same seeds
// every time, so their learners are kept for the last few episodes. Brains copy genomes and creatures copy plans, so
// the cached learners are never changed.
const RIVAL_CACHE_SIZE = 64;
const rivalCache: { env: EnvSpec; seed: number; learners: Map<number, Learner> }[] = [];

function randomRival(env: EnvSpec, seed: number, role: number, rivalSeed: number): Learner {
  let entry = rivalCache.find((e) => e.env === env && e.seed === seed);
  if (entry) rivalCache.splice(rivalCache.indexOf(entry), 1);
  else {
    entry = { env, seed, learners: new Map() };
    if (rivalCache.length >= RIVAL_CACHE_SIZE) rivalCache.shift();
  }
  rivalCache.push(entry);
  const key = role * 2 ** 31 + rivalSeed;
  let l = entry.learners.get(key);
  if (!l) entry.learners.set(key, (l = randomLearner({ world: env.world, role }, rivalSeed)));
  return l;
}

// The learner (founder id 0) and the rivals of one episode, placed at random from the seed.
export function castFor(env: EnvSpec, config: EcoConfig, learner: Learner, seed: number, pool: readonly PoolEntry[] | null, library: Library, start?: { x: number; y: number; heading?: number }): CastMember[] {
  const rng = createRng(deriveSeed(seed, 0xca57));
  const r = config.creature.radius;
  const [w, h] = env.size;
  const species = speciesList(config);
  const place = (sp: number, plan: PlanView, genome: Genome, hue: number): CastMember => ({ species: sp, plan, genome, x: rng.range(r, w - r), y: rng.range(r, h - r), heading: rng.next() * 2 * Math.PI, hue });
  const me = place(env.role, learner.plan, learner.genome, 48);
  if (start) {
    me.x = start.x;
    me.y = start.y;
    if (start.heading !== undefined) me.heading = start.heading;
  }
  if (env.learnerEnergy !== undefined) me.energy = env.learnerEnergy;
  const cast = [me];
  for (const rv of env.rivals) {
    const hue = species[rv.species]!.hue < 0 ? 205 : species[rv.species]!.hue;
    for (let k = 0; k < rv.count; k++) {
      let rival: Learner;
      const listId = rv.source === "self" ? (rv.species === env.role ? SELF : null) : rv.source.startsWith("library:") && libraryFits(rv.source.slice(8), env.world, rv.species) ? rv.source.slice(8) : null;
      if (rv.source === "pool" && pool?.length) rival = poolLearner(env, pool[rng.int(pool.length)]!);
      else if (listId !== null && Object.hasOwn(library, listId) && library[listId]!.length) {
        const list = library[listId]!;
        rival = list[rng.int(list.length)]!;
      } else if (rv.source === "self" && rv.species === env.role) rival = learner; // no league yet: a mirror of the learner
      else rival = randomRival(env, seed, rv.species, rng.int(2 ** 31));
      const m = place(rv.species, rival.plan, rival.genome, hue);
      if (start) m.y = Math.min(h - r, Math.max(r, start.y + rng.range(-20, 20))); // with a layout, rivals start at the learner's height, off the walls
      if (rv.energy !== undefined) m.energy = rv.energy;
      cast.push(m);
    }
  }
  return cast;
}

// Walls whose far side the learner reached: its centre a full body above the wall line.
const crossed = (walls: readonly number[], minY: number, radius: number): number => walls.filter((y) => minY < y - radius).length;

const learnerStartEnergy = (env: EnvSpec, species: readonly Species[]): number => env.learnerEnergy ?? species[env.role]!.startEnergy;

// One kernel set per thread, reused by successive episodes (building one costs about 9% of a small episode).
let spareKernels: SenseKernels | null = null;
export const dropSpareKernels = (): void => { spareKernels = null; }; // the next episode builds fresh ones (tests)

// Plays one episode and scores the learner. onTick, when given, sees the world after every tick (the Arena draws it).
// act, when given, may overwrite the learner's outputs after its brain ran and before it moves (a stochastic policy, rlGrad).
export function runEpisode(
  env: EnvSpec,
  learner: Learner,
  seed: number,
  pool: readonly PoolEntry[] | null = null,
  library: Library = {},
  onTick?: (eco: Ecosystem) => void,
  act?: (learner: Creature) => void,
): EpisodeResult {
  const config = episodeConfig(env, seed);
  const placed = env.layout ? placeLayout(env.layout, env.size, env.food, env.poison, seed) : null;
  const cast = castFor(env, config, learner, seed, pool, library, placed?.start);
  const kernels = config.eco.wasm ? (spareKernels ?? SenseKernels.create(config)) : null;
  spareKernels = null; // taken, so an episode started inside this one's onTick builds its own
  const eco = new Ecosystem(config, null, { cast, items: placed?.items, kernels: kernels ?? undefined });
  // With the WASM kernels only the detail creature gets its rays and brain input copied back; recordings and backprop RL read the learner's.
  if (onTick || act) eco.detail = 0;
  const reach = 2 * config.creature.radius + 2; // bumping distance, for crediting a ram
  const ticks = Math.round(env.seconds / config.dt);
  const out: EpisodeResult = { reward: 0, food: 0, kills: 0, rams: 0, seconds: 0, energy: 0 };
  // The learner's last tick counts too: what it ate before it died; a dead learner ends with no energy.
  eco.onDeath = (m) => {
    if (m.id !== 0) {
      // A rival dying in contact with the living learner in a collision-damage world was rammed by it.
      const me = eco.get(0)?.creature.state;
      const s = m.creature.state;
      // It must also hand the learner its energy this tick, so a rival starving next to it does not count.
      if (env.collisionDamage && me?.alive && me.energy > lastEnergy && (me.x - s.x) ** 2 + (me.y - s.y) ** 2 <= reach * reach) out.rams++;
      return;
    }
    out.food = m.eaten;
    out.kills = m.kills;
    out.energy = 0;
  };
  let cleared = 0; // seconds left when the learner ate the last food
  let lastEnergy = learnerStartEnergy(env, eco.species); // the learner's energy after the previous tick
  let minY = Infinity; // the learner's highest point (walls run across, the food lies above them)
  // Only speed-scored envs without regrowth end early, and only when the learner itself ate every item (not a rival).
  const clearable = env.reward.fast !== undefined && env.food > 0 && env.foodRegrow === 0;
  const hideAt = env.foodVisibleFor === undefined ? Infinity : Math.round(env.foodVisibleFor / config.dt);
  for (let t = 0; t < ticks; t++) {
    if (t === hideAt) eco.setFoodHidden(true);
    if (act) {
      eco.prepareTick();
      eco.sensePhase(0, eco.members.length);
      act(eco.get(0)!.creature);
      eco.finishTick();
    } else eco.step();
    onTick?.(eco);
    const me = eco.get(0);
    if (!me) break;
    out.food = me.eaten;
    out.kills = me.kills;
    out.energy = lastEnergy = me.creature.state.energy;
    minY = Math.min(minY, me.creature.state.y);
    out.seconds = (t + 1) * config.dt;
    if (clearable && me.eaten === env.food) {
      cleared = env.seconds - out.seconds;
      out.seconds = env.seconds;
      break;
    }
  }
  const w = env.reward;
  const startEnergy = eco.species[env.role]!.startEnergy;
  out.reward = (w.food ?? 0) * out.food + (w.kill ?? 0) * out.kills + (w.survive ?? 0) * out.seconds + (w.energy ?? 0) * energySignal(out.energy, startEnergy) + (w.fast ?? 0) * cleared + (w.ram ?? 0) * out.rams + (w.cross ?? 0) * crossed(placed?.walls ?? [], minY, config.creature.radius);
  if (kernels) spareKernels = kernels; // an episode that throws just drops them
  return out;
}

// Mean result over several seeds (layouts, positions and rivals all change with the seed).
export function scoreLearner(env: EnvSpec, learner: Learner, seeds: readonly number[], pool: readonly PoolEntry[] | null = null, library: Library = {}): EpisodeResult {
  const sum: EpisodeResult = { reward: 0, food: 0, kills: 0, rams: 0, seconds: 0, energy: 0 };
  for (const s of seeds) {
    const r = runEpisode(env, learner, s, pool, library);
    for (const k of Object.keys(sum) as (keyof EpisodeResult)[]) sum[k] += r[k] / seeds.length;
  }
  return sum;
}

// Bounds a custom env must keep, so a page or a shared file cannot ask for a world that stalls the browser.
const MAX_RIVAL_GROUPS = 8;
export const ENV_LIMITS = { side: [200, 3000], items: [0, 300], regrow: [0, 10], seconds: [5, 180], rivals: [0, 30], weight: [-10, 10], energy: [1, 500], layoutSize: [20, 400], poisonDamage: [1, 100] } as const;

// A custom env rebuilt from checked fields, for the learner's world and species, or a reason it is not valid.
export function checkEnv(e: unknown, world: EnvWorld, role: number): EnvSpec | string {
  if (typeof e !== "object" || e === null) return "env missing";
  const v = e as Record<string, unknown>;
  const L = ENV_LIMITS;
  const n = (x: unknown, [lo, hi]: readonly [number, number]): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
  const size = v.size as unknown[];
  if (!Array.isArray(size) || size.length !== 2 || !size.every((s) => n(s, L.side))) return `world sides must be ${L.side[0]} to ${L.side[1]}`;
  if (!n(v.food, L.items) || !n(v.poison, L.items)) return `food and poison must be ${L.items[0]} to ${L.items[1]}`;
  if (!n(v.foodRegrow, L.regrow)) return `regrowth must be ${L.regrow[0]} to ${L.regrow[1]} per second`;
  if (!n(v.seconds, L.seconds)) return `episodes must last ${L.seconds[0]} to ${L.seconds[1]} s`;
  const species = world === "hunt" ? 2 : 1;
  const rivals: Rivals[] = [];
  if (Array.isArray(v.rivals) && v.rivals.length > MAX_RIVAL_GROUPS) return `at most ${MAX_RIVAL_GROUPS} rival groups`;
  for (const r of Array.isArray(v.rivals) ? v.rivals : []) {
    const rv = r as Record<string, unknown>;
    const src = rv.source;
    if (!Number.isInteger(rv.species) || (rv.species as number) < 0 || (rv.species as number) >= species) return "rival species does not exist in this world";
    if (!Number.isInteger(rv.count) || (rv.count as number) < 0) return "rival count must be a whole number";
    if (src !== "random" && src !== "pool" && src !== "self" && !(typeof src === "string" && /^library:[a-z0-9-]{1,40}$/.test(src))) return "rival source must be random, pool, self or library:<env id>";
    if (typeof src === "string" && src.startsWith("library:") && !libraryFits(src.slice(8), world, rv.species as number)) return "library rivals must come from an env of this world whose learner is of the rival's species";
    if (src === "self" && rv.species !== role) return "self rivals must be of the learner's species";
    if (rv.energy !== undefined && !n(rv.energy, L.energy)) return `rival energy must be ${L.energy[0]} to ${L.energy[1]}`;
    rivals.push({ species: rv.species as number, count: rv.count as number, source: src as RivalSource, ...(rv.energy === undefined ? {} : { energy: rv.energy as number }) });
  }
  if (rivals.reduce((a, r) => a + r.count, 0) > L.rivals[1]) return `at most ${L.rivals[1]} rivals`;
  const w = (v.reward ?? {}) as Record<string, unknown>;
  const reward: EnvSpec["reward"] = {};
  for (const k of ["food", "kill", "survive", "energy", "fast", "ram", "cross"] as const) {
    if (w[k] === undefined) continue;
    if (!n(w[k], L.weight)) return `reward ${k} must be ${L.weight[0]} to ${L.weight[1]}`;
    reward[k] = w[k] as number;
  }
  if (v.learnerEnergy !== undefined && !n(v.learnerEnergy, L.energy)) return `start energy must be ${L.energy[0]} to ${L.energy[1]}`;
  if (v.poisonDamage !== undefined && !n(v.poisonDamage, L.poisonDamage)) return `poison damage must be ${L.poisonDamage[0]} to ${L.poisonDamage[1]}`;
  if (v.foodVisibleFor !== undefined && !n(v.foodVisibleFor, [0, 60])) return "food may stay visible 0 to 60 s";
  let layout: Layout | undefined;
  if (v.layout !== undefined) {
    const l = v.layout as Record<string, unknown> | null;
    if (!l || !(LAYOUT_KINDS as readonly unknown[]).includes(l.kind)) return `layout must be one of ${LAYOUT_KINDS.join(", ")}`;
    const [sw, sh] = size as number[];
    const fixed = l.kind === "sprint" || l.kind === "cuedoor" || l.kind === "flash"; // no size parameter
    const round = l.kind === "patch" || l.kind === "islands"; // sized by a radius; ring by its lane; the walled ones by a gap
    const param = round ? l.radius : l.kind === "ring" ? l.lane : l.gap;
    // A patch must fit and three islands must fit apart; wall gaps leave wall on both sides of a door.
    const most = l.kind === "patch" ? Math.min(sw!, sh!) / 2 - 20 : l.kind === "islands" ? Math.min(sw!, sh!) / 6 - 10 : l.kind === "rooms" ? Math.min(sw!, sh!) / 4 - 20 : l.kind === "ring" ? Math.min(sw!, sh!) / 4 : sw! / 4;
    if (!fixed && !n(param, [L.layoutSize[0], Math.min(L.layoutSize[1], most)])) return `layout ${round ? "radius" : l.kind === "ring" ? "lane" : "gap"} must be ${L.layoutSize[0]} to ${Math.floor(Math.min(L.layoutSize[1], most))} for this world size`;
    if (l.kind !== "patch" && l.kind !== "islands" && l.kind !== "sprint" && rivals.some((r) => r.count > 0)) return "this layout does not take rivals yet";
    if (l.near !== undefined && !(Number.isInteger(l.near) && (l.near as number) >= 0 && (l.near as number) <= (v.food as number))) return "near food must be a whole number up to the food count";
    const nearOf = l.near === undefined ? {} : { near: l.near as number };
    layout =
      l.kind === "sprint" ? { kind: "sprint", ...nearOf }
      : l.kind === "cuedoor" || l.kind === "flash" ? { kind: l.kind }
      : l.kind === "patch" || l.kind === "islands" ? { kind: l.kind, radius: param as number }
      : l.kind === "rooms" ? { kind: "rooms", gap: param as number, ...nearOf }
      : l.kind === "ring" ? { kind: "ring", lane: param as number }
      : { kind: l.kind as "fence" | "maze", gap: param as number, ...nearOf };
  }
  return {
    id: `custom-${plainText(v.id, 40).toLowerCase().replace(/^custom-/, "").replace(/[^a-z0-9-]/g, "-") || "env"}`, // never a built-in id
    name: plainText(v.name, 40) || "Custom",
    description: plainText(v.description, 160) || "A custom training world.",
    world,
    role,
    size: [size[0] as number, size[1] as number],
    food: Math.round(v.food),
    poison: Math.round(v.poison),
    foodRegrow: v.foodRegrow,
    seconds: v.seconds,
    rivals,
    ...(layout ? { layout } : {}),
    ...(v.collisionDamage === true ? { collisionDamage: true } : {}),
    ...(v.learnerEnergy === undefined ? {} : { learnerEnergy: v.learnerEnergy as number }),
    ...(v.poisonDamage === undefined ? {} : { poisonDamage: v.poisonDamage as number }),
    ...(v.foodVisibleFor === undefined ? {} : { foodVisibleFor: v.foodVisibleFor as number }),
    reward,
    tags: ["custom"],
  };
}
