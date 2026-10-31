import { SELF, BLANK_ENV, envConfig } from "./env.ts";
import type { EnvSpec, EpisodeResult, Learner, Library } from "./env.ts";
import { Ecosystem } from "../ecosystem.ts";
import type { CastMember } from "../ecosystem.ts";
import { SenseKernels } from "../wasm/senseKernels.ts";
import { createRng, deriveSeed } from "../rng.ts";
import { speciesList } from "../species.ts";
import { HIT_POISON } from "../types.ts";
import { placeLayout } from "./layouts.ts";
import type { Layout, Placed } from "./layouts.ts";

// Procedural self-play (S1): every episode is a new small world (size, layout, food, poison, regrowth, sting, length drawn from
// the seed) with a crowd. The learner's genome plays `learners` of the bodies at once; the rest play league snapshots (SELF).
// The score is how long the learner's bodies live and how much of the world's food they get, so it asks for general survival.

export type Range = readonly [number, number];

export interface ProcSpec {
  crowd: Range; // creatures in the world, drawn log-uniformly (rounded)
  learnerShare: number; // share of the crowd that plays the learner's genome (at least 1, and 1 league body whenever the crowd has two)
  area: Range; // world area per creature, log-uniform (Live now: 1200 x 1200 for 21 = 68 000)
  aspect: Range; // short side over long side
  foodPer: Range; // starting food items per creature, log-uniform; the world holds at most this many (Live now: 2.9)
  regrowPer: Range; // food items per second per creature, log-uniform (Live now: 0.03)
  poisonPer: Range; // poison items per creature
  sting: Range; // energy one poison item drains; `lethalShare` of the worlds make it lethal instead
  lethalShare: number;
  seconds: Range; // episode length
  energy: Range; // every body's start energy
  layouts: readonly (Layout["kind"] | "open")[]; // one drawn per world, open scatter with weight `openShare`
  openShare: number;
  foodWeight: number; // reward weight of the food share (see crowdReward)
  lineageWeight: number; // reward weight of the learner's share of the end population (0 leaves it out)
}

export const PROC_DEFAULTS: ProcSpec = {
  crowd: [5, 50],
  learnerShare: 0.5,
  area: [40_000, 120_000],
  aspect: [0.6, 1],
  foodPer: [1.5, 4.5],
  regrowPer: [0.01, 0.06],
  poisonPer: [0.1, 1.2],
  sting: [20, 50],
  lethalShare: 0.2,
  seconds: [40, 90],
  energy: [100, 300],
  layouts: ["patch", "islands", "rooms", "fence"],
  openShare: 0.5,
  foodWeight: 3, // 0.25 learned nothing in 300 s (standing still lives long); 3 beat the fixed recipe on Live-like survival, see t10-s1-selfplay.md
  lineageWeight: 0,
};

export const KILL_ENERGY = 5; // as Live now: a lethal bump pays the survivor this on top of the dead one's energy
const SIDE: Range = [200, 3000];

// One drawn world: plain data, a function of the spec and the seed only.
export interface ProcWorld {
  size: [number, number];
  crowd: number;
  learners: number;
  food: number;
  poison: number;
  regrow: number; // items per second, whole world
  poisonDamage: number | undefined; // undefined: lethal
  seconds: number;
  energy: number;
  layout: Layout | undefined;
  supply: number; // food items per creature over the episode: (start food + regrowth) / crowd
}

