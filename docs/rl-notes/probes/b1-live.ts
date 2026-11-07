// Usage (in src/typescript): node ../../docs/rl-notes/probes/b1-live.ts OUT.json --sets af=DIR,ab=DIR,... [--world 1] [--copies 800] [--ins 3] [--seconds 240]
// Live survival check without the server: the server's LiveWorld (liveConfig, live founders, `copies` of each) is seeded as liveBench does, then `ins` copies of every B1 body (panel plus p9, p10; DIR may be "untrained")
// of every set are inserted (engine insertCreature, Live's visitor start energy, random open spots, one lineage name per set and design), and the world runs `seconds` of simulated time.
// Per inserted creature: lifespan (seconds, censored at the horizon) and children (offspring born by it), by set and design. Reads server/ modules, changes nothing there.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { LIVE, liveConfig } from "../../../server/src/config.ts";
import { loadFounders } from "../../../server/src/founders.ts";
import { LiveWorld } from "../../../server/src/liveWorld.ts";
import { DESIGN_PANEL, designLearner } from "../../../src/typescript/src/sim/rl/designPanel.ts";
import { EXTRA_DESIGNS } from "../../../src/typescript/src/sim/rl/b1Bodies.ts";
import { checkLearner } from "../../../src/typescript/src/sim/rl/library.ts";
import type { World } from "../../../src/typescript/src/sim/world.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { sets: { type: "string" }, world: { type: "string", default: "1" }, copies: { type: "string", default: "800" }, ins: { type: "string", default: "3" }, seconds: { type: "string", default: "240" } } });
const out = positionals[0]!;
const sets = values.sets!.split(",").map((s) => s.split("=") as [string, string]);
const seed = Number(values.world), copies = Number(values.copies), ins = Number(values.ins), seconds = Number(values.seconds);
function mulberry32(a0: number): () => number {
  let a = a0 >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const config = structuredClone(liveConfig);
config.seed = seed;
const founders = loadFounders(fileURLToPath(new URL("../../../src/typescript/public/live-founders.json", import.meta.url)));
const live = new LiveWorld(config, null, null);
const rnd = mulberry32(seed);
live.seedFounders(founders, rnd, copies);
const eco = live.eco;
const r = config.creature.radius;
const track: { set: string; design: string; id: number; life: number; children: number; alive: boolean }[] = [];
let hue = 0;
for (const [name, dir] of sets) {
  for (const d of [...DESIGN_PANEL, ...EXTRA_DESIGNS]) {
    let l;
    if (dir === "untrained") l = designLearner(d);
    else { const c = checkLearner(JSON.parse(readFileSync(resolve(dir, `${d.id}.json`), "utf8")), "ecosystem"); if (typeof c === "string") throw new Error(`${name} ${d.id}: ${c}`); l = c; }
    for (let k = 0; k < ins; k++) {
      let x = 0, y = 0;
      do { x = 4 * r + rnd() * (config.world.width - 8 * r); y = 4 * r + rnd() * (config.world.height - 8 * r); } while ((eco.world as World).terrain.touchesRock(x, y, 2 * r));
      const res = eco.insertCreature({ genome: l.genome, plan: l.plan, x, y, heading: rnd() * 2 * Math.PI, hue: (hue += 37) % 360, name: `${name}:${d.id}`, energy: LIVE.add.startEnergy });
      if (!res.ok) throw new Error(`${name} ${d.id}: ${res.reason}`);
      const mm = eco.get(res.id)!;
      mm.lastBirthTick = eco.tick + Math.round(LIVE.add.birthHoldS / config.dt) - mm.cooldownTicks; // the visitor add's birth hold, as LiveWorld.addCreatures
      track.push({ set: name, design: d.id, id: res.id, life: 0, children: 0, alive: true });
    }
  }
}
const dt = config.dt, ticks = Math.round(seconds / dt), poll = Math.round(1 / dt);
const t0 = performance.now();
while (eco.tick < ticks && !eco.extinct) {
  live.step();
  if (eco.tick % poll === 0) for (const t of track) {
    if (!t.alive) continue;
    const m = eco.get(t.id);
    if (m && m.founderId === t.id) { t.life = m.creature.state.ticksAlive * dt; t.children = m.children; } else t.alive = false;
  }
}
const rows: Record<string, Record<string, { life: number[]; children: number[]; died: number }>> = {};
for (const t of track) {
  const cell = ((rows[t.set] ??= {})[t.design] ??= { life: [], children: [], died: 0 });
  cell.life.push(t.alive ? seconds : t.life); cell.children.push(t.children); cell.died += t.alive ? 0 : 1;
}
writeFileSync(out, JSON.stringify({ world: seed, copies, ins, seconds, population: eco.population, wallSeconds: (performance.now() - t0) / 1000, rows }) + "\n");
console.log(`world ${seed}: ${eco.tick} ticks, population ${eco.population}, wall ${((performance.now() - t0) / 1000).toFixed(0)} s`);
