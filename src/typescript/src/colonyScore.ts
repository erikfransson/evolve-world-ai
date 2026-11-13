// Colony yardstick: how well a defender founder holds poison-rich home ground when a small foreign colony breeds inside it.
// Score = the defender lineage's share of all living creatures after --minutes of sim time, per seed and as the mean over the seeds.
// Live rules (liveConfig, births on) on a plain world with Blight-like food and poison; defenders start spread over the world, raiders in one cluster.
// Usage: nice -n 19 node src/colonyScore.ts [--defender oracle] [--raider grazer] [--defenders 40] [--raiders 10] [--candidate file.json]
//   [--seeds 101,102,...,108] [--minutes 30] [--every 5] [--warmup 0] [--size 6000] [--food 1.15] [--poison 0.03] [--foodRegrow 0.0046] [--poisonRegrow 0.0009] [--out colony.jsonl] [--founders file]
// --candidate: {plan, genome} (an rlTrain --out file) replacing the defender's plan and genome; its birth traits are kept. The default seeds are held out: never train on them.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveConfig } from "../../../server/src/config.ts";
import { loadFounders } from "../../../server/src/founders.ts";
import type { SeedFounder } from "../../../server/src/founders.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import { Ecosystem } from "./sim/ecosystem.ts";
import type { BodyPlan } from "./sim/sensors.ts";
import { strictArgs } from "./cliArgs.ts";

const NO_MAP = ""; // world.map of a plain world (DEFAULT config)
const RAID_RADIUS = 300, RAID_WALL = 1000; // the raiders' cluster radius and its centre's least distance to the walls

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ColonyParams { size: number; food: number; poison: number; foodRegrow: number; poisonRegrow: number }
export interface Colony { defenders: number; raiders: number; defender: SeedFounder; raider: SeedFounder }
export interface Sample { min: number; defender: number; raider: number; total: number }

// Live's config on a plain size x size world with the given item caps (also the start counts, so the world starts at the caps).
export function colonyConfig(p: ColonyParams, seed: number): EcoConfig {
  const config = structuredClone(liveConfig);
  config.seed = seed;
  config.world.map = NO_MAP;
  config.world.width = p.size;
  config.world.height = p.size;
  config.eco.foodMaxDensity = p.food;
  config.eco.poisonMaxDensity = p.poison;
  config.world.foodDensity = p.food;
  config.world.poisonDensity = p.poison;
  config.eco.foodRegrow = p.foodRegrow;
  config.eco.poisonRegrow = p.poisonRegrow;
  return config;
}

// The defender share of the living: defender / (defender + raider + others); 0 when nobody lives.
export const share = (s: { defender: number; total: number }): number => (s.total ? s.defender / s.total : 0);

type Lineages = Map<number, "defender" | "raider">;

// Inserts `n` copies of f at spots drawn by `spot`, clear of every living creature, and records their founder ids in lineage.
function place(eco: Ecosystem, f: SeedFounder, n: number, who: "defender" | "raider", hue: number, spot: () => { x: number; y: number }, rng: () => number, lineage: Lineages): void {
  const r = eco.config.creature.radius;
  const clear = (x: number, y: number): boolean => eco.members.every((m) => (m.creature.state.x - x) ** 2 + (m.creature.state.y - y) ** 2 > (2.5 * r) ** 2);
  for (let i = 0; i < n; i++) {
    for (let tries = 0; ; tries++) {
      if (tries === 200) throw new Error(`no room to place a ${who}`);
      const { x, y } = spot();
      if (!clear(x, y)) continue;
      const res = eco.insertCreature({ genome: f.genome, plan: f.plan, x, y, heading: rng() * 2 * Math.PI, hue, name: who, ...(f.birth ? { birth: f.birth } : {}) });
      if (!res.ok) continue;
      lineage.set(res.id, who);
      break;
    }
  }
}

// The defenders at uniform random spots over the world.
export function seedDefenders(eco: Ecosystem, c: Colony, rng: () => number, lineage: Lineages): void {
  const { width, height } = eco.config.world;
  const r = eco.config.creature.radius;
  place(eco, c.defender, c.defenders, "defender", 120, () => ({ x: r + rng() * (width - 2 * r), y: r + rng() * (height - 2 * r) }), rng, lineage);
}

// The raiders in one cluster of radius RAID_RADIUS around a random centre at least RAID_WALL from the walls; returns the centre.
export function seedRaiders(eco: Ecosystem, c: Colony, rng: () => number, lineage: Lineages): { x: number; y: number } {
  const { width, height } = eco.config.world;
  const center = { x: RAID_WALL + rng() * (width - 2 * RAID_WALL), y: RAID_WALL + rng() * (height - 2 * RAID_WALL) };
  place(eco, c.raider, c.raiders, "raider", 0, () => {
    const a = rng() * 2 * Math.PI, d = RAID_RADIUS * Math.sqrt(rng());
    return { x: center.x + d * Math.cos(a), y: center.y + d * Math.sin(a) };
  }, rng, lineage);
  return center;
}

export function count(eco: Ecosystem, lineage: Lineages, min: number): Sample {
  let defender = 0, raider = 0;
  for (const m of eco.members) {
    const who = lineage.get(m.founderId);
    if (who === "defender") defender++;
    else if (who === "raider") raider++;
  }
  return { min, defender, raider, total: eco.members.length };
}

