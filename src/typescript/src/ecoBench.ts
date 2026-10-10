// Ecosystem benchmark: runs a seeded world headless and prints ticks/s, population over time and a fingerprint.
// Usage: node src/ecoBench.ts [--seconds 120] [--seed 1] [--pop 300] [--food 0.5] [--regrow 0.05] [--every 10]
// --food sets the starting and maximum food density, --regrow the food regrowth rate.

import { parseArgs } from "node:util";
import { DEFAULT_ECO_CONFIG } from "./sim/ecoConfig.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import { Ecosystem } from "./sim/ecosystem.ts";

// parameters
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "120" },
    seed: { type: "string", default: "1" },
    pop: { type: "string" },
    food: { type: "string" },
    regrow: { type: "string" },
    every: { type: "string", default: "10" }, // seconds between population samples
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
    foodMaxDensity: values.food === undefined ? d.eco.foodMaxDensity : food,
    foodRegrow: num(values.regrow, d.eco.foodRegrow),
  },
};
const seconds = num(values.seconds, 120);
const every = Math.max(1, Math.round(num(values.every, 10) / config.dt));
const ticks = Math.round(seconds / config.dt);

const eco = new Ecosystem(config);
const population: number[] = [eco.population];
let creatureTicks = 0;
const t0 = performance.now();
while (eco.tick < ticks && !eco.extinct) {
  creatureTicks += eco.population;
  eco.step();
  if (eco.tick % every === 0) population.push(eco.population);
}
const wall = (performance.now() - t0) / 1000;
console.log(JSON.stringify({
  seed: config.seed,
  seconds,
  ticks: eco.tick,
  wallSeconds: +wall.toFixed(2),
  ticksPerSecond: +(eco.tick / wall).toFixed(1),
  meanPopulation: Math.round(creatureTicks / Math.max(1, eco.tick)),
  creatureTicksPerSecond: Math.round(creatureTicks / wall),
  births: eco.births,
  deaths: eco.deaths,
  food: eco.food,
  poison: eco.poison,
  population,
  fingerprint: eco.fingerprint(),
}));