const logUniform = (rng: { next(): number }, [lo, hi]: Range): number => lo * (hi / lo) ** rng.next();
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function drawWorld(spec: ProcSpec, seed: number): ProcWorld {
  const rng = createRng(deriveSeed(seed, 0x9c0d));
  const crowd = clamp(Math.round(logUniform(rng, spec.crowd)), 1, 10_000);
  const learners = crowd < 2 ? 1 : clamp(Math.round(crowd * spec.learnerShare), 1, crowd - 1);
  const area = crowd * logUniform(rng, spec.area);
  const aspect = rng.range(spec.aspect[0], spec.aspect[1]);
  const long = Math.sqrt(area / aspect);
  const flip = rng.next() < 0.5;
  const sides = [clamp(long, SIDE[0], SIDE[1]), clamp(area / long, SIDE[0], SIDE[1])] as [number, number];
  const size: [number, number] = flip ? [Math.round(sides[1]), Math.round(sides[0])] : [Math.round(sides[0]), Math.round(sides[1])];
  const food = Math.max(1, Math.round(crowd * logUniform(rng, spec.foodPer)));
  const regrow = crowd * logUniform(rng, spec.regrowPer);
  const poison = Math.round(crowd * rng.range(spec.poisonPer[0], spec.poisonPer[1]));
  const poisonDamage = rng.next() < spec.lethalShare ? undefined : Math.round(rng.range(spec.sting[0], spec.sting[1]));
  const seconds = Math.round(rng.range(spec.seconds[0], spec.seconds[1]));
  const energy = Math.round(rng.range(spec.energy[0], spec.energy[1]));
  const pick = rng.next();
  const [w, h] = size;
  const m = Math.min(w, h);
  let layout: Layout | undefined;
  if (spec.layouts.length && pick >= spec.openShare) {
    const kind = spec.layouts[Math.min(spec.layouts.length - 1, Math.floor(((pick - spec.openShare) / (1 - spec.openShare)) * spec.layouts.length))]!;
    const frac = rng.next();
    if (kind === "patch") layout = { kind, radius: Math.round(clamp(m * (0.15 + 0.15 * frac), 20, m / 2 - 20)) };
    else if (kind === "islands") layout = { kind, radius: Math.round(clamp(m * (0.08 + 0.06 * frac), 20, m / 6 - 10)) };
    else if (kind === "rooms") layout = { kind, gap: Math.round(clamp(60 + 50 * frac, 20, m / 4 - 20)) };
    else if (kind === "fence" || kind === "maze") layout = { kind, gap: Math.round(clamp(90 + 40 * frac, 20, w / 4)) };
    else if (kind === "ring") layout = { kind, lane: Math.round(clamp(50 + 30 * frac, 20, m / 4)) };
  }
  return { size, crowd, learners, food, poison, regrow, poisonDamage, seconds, energy, layout, supply: (food + regrow * seconds) / crowd };
}

// The env spec of a drawn world, for the engine config (rivals are placed by runCrowdEpisode, not castFor).
function specOf(w: ProcWorld): EnvSpec {
  return {
    ...BLANK_ENV,
    id: "proc",
    size: w.size,
    food: w.food,
    poison: w.poison,
    foodRegrow: w.regrow,
    seconds: w.seconds,
    collisionDamage: true,
    killEnergy: KILL_ENERGY,
    ...(w.poisonDamage === undefined ? {} : { poisonDamage: w.poisonDamage }),
    rivals: [{ species: 0, count: w.crowd - 1, source: "self" }], // sizes maxPopulation
  };
}

// The reward of one learner body: the share of the episode it lived (1 if it was alive at the end) plus foodWeight times the bites
// it ate over the food its share of the world offered (supply). A world's score is the mean over the learner's bodies, plus
// lineageWeight times the learner's share of the creatures alive at the end.
export const crowdReward = (life: number, bites: number, supply: number, foodWeight: number): number => life + (foodWeight * bites) / supply;

export interface CrowdStats {
  reward: number;
  learners: number;
  crowd: number;
  life: number; // mean lived share of the learner's bodies
  bites: number; // mean food bites per learner body
  aliveShare: number; // learner bodies alive at the end
  leagueAliveShare: number; // league bodies alive at the end (NaN without any)
  ticks: number; // ticks played
}

const SPOT_TRIES = 12;
const CLEAR = 20; // bodies start at least this far from a poison item of a wall (a body is 12 wide, poison 4)

