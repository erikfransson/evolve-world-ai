// Ecosystem benchmark: runs a seeded world headless and prints ticks/s, population over time and a fingerprint.
// Usage: node src/ecoBench.ts [--seconds 120] [--seed 1] [--pop 300] [--width 12000] [--every 10] [--series 30]
//   [--pool public/pool.json] [--threads 0] [--predators] [--preset ID] [--config file.json] [--set path=value ...]
// --config reads settings in the page's Copy format (Ecosystem or The Great Hunt) as the base; --preset applies a preset's world
// and regrowth to the defaults (not with --config); --predators starts from the The Great Hunt defaults.
// --set overrides any config value after that, checked like a pasted config: --set eco.foodRegrow=0.04 --set species.1.speed=1.4
// (--set eco.wasm=false runs the JS path, --set eco.aging=true turns on old-age upkeep). --pool none runs without the seed pool.
// --pop and --width scale the founders and the area (height and the default population scale with --width).
// --threads N runs N helper threads for sense and think.
// --series S adds a row every S seconds to the output: births, deaths and items eaten since the last row, food, lineages, trait means.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { overrideConfig } from "./sim/config.ts";
import type { DeepPartial } from "./sim/config.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "./sim/ecoConfig.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import { Ecosystem } from "./sim/ecosystem.ts";
import { ECO_PRESETS, PREDATOR_PRESETS, withEcoPreset } from "./sim/presets.ts";
import { parsePool } from "./sim/seedPool.ts";
import { checkRanges, mergeSpeciesList } from "./sim/species.ts";
import { parseSettings } from "./ui/settingsIO.ts";
import { createNodeThinkPool } from "./worker/nodePool.ts";
import { DutyController, FALLBACK_DUTY, idleMs } from "./worker/pacer.ts";

// parameters
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "120" },
    seed: { type: "string" },
    pop: { type: "string" },
    width: { type: "string" },
    every: { type: "string", default: "10" }, // seconds between population samples
    series: { type: "string" }, // seconds between rows of the time series
    pool: { type: "string", default: fileURLToPath(new URL("../public/pool.json", import.meta.url)) },
    threads: { type: "string", default: "0" }, // helper threads for sense and think; 0 runs on this thread alone
    gentle: { type: "boolean" }, // idle in 12 ms slices at the fallback duty, as the page does without the Compute Pressure API (pick --threads yourself); same results
    predators: { type: "boolean" },
    preset: { type: "string" },
    config: { type: "string" },
    set: { type: "string", multiple: true },
  },
});
const num = (v: string | undefined, fallback: number): number => (v === undefined ? fallback : Number(v));

