// Ecosystem benchmark: runs a seeded world headless and prints ticks/s, population over time and a fingerprint.
// Usage: node src/ecoBench.ts [--seconds 120] [--seed 1] [--pop 300] [--food 0.5] [--regrow 0.05] [--every 10] [--pool public/pool.json] [--poolFraction 0.5] [--aging] [--agingStart 120] [--agingRate 0.5] [--threads 0] [--shared]
// --food sets the starting and maximum food density, --regrow the food regrowth rate, --pool none runs without the seed pool.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_ECO_CONFIG } from "./sim/ecoConfig.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import { Ecosystem } from "./sim/ecosystem.ts";
import { parsePool } from "./sim/seedPool.ts";
import { createNodeThinkPool } from "./worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "120" },
    seed: { type: "string", default: "1" },
    pop: { type: "string" },
    food: { type: "string" },
    regrow: { type: "string" },
    every: { type: "string", default: "10" }, // seconds between population samples
    pool: { type: "string", default: fileURLToPath(new URL("../public/pool.json", import.meta.url)) },
    poolFraction: { type: "string" },
    aging: { type: "boolean" },
    threads: { type: "string", default: "0" }, // helper threads for sense and think; 0 runs on this thread alone
    shared: { type: "boolean" }, // helpers use shared memory instead of messages
    agingStart: { type: "string" },
    agingRate: { type: "string" },
  },
});
const num = (v: string | undefined, fallback: number): number => (v === undefined ? fallback : Number(v));
const d = DEFAULT_ECO_CONFIG;
const food = num(values.food, d.world.foodDensity);
const config: EcoConfig = {
  ...structuredClone(d),
  seed: num(values.seed, d.seed),
  world: { ...d.world, foodDensity: food },
  eco: {
    ...d.eco,
    initialPopulation: num(values.pop, d.eco.initialPopulation),
    poolFraction: num(values.poolFraction, d.eco.poolFraction),
    aging: values.aging ?? d.eco.aging,
    agingStart: num(values.agingStart, d.eco.agingStart),
    agingRate: num(values.agingRate, d.eco.agingRate),
    foodMaxDensity: values.food === undefined ? d.eco.foodMaxDensity : food,
    foodRegrow: num(values.regrow, d.eco.foodRegrow),
  },
};
const seconds = num(values.seconds, 120);
const every = Math.max(1, Math.round(num(values.every, 10) / config.dt));
const ticks = Math.round(seconds / config.dt);

const pool = values.pool === "none" ? null : parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries;
const threads = num(values.threads, 0);
const helpers = threads > 0 ? createNodeThinkPool(threads, values.shared ?? false) : null;
const eco = new Ecosystem(config, pool, { journal: helpers !== null });
await helpers?.start(eco);
const population: number[] = [eco.population];
let creatureTicks = 0;
const t0 = performance.now();
const warm = Math.floor(ticks / 4); // steadyMsPerTick leaves out these first ticks (JIT warm-up, helper start)
let tWarm = t0;
while (eco.tick < ticks && !eco.extinct) {
  if (eco.tick === warm) tWarm = performance.now();
  creatureTicks += eco.population;
  if (helpers) await helpers.step(eco);
  else eco.step();
  if (eco.tick % every === 0) population.push(eco.population);
}
const t1 = performance.now();
const wall = (t1 - t0) / 1000;
helpers?.close();
console.log(JSON.stringify({
  seed: config.seed,
  seconds,
  threads: helpers ? `${threads} ${helpers.shared ? "shared" : "fork-join"}` : "serial",
  poolFounders: eco.poolFounders,
  ticks: eco.tick,
  wallSeconds: +wall.toFixed(2),
  ticksPerSecond: +(eco.tick / wall).toFixed(1),
  msPerTick: +((1000 * wall) / Math.max(1, eco.tick)).toFixed(2),
  steadyMsPerTick: +((t1 - tWarm) / Math.max(1, eco.tick - warm)).toFixed(2),
  meanPopulation: Math.round(creatureTicks / Math.max(1, eco.tick)),
  creatureTicksPerSecond: Math.round(creatureTicks / wall),
  births: eco.births,
  deaths: eco.deaths,
  food: eco.food,
  poison: eco.poison,
  population,
  fingerprint: eco.fingerprint(),
}));
