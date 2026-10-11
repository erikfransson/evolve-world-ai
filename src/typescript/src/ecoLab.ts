// Ecosystem tuning lab: runs one seeded world headless and prints a JSON line of time series.
// Usage: node src/ecoLab.ts [--seconds 900] [--seed 1] [--preset normal] [--cfg '{"eco":{"birthEnergy":120}}'] [--sample 30] [--tag name]
// --cfg is deep-merged over the preset config; sections world, eco, creature, mutation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_ECO_CONFIG } from "./sim/ecoConfig.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import { withEcoPreset } from "./sim/presets.ts";
import { Ecosystem } from "./sim/ecosystem.ts";
import { parsePool } from "./sim/seedPool.ts";

// parameters
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "900" },
    seed: { type: "string", default: "1" },
    preset: { type: "string", default: "normal" },
    cfg: { type: "string", default: "{}" },
    sample: { type: "string", default: "30" },
    tag: { type: "string", default: "" },
    pool: { type: "string", default: fileURLToPath(new URL("../public/pool.json", import.meta.url)) },
  },
});
const merge = (a: any, b: any): any => {
  for (const k of Object.keys(b)) a[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? merge(a[k] ?? {}, b[k]) : b[k];
  return a;
};
let config: EcoConfig = withEcoPreset(structuredClone(DEFAULT_ECO_CONFIG), values.preset!);
config = merge(config, JSON.parse(values.cfg!));
config.seed = Number(values.seed);
const pool = parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries;
const eco = new Ecosystem(config, pool);
const sampleTicks = Math.round(Number(values.sample) / config.dt);
const ticks = Math.round(Number(values.seconds) / config.dt);
const rows: any[] = [];
let lb = 0, ld = 0, lf = 0, lp = 0;
const t0 = performance.now();
while (eco.tick < ticks && !eco.extinct) {
  eco.step();
  if (eco.tick % sampleTicks === 0) {
    const n = eco.members.length;
    let speed = 0, energy = 0, rays = 0, depth = 0, pooled = 0;
    for (const m of eco.members) {
      const s = m.creature.state;
      speed += Math.hypot(s.vx, s.vy);
      energy += s.energy;
      rays += m.creature.plan.rayCount;
      depth += m.depth;
      if (m.founderId < eco.poolFounders) pooled++;
    }
    const top = eco.topLineages(3);
    let alive = 0;
    for (let f = 0; f < eco.founders; f++) if (eco.lineageSize(f) > 0) alive++;
    rows.push({
      t: Math.round(eco.tick * config.dt), pop: n, b: eco.births - lb, d: eco.deaths - ld, fe: eco.foodEaten - lf, pe: eco.poisonEaten - lp,
      food: eco.food, poison: eco.poison, lin: alive, top: top.map((l) => [l.founder, l.count]), speed: +(speed / n).toFixed(1),
      en: +(energy / n).toFixed(1), rays: +(rays / n).toFixed(2), depth: +(depth / n).toFixed(1), poolShare: +(pooled / n).toFixed(2),
    });
    console.error(`${values.tag} s${config.seed} t${rows[rows.length - 1].t} pop ${n}`);
    lb = eco.births; ld = eco.deaths; lf = eco.foodEaten; lp = eco.poisonEaten;
  }
}
console.log(JSON.stringify({ tag: values.tag, seed: config.seed, preset: values.preset, cfg: values.cfg, extinctAt: eco.extinct ? Math.round(eco.tick * config.dt) : null, wall: Math.round((performance.now() - t0) / 1000), sample: Number(values.sample), rows }));