// One seed: seed the defenders, run `warmup` minutes alone (0: the raiders start with them), insert the raiders, then run `minutes`
// more of sim time, sampling every `every` minutes (and at the raiders' arrival and the end). Sample minutes count from the raiders' arrival.
export function runSeed(p: ColonyParams, c: Colony, seed: number, minutes: number, every: number, warmup = 0): { seed: number; samples: Sample[]; share: number; extinct: boolean } {
  const config = colonyConfig(p, seed);
  const eco = new Ecosystem(config, null);
  const rng = mulberry32(seed), lineage: Lineages = new Map();
  seedDefenders(eco, c, rng, lineage);
  const minute = (m: number) => Math.round((m * 60) / config.dt);
  while (eco.tick < minute(warmup) && !eco.extinct) eco.step();
  seedRaiders(eco, c, rng, lineage);
  const t0 = eco.tick, end = t0 + minute(minutes), sampleEvery = Math.max(1, minute(every));
  const at = () => +(((eco.tick - t0) * config.dt) / 60).toFixed(2);
  const samples = [count(eco, lineage, 0)];
  while (eco.tick < end && !eco.extinct) {
    eco.step();
    if ((eco.tick - t0) % sampleEvery === 0) samples.push(count(eco, lineage, at()));
  }
  if (samples[samples.length - 1]!.min !== at()) samples.push(count(eco, lineage, at()));
  return { seed, samples, share: share(samples[samples.length - 1]!), extinct: eco.extinct };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = strictArgs({
    options: {
      defender: { type: "string", default: "oracle" },
      raider: { type: "string", default: "grazer" },
      defenders: { type: "string", default: "40" },
      raiders: { type: "string", default: "10" },
      candidate: { type: "string" },
      seeds: { type: "string", default: "101,102,103,104,105,106,107,108" }, // held out
      minutes: { type: "string", default: "30" },
      every: { type: "string", default: "5" },
      warmup: { type: "string", default: "0" }, // minutes the defenders run alone before the raiders arrive
      size: { type: "string", default: "6000" },
      food: { type: "string", default: String(0.5 * 2.3) }, // Live's 0.50 x the Blight's 2.3
      poison: { type: "string", default: String(3 * liveConfig.eco.poisonMaxDensity) }, // 3x Live's 0.01
      foodRegrow: { type: "string", default: String(2.3 * liveConfig.eco.foodRegrow) }, // items per second per density unit; the cap is not what limits a settled world, the regrowth is
      poisonRegrow: { type: "string", default: String(3 * liveConfig.eco.poisonRegrow) },
      out: { type: "string" },
      founders: { type: "string", default: fileURLToPath(new URL("../public/live-founders.json", import.meta.url)) },
    },
  });
  const founders = loadFounders(values.founders!);
  const find = (id: string): SeedFounder => founders.find((f) => f.id === id) ?? ((): never => { throw new Error(`no founder "${id}" in ${values.founders}`); })();
  const defender = find(values.defender!), raider = find(values.raider!);
  if (values.candidate) {
    const cand = JSON.parse(readFileSync(values.candidate, "utf8")) as { plan: BodyPlan; genome: number[] };
    defender.plan = cand.plan;
    defender.genome = Float32Array.from(cand.genome);
  }
  const p: ColonyParams = { size: Number(values.size), food: Number(values.food), poison: Number(values.poison), foodRegrow: Number(values.foodRegrow), poisonRegrow: Number(values.poisonRegrow) };
  const colony: Colony = { defenders: Number(values.defenders), raiders: Number(values.raiders), defender, raider };
  const seeds = values.seeds!.split(",").map(Number);
  const minutes = Number(values.minutes), every = Number(values.every);
  if (values.out) writeFileSync(values.out, "");
  const itemSlots = Math.round((p.food + p.poison) * (p.size * p.size) / 1e4);
  console.log(`defender ${values.candidate ?? defender.id} x${colony.defenders} vs ${raider.id} x${colony.raiders}; ${p.size}x${p.size}, food ${p.food}, poison ${p.poison} (${itemSlots} item slots), regrow ${p.foodRegrow} / ${p.poisonRegrow}, ${minutes} min after ${values.warmup} min warm-up`);
  console.log("seed  defender raider total  share  wall_s");
  const shares: number[] = [];
  const t0 = performance.now();
  for (const seed of seeds) {
    const t = performance.now();
    const r = runSeed(p, colony, seed, minutes, every, Number(values.warmup));
    if (values.out) appendFileSync(values.out, JSON.stringify(r) + "\n");
    const last = r.samples[r.samples.length - 1]!;
    shares.push(r.share);
    console.log(`${String(seed).padEnd(5)} ${String(last.defender).padStart(8)} ${String(last.raider).padStart(6)} ${String(last.total).padStart(5)}  ${r.share.toFixed(3)}  ${((performance.now() - t) / 1000).toFixed(1)}${r.extinct ? " EXTINCT" : ""}`);
  }
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  console.log(`mean share ${mean.toFixed(3)}  min ${Math.min(...shares).toFixed(3)}  max ${Math.max(...shares).toFixed(3)}  wall ${((performance.now() - t0) / 1000).toFixed(1)}s  peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
}
