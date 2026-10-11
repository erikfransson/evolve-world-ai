// Ecosystem benchmark: runs a seeded world headless and prints ticks/s, population over time and a fingerprint.
// Usage: node src/ecoBench.ts [--seconds 120] [--seed 1] [--pop 300] [--food 0.5] [--regrow 0.05] [--every 10] [--pool public/pool.json] [--poolFraction 0.5] [--aging] [--agingStart 120] [--agingRate 0.5] [--damage] [--damagePerSpeed 0.3] [--threads 0] [--shared] [--width 12000] [--poisonDamage 30] [--seasons]
//   [--predators] [--set path=value ...]
// --food sets the starting and maximum food density, --regrow the food regrowth rate, --pool none runs without the seed pool.
// --predators starts from the Predators & prey defaults and prints each species' population too; --set overrides any
// config value, e.g. --set species.1.speed=1.4 --set eco.foodRegrow=0.04 (applied last).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "./sim/ecoConfig.ts";
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
    wasm: { type: "string" }, // true or false: sense and think on the WebAssembly kernels; default from the config
    agingStart: { type: "string" },
    agingRate: { type: "string" },
    width: { type: "string" }, // world width; height and the default population scale with it (area) so densities stay
    poisonDamage: { type: "string" }, // energy lost per poison item; 100 or more kills
    seasons: { type: "boolean" },
    damage: { type: "boolean" }, // collision damage
    damagePerSpeed: { type: "string" },
    predators: { type: "boolean" },
    set: { type: "string", multiple: true },
  },
});
const num = (v: string | undefined, fallback: number): number => (v === undefined ? fallback : Number(v));
const d = values.predators ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG;
const scale = num(values.width, d.world.width) / d.world.width;
const food = num(values.food, d.world.foodDensity);
const config: EcoConfig = {
  ...structuredClone(d),
  seed: num(values.seed, d.seed),
  world: { ...d.world, width: d.world.width * scale, height: d.world.height * scale, poisonDamage: num(values.poisonDamage, d.world.poisonDamage), foodDensity: food },
  eco: {
    ...d.eco,
    initialPopulation: num(values.pop, Math.round(d.eco.initialPopulation * scale * scale)),
    poolFraction: num(values.poolFraction, d.eco.poolFraction),
    aging: values.aging ?? d.eco.aging,
    seasons: values.seasons ?? d.eco.seasons,
    wasm: values.wasm === undefined ? d.eco.wasm : values.wasm === "true",
    agingStart: num(values.agingStart, d.eco.agingStart),
    agingRate: num(values.agingRate, d.eco.agingRate),
    collisionDamage: values.damage ?? d.eco.collisionDamage,
    damagePerSpeed: num(values.damagePerSpeed, d.eco.damagePerSpeed),
    foodMaxDensity: values.food === undefined ? d.eco.foodMaxDensity : food,
    foodRegrow: num(values.regrow, d.eco.foodRegrow),
  },
};
// --pop and --width scale every species' founders alike: the prey take initialPopulation, the predators their own count.
const founderScale = config.eco.initialPopulation / d.eco.initialPopulation;
if (config.species) config.species = config.species.map((sp) => (sp.founders === undefined ? sp : { ...sp, founders: Math.round(sp.founders * founderScale) }));
for (const assignment of values.set ?? []) {
  const [path, value] = assignment.split("=") as [string, string];
  const keys = path.split(".");
  let at: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
  const last = keys[keys.length - 1]!;
  if (!(last in at)) throw new Error(`unknown setting ${path}`);
  at[last] = value === "true" || value === "false" ? value === "true" : value.startsWith("[") ? JSON.parse(value) : Number(value);
}
const seconds = num(values.seconds, 120);
const every = Math.max(1, Math.round(num(values.every, 10) / config.dt));
const ticks = Math.round(seconds / config.dt);

const pool = values.pool === "none" ? null : parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries;
const threads = num(values.threads, 0);
const helpers = threads > 0 ? createNodeThinkPool(threads, values.shared ?? false) : null;
const eco = new Ecosystem(config, pool, { journal: helpers !== null });
await helpers?.start(eco);
const population: number[] = [eco.population];
const perSpecies = (): number[] => eco.speciesCounts.map((c) => c.population);
const speciesPopulation: number[][] = [perSpecies()];
let creatureTicks = 0;
const t0 = performance.now();
const warm = Math.floor(ticks / 4); // steadyMsPerTick leaves out these first ticks (JIT warm-up, helper start)
let tWarm = t0;
let cpuWarm = process.cpuUsage();
while (eco.tick < ticks && !eco.extinct) {
  if (eco.tick === warm) { tWarm = performance.now(); cpuWarm = process.cpuUsage(); }
  creatureTicks += eco.population;
  if (helpers) await helpers.step(eco);
  else eco.step();
  if (eco.tick % every === 0) {
    population.push(eco.population);
    speciesPopulation.push(perSpecies());
    if (eco.species.length > 1) console.error(`${Math.round(eco.tick * config.dt)} s ${perSpecies().join(" ")} food ${eco.food}`); // progress
  }
}
const t1 = performance.now();
const wall = (t1 - t0) / 1000;
helpers?.close();
console.log(JSON.stringify({
  seed: config.seed,
  seconds,
  threads: helpers ? `${threads} ${helpers.shared ? "shared" : "fork-join"}` : "serial",
  wasm: eco.wasm,
  poolFounders: eco.poolFounders,
  ticks: eco.tick,
  wallSeconds: +wall.toFixed(2),
  ticksPerSecond: +(eco.tick / wall).toFixed(1),
  msPerTick: +((1000 * wall) / Math.max(1, eco.tick)).toFixed(2),
  cpuMsPerTick: +(process.cpuUsage(cpuWarm).user / 1000 / Math.max(1, eco.tick - warm)).toFixed(2), // user CPU of all threads, steadier than wall under load
  steadyMsPerTick: +((t1 - tWarm) / Math.max(1, eco.tick - warm)).toFixed(2),
  meanPopulation: Math.round(creatureTicks / Math.max(1, eco.tick)),
  creatureTicksPerSecond: Math.round(creatureTicks / wall),
  births: eco.births,
  deaths: eco.deaths,
  food: eco.food,
  poison: eco.poison,
  population,
  ...(eco.species.length > 1 ? { species: eco.speciesCounts.map((c, s) => ({ name: eco.species[s]!.name, ...c, population: speciesPopulation.map((p) => p[s]!) })) } : {}),
  fingerprint: eco.fingerprint(),
}));
