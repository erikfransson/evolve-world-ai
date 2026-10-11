import { layerSizes, randomGenome } from "../brain.ts";
import { itemsPerDensity } from "../config.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../ecoConfig.ts";
import type { EcoConfig } from "../ecoConfig.ts";
import { Ecosystem } from "../ecosystem.ts";
import type { CastMember } from "../ecosystem.ts";
import { randomPlan } from "../planMutation.ts";
import { createRng, deriveSeed } from "../rng.ts";
import { trialsToEcoGenome } from "../seedPool.ts";
import type { PoolEntry } from "../seedPool.ts";
import { energySignal, planOf } from "../sensors.ts";
import type { BodyPlan, PlanView } from "../sensors.ts";
import { speciesList, speciesRanges } from "../species.ts";
import type { Genome } from "../types.ts";

// RL environments (#27): short episodes on the Ecosystem engine, so a creature trained here acts exactly as it would in the
// Ecosystem or The Great Hunt. An environment is plain data: a small world, the learner's species, rivals, and reward weights.

export type EnvWorld = "ecosystem" | "hunt"; // the input layout: one species, or prey (0) and predators (1)
export const PREY = 0;
export const PREDATOR = 1;

// Who the other creatures are: random genomes, seed-pool founders, or trained creatures from the library (by env id).
export type RivalSource = "random" | "pool" | `library:${string}`;

export interface Rivals {
  species: number;
  count: number;
  source: RivalSource;
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
  reward: { food?: number; kill?: number; survive?: number; energy?: number }; // per item, per kill, per second alive, x energy signal at the end
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
  seconds: number; // alive
  energy: number; // at the end, or when it died
}

const BIRTHLESS = 1e9; // birth energy no creature reaches

// The engine config of an env: its world on the base of the Ecosystem or The Great Hunt, no births, no structural change.
export function envConfig(env: EnvSpec, seed: number): EcoConfig {
  const base = structuredClone(env.world === "hunt" ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG);
  const [width, height] = env.size;
  base.seed = seed;
  base.world = { ...base.world, width, height };
  const per = itemsPerDensity(base);
  base.world.foodDensity = env.food / per;
  base.world.poisonDensity = env.poison / per;
  const total = env.rivals.reduce((a, r) => a + r.count, 1);
  base.eco = {
    ...base.eco,
    wasm: false, // small worlds, and the same numbers in Node and every browser
    maxPopulation: total,
    foodRegrow: env.foodRegrow / per,
    foodMaxDensity: env.food / per,
    poisonRegrow: 0,
    poisonMaxDensity: env.poison / per,
    birthEnergy: BIRTHLESS,
    planDrift: 0,
    structuralRate: 0,
  };
  if (base.species) base.species = base.species.map((sp) => ({ ...sp, birthEnergy: BIRTHLESS }));
  return base;
}

// The pool founder's genome in the env world's layout.
export function poolLearner(env: Pick<EnvSpec, "world">, entry: PoolEntry): Learner {
  return { plan: entry.plan, genome: trialsToEcoGenome(entry.plan, entry.genome, envConfig({ ...BLANK, world: env.world }, 1)) };
}

// A random plan within the species' ranges and a random genome for it.
export function randomLearner(env: Pick<EnvSpec, "world" | "role">, seed: number): Learner {
  const config = envConfig({ ...BLANK, world: env.world }, seed);
  const rng = createRng(deriveSeed(seed, 0x1ea7));
  const plan: BodyPlan = planOf(config);
  randomPlan(speciesRanges(config, speciesList(config)[env.role]!), rng, plan);
  return { plan, genome: randomGenome(layerSizes(config, plan), rng) };
}

const BLANK: EnvSpec = { id: "", name: "", description: "", world: "ecosystem", role: 0, size: [400, 400], food: 0, poison: 0, foodRegrow: 0, seconds: 1, rivals: [], reward: {}, tags: [] };

// The learner (founder id 0) and the rivals of one episode, placed at random from the seed.
export function castFor(env: EnvSpec, config: EcoConfig, learner: Learner, seed: number, pool: readonly PoolEntry[] | null, library: Library): CastMember[] {
  const rng = createRng(deriveSeed(seed, 0xca57));
  const r = config.creature.radius;
  const [w, h] = env.size;
  const species = speciesList(config);
  const place = (sp: number, plan: PlanView, genome: Genome, hue: number): CastMember => ({ species: sp, plan, genome, x: rng.range(r, w - r), y: rng.range(r, h - r), heading: rng.next() * 2 * Math.PI, hue });
  const cast = [place(env.role, learner.plan, learner.genome, 48)];
  for (const rv of env.rivals) {
    const hue = species[rv.species]!.hue < 0 ? 205 : species[rv.species]!.hue;
    for (let k = 0; k < rv.count; k++) {
      let rival: Learner;
      if (rv.source === "pool" && pool?.length) rival = poolLearner(env, pool[rng.int(pool.length)]!);
      else if (rv.source.startsWith("library:") && library[rv.source.slice(8)]?.length) {
        const list = library[rv.source.slice(8)]!;
        rival = list[rng.int(list.length)]!;
      } else rival = randomLearner({ world: env.world, role: rv.species }, rng.int(2 ** 31));
      cast.push(place(rv.species, rival.plan, rival.genome, hue));
    }
  }
  return cast;
}

// Plays one episode and scores the learner. onTick, when given, sees the world after every tick (the Arena draws it).
export function runEpisode(
  env: EnvSpec,
  learner: Learner,
  seed: number,
  pool: readonly PoolEntry[] | null = null,
  library: Library = {},
  onTick?: (eco: Ecosystem) => void,
): EpisodeResult {
  const config = envConfig(env, seed);
  const eco = new Ecosystem(config, null, { cast: castFor(env, config, learner, seed, pool, library) });
  const ticks = Math.round(env.seconds / config.dt);
  const out: EpisodeResult = { reward: 0, food: 0, kills: 0, seconds: 0, energy: 0 };
  for (let t = 0; t < ticks; t++) {
    eco.step();
    onTick?.(eco);
    const me = eco.get(0);
    if (!me) break;
    out.food = me.eaten;
    out.kills = me.kills;
    out.energy = me.creature.state.energy;
    out.seconds = (t + 1) * config.dt;
  }
  const w = env.reward;
  const startEnergy = speciesList(config)[env.role]!.startEnergy;
  out.reward = (w.food ?? 0) * out.food + (w.kill ?? 0) * out.kills + (w.survive ?? 0) * out.seconds + (w.energy ?? 0) * energySignal(out.energy, startEnergy);
  return out;
}

// Mean result over several seeds (layouts, positions and rivals all change with the seed).
export function scoreLearner(env: EnvSpec, learner: Learner, seeds: readonly number[], pool: readonly PoolEntry[] | null = null, library: Library = {}): EpisodeResult {
  const sum: EpisodeResult = { reward: 0, food: 0, kills: 0, seconds: 0, energy: 0 };
  for (const s of seeds) {
    const r = runEpisode(env, learner, s, pool, library);
    for (const k of Object.keys(sum) as (keyof EpisodeResult)[]) sum[k] += r[k] / seeds.length;
  }
  return sum;
}