// Plays one drawn world. The league is library[SELF] (the learner's current weights and recent bests); with none, a mirror of the learner.
export function runCrowdStats(spec: ProcSpec, learner: Learner, seed: number, library: Library = {}): CrowdStats {
  const w = drawWorld(spec, seed);
  const env = specOf(w);
  const config = envConfig(env, seed);
  const placed: Placed | null = w.layout ? placeLayout(w.layout, w.size, w.food, w.poison, seed) : null;
  const rng = createRng(deriveSeed(seed, 0xca58));
  const r = config.creature.radius;
  const [width, height] = w.size;
  const poisons = placed ? placed.items.filter((i) => i.kind === HIT_POISON) : [];
  const league = Object.hasOwn(library, SELF) && library[SELF]!.length ? library[SELF]! : [learner];
  const hue = speciesList(config)[0]!.hue;
  const cast: CastMember[] = [];
  for (let k = 0; k < w.crowd; k++) {
    const who = k < w.learners ? learner : league[rng.int(league.length)]!;
    let x = 0;
    let y = 0;
    for (let t = 0; t < SPOT_TRIES; t++) {
      x = rng.range(r, width - r);
      y = rng.range(r, height - r);
      if (!poisons.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < CLEAR * CLEAR)) break;
    }
    cast.push({ species: 0, plan: who.plan, genome: who.genome, x, y, heading: rng.next() * 2 * Math.PI, hue: k < w.learners ? 48 : hue < 0 ? 205 : hue, energy: w.energy });
  }
  const kernels = config.eco.wasm ? SenseKernels.create(config) : null;
  const eco = new Ecosystem(config, null, { cast, items: placed?.items, kernels: kernels ?? undefined });
  const ticks = Math.round(w.seconds / config.dt);
  const diedAt = new Float64Array(w.learners).fill(ticks);
  const bites = new Float64Array(w.learners);
  let tick = 0;
  let learnersDead = 0;
  eco.onDeath = (m) => {
    if (m.id >= w.learners) return;
    diedAt[m.id] = tick;
    bites[m.id] = m.eaten;
    learnersDead++;
  };
  let played = 0;
  for (let t = 0; t < ticks && learnersDead < w.learners; t++) {
    tick = t + 1;
    eco.step();
    played = tick;
  }
  let aliveL = 0;
  let aliveO = 0;
  for (const m of eco.members) {
    if (m.id < w.learners) {
      bites[m.id] = m.eaten;
      aliveL++;
    } else aliveO++;
  }
  let sum = 0;
  let life = 0;
  let eaten = 0;
  for (let k = 0; k < w.learners; k++) {
    life += diedAt[k]! / ticks / w.learners;
    eaten += bites[k]! / w.learners;
    sum += crowdReward(diedAt[k]! / ticks, bites[k]!, w.supply, spec.foodWeight) / w.learners;
  }
  if (spec.lineageWeight) sum += (spec.lineageWeight * aliveL) / Math.max(1, aliveL + aliveO);
  return { reward: sum, learners: w.learners, crowd: w.crowd, life, bites: eaten, aliveShare: aliveL / w.learners, leagueAliveShare: w.crowd > w.learners ? aliveO / (w.crowd - w.learners) : NaN, ticks: played };
}

export function runCrowdEpisode(spec: ProcSpec, learner: Learner, seed: number, library: Library = {}): EpisodeResult {
  const s = runCrowdStats(spec, learner, seed, library);
  return { reward: s.reward, food: s.bites, kills: 0, rams: 0, seconds: s.life, energy: 0, poison: 0, poisonEnergy: 0, firstFood: -1, elapsed: 0, clearTime: -1, died: 0 };
}

// The training env for rlTrain --selfplay: runEpisode plays it by runCrowdEpisode.
export const procEnv = (spec: ProcSpec): EnvSpec => ({ ...BLANK_ENV, id: "selfplay", name: "Self-play", description: "A new crowded world every episode.", proc: spec, tags: ["selfplay"] });