// "path=value" assignments as one nested override.
function overridesOf(assignments: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    if (eq < 0) throw new Error(`--set needs path=value, got "${assignment}"`);
    const keys = assignment.slice(0, eq).split(".");
    const raw = assignment.slice(eq + 1);
    let at = out;
    for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>;
    at[keys[keys.length - 1]!] = /^(true|false|\[.*\])$/.test(raw) ? JSON.parse(raw) : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

let predators = values.predators ?? false;
let config: EcoConfig;
if (values.config !== undefined) {
  if (values.preset !== undefined) throw new Error("--preset and --config do not combine, the file carries its own settings");
  const text = readFileSync(values.config, "utf8");
  predators = JSON.parse(text).mode === "predators";
  config = parseSettings(text, predators ? "predators" : "ecosystem");
} else {
  config = structuredClone(predators ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG);
  if (values.preset !== undefined) {
    const presets = predators ? PREDATOR_PRESETS : ECO_PRESETS;
    if (!presets.some((p) => p.id === values.preset)) throw new Error(`unknown preset "${values.preset}", expected ${presets.map((p) => p.id).join(", ")}`);
    config = withEcoPreset(config, values.preset, presets);
  }
}
config.seed = num(values.seed, config.seed);
const scale = num(values.width, config.world.width) / config.world.width;
const startPopulation = config.eco.initialPopulation;
config.world.width *= scale;
config.world.height *= scale;
config.eco.initialPopulation = num(values.pop, Math.round(startPopulation * scale * scale));
// --pop and --width scale every species' founders alike.
const founderScale = config.eco.initialPopulation / startPopulation;
config.species = config.species?.map((sp) => (sp.founders === undefined ? sp : { ...sp, founders: Math.round(sp.founders * founderScale) }));
const { species: speciesPatch, ...patch } = overridesOf(values.set ?? []);
config = overrideConfig<EcoConfig>(config, patch as DeepPartial<EcoConfig>);
checkRanges(config.eco as unknown as Record<string, unknown>, "eco");
if (speciesPatch !== undefined) {
  if (!config.species) throw new Error("this config has no species list");
  const list = config.species;
  config.species = mergeSpeciesList(list.map((sp, i) => ({ ...sp, ...(speciesPatch as Record<number, object>)[i] })), list);
}

const seconds = num(values.seconds, 120);
const every = Math.max(1, Math.round(num(values.every, 10) / config.dt));
const seriesEvery = values.series === undefined ? 0 : Math.max(1, Math.round(Number(values.series) / config.dt));
const ticks = Math.round(seconds / config.dt);

const pool = values.pool === "none" ? null : parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries;
const threads = num(values.threads, 0);
const helpers = threads > 0 ? createNodeThinkPool(threads) : null;
const eco = new Ecosystem(config, pool, { journal: helpers !== null });
await helpers?.start(eco);
const population: number[] = [eco.population];
const perSpecies = (): number[] => eco.speciesCounts.map((c) => c.population);
const speciesPopulation: number[][] = [perSpecies()];
const series: Record<string, unknown>[] = [];
let last = { births: 0, deaths: 0, foodEaten: 0, poisonEaten: 0 };

// Means over the living creatures and the changes since the previous row.
function seriesRow(): Record<string, unknown> {
  const n = Math.max(1, eco.members.length);
  let speed = 0, energy = 0, rays = 0, depth = 0, pooled = 0;
  for (const m of eco.members) {
    const s = m.creature.state;
    speed += Math.hypot(s.vx, s.vy);
    energy += s.energy;
    rays += m.creature.plan.rayCount;
    depth += m.depth;
    if (m.founderId < eco.poolFounders) pooled++;
  }
  let lineages = 0;
  for (let f = 0; f < eco.founders; f++) if (eco.lineages.size(f) > 0) lineages++;
  const row = {
    t: Math.round(eco.tick * config.dt), pop: eco.population, births: eco.births - last.births, deaths: eco.deaths - last.deaths,
    foodEaten: eco.foodEaten - last.foodEaten, poisonEaten: eco.poisonEaten - last.poisonEaten, food: eco.food, poison: eco.poison, lineages,
    top: eco.lineages.top(3).map((l) => [l.founder, l.count]), speed: +(speed / n).toFixed(1), energy: +(energy / n).toFixed(1),
    rays: +(rays / n).toFixed(2), depth: +(depth / n).toFixed(1), poolShare: +(pooled / n).toFixed(2),
  };
  last = { births: eco.births, deaths: eco.deaths, foodEaten: eco.foodEaten, poisonEaten: eco.poisonEaten };
  return row;
}

const controller = values.gentle ? new DutyController(FALLBACK_DUTY) : null;
const SLICE_MS = 12; // as EcoRunner
let sliceStart = performance.now();
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
  if (seriesEvery && eco.tick % seriesEvery === 0) series.push(seriesRow());
  const now = performance.now();
  if (controller && now - sliceStart >= SLICE_MS) {
    const idle = idleMs(now - sliceStart, controller.duty());
    if (idle > 0) await new Promise((resolve) => setTimeout(resolve, idle));
    sliceStart = performance.now();
  }
}
const t1 = performance.now();
const wall = (t1 - t0) / 1000;
helpers?.close();
console.log(JSON.stringify({
  seed: config.seed,
  seconds,
  threads: helpers ? `${threads} helpers` : "serial",
  wasm: eco.wasm,
  poolFounders: eco.poolFounders,
  ticks: eco.tick,
  wallSeconds: +wall.toFixed(2),
  ticksPerSecond: +(eco.tick / wall).toFixed(1),
  msPerTick: +((1000 * wall) / Math.max(1, eco.tick)).toFixed(2),
  cpuMsPerTick: +(process.cpuUsage(cpuWarm).user / 1000 / Math.max(1, eco.tick - warm)).toFixed(2), // user CPU of all threads, steadier than wall under load
  cpuPercent: +((100 * (process.cpuUsage(cpuWarm).user + process.cpuUsage(cpuWarm).system)) / 1000 / (t1 - tWarm)).toFixed(0), // all threads, steady part; 100 = one core
  steadyMsPerTick: +((t1 - tWarm) / Math.max(1, eco.tick - warm)).toFixed(2),
  meanPopulation: Math.round(creatureTicks / Math.max(1, eco.tick)),
  creatureTicksPerSecond: Math.round(creatureTicks / wall),
  births: eco.births,
  deaths: eco.deaths,
  food: eco.food,
  poison: eco.poison,
  population,
  ...(eco.species.length > 1 ? { species: eco.speciesCounts.map((c, s) => ({ name: eco.species[s]!.name, ...c, population: speciesPopulation.map((p) => p[s]!) })) } : {}),
  ...(seriesEvery ? { series } : {}),
  fingerprint: eco.fingerprint(),
}));
