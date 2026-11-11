// Region behaviour probe: a region map (default "clock") seeded one founder per home region, stepped headless, logging per simulated interval
// where creatures are, which home lineage they belong to, and how much they cross between regions.
// Usage (in server/): nice -n 19 node src/clockProbe.ts [--minutes 60] [--seed 1] [--copies 10] [--every 5] [--map clock] [--food 1.0] [--cap N] [--out probe.jsonl] [--founders file]
// A creature's place comes from the map's food field at its node: a realm or the hub (nearest region) at realm-level food, "trail" at trail-level food, else "waste". Its lineage is the home region its founder was seeded in.
// arrivals: creatures that first walk into a region other than their lineage's home (once per creature per region); hubArrivals: those into "commons";
// settlers: creatures born (first seen) in a region other than their lineage's home; foreignBirths: of those, per realm or hub they were born in
// (the contact measure, Erik's target about 20 per realm per sim hour); deaths: per place; energy: p50, p90 and max of creature energy (all and per place);
// atCap / pinnedShare: whether the population is at the line where births stop (maxPopulation - birthReserve), and the share of ticks it was.

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld } from "./liveWorld.ts";
import { builtMap, mapSpec } from "../../src/typescript/src/sim/maps/index.ts";
import { GROUND_PAD } from "../../src/typescript/src/sim/groundField.ts";
import { WEIGHT_UNIT } from "../../src/typescript/src/sim/maps/weights.ts";

// parameters
const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "60" },
    seed: { type: "string", default: "1" },
    copies: { type: "string", default: "10" },
    every: { type: "string", default: "5" }, // simulated minutes between log lines
    map: { type: "string", default: "clock" },
    food: { type: "string", default: "1.0" }, // eco.foodMaxDensity
    cap: { type: "string" }, // eco.maxPopulation, default the Live cap
    out: { type: "string" },
    founders: { type: "string", default: fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)) },
  },
});
const CLASSIFY_S = 1; // simulated seconds between place classifications

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const spec = mapSpec(values.map!);
if (!spec?.regions?.length) throw new Error(`map ${values.map} has no regions`);
const regions = spec.regions;
const homes = regions.filter((g) => g.id !== "commons").map((g) => g.id);
const places = [...regions.map((g) => g.id), "trail", "waste"];
const TRAIL = places.length - 2;
const WASTE = places.length - 1;
const HUB = regions.findIndex((g) => g.id === "commons");

const config = structuredClone(liveConfig);
config.seed = Number(values.seed);
config.world.map = spec.name;
config.world.width = spec.width;
config.world.height = spec.height;
config.eco.foodMaxDensity = Number(values.food); // 1.4 does not fit the item slots at this size
if (values.cap) config.eco.maxPopulation = Number(values.cap);
const dt = config.dt;
const ticks = Math.round(Number(values.minutes) * 60 / dt);
const classifyEvery = Math.max(1, Math.round(CLASSIFY_S / dt));
const logEvery = Math.max(1, Math.round(Number(values.every) * 60 / dt));

const live = new LiveWorld(config, null);
const eco = live.eco;
// Each raster node of the map is a place: realm-level food (>= REALM_FOOD) belongs to the nearest region, trail-level food to "trail",
// the rest to "waste". Discs cannot follow the elongated realm outlines, the food field can.
const REALM_FOOD = 0.75, TRAIL_FOOD = 0.3;
const mw = builtMap(spec.name).weights;
const nodePlace = new Uint8Array(mw.cols * mw.rows);
for (let k = 0; k < nodePlace.length; k++) {
  const f = mw.food[k]! / WEIGHT_UNIT;
  const x = ((k % mw.cols) - GROUND_PAD) * mw.cell, y = (Math.floor(k / mw.cols) - GROUND_PAD) * mw.cell;
  let best = WASTE;
  if (f >= REALM_FOOD) {
    let bd = Infinity;
    for (let i = 0; i < regions.length; i++) {
      const d = (x - regions[i]!.x) ** 2 + (y - regions[i]!.y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
  } else if (f >= TRAIL_FOOD) best = TRAIL;
  nodePlace[k] = best;
}
const placeOf = (x: number, y: number): number => nodePlace[Math.round(x / mw.cell) + GROUND_PAD + mw.cols * (Math.round(y / mw.cell) + GROUND_PAD)] ?? WASTE;

const seeded = live.seedFounders(loadFounders(values.founders!), mulberry32(config.seed), Number(values.copies));
const lineageHome = new Map<number, number>(); // founder creature id -> region index it was seeded in
interface Track { place: number; home: number; visited: number } // visited: bitmask of places entered
const tracks = new Map<number, Track>();
const arrivals = new Array<number>(places.length).fill(0), deaths = new Array<number>(places.length).fill(0);
let hubArrivals = 0, settlers = 0;
const foreignBirths = new Array<number>(places.length).fill(0); // births inside a home realm (or the hub) by another realm's lineage
for (const m of eco.members) {
  const p = placeOf(m.creature.state.x, m.creature.state.y);
  lineageHome.set(m.founderId, p);
  tracks.set(m.id, { place: p, home: p, visited: 1 << p });
}
eco.onDeath = (m) => {
  const t = tracks.get(m.id);
  deaths[t ? t.place : placeOf(m.creature.state.x, m.creature.state.y)]!++;
  tracks.delete(m.id);
};

function classify(): void {
  for (const m of eco.members) {
    const p = placeOf(m.creature.state.x, m.creature.state.y);
    let t = tracks.get(m.id);
    if (!t) { // first seen: born since the last pass
      const home = lineageHome.get(m.founderId) ?? WASTE;
      t = { place: p, home, visited: 1 << p };
      tracks.set(m.id, t);
      if (p !== home && p !== WASTE) settlers++;
      if (p !== home && p !== WASTE && p !== TRAIL) foreignBirths[p]!++;
      continue;
    }
    if (p === t.place) continue;
    t.place = p;
    if (p !== WASTE && p !== t.home && !(t.visited & (1 << p))) {
      arrivals[p]!++;
      if (p === HUB) hubArrivals++;
    }
    t.visited |= 1 << p;
  }
}

// The p-quantile of sorted values (0 when empty).
const quantile = (sorted: number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);
const spread = (v: number[]): object => {
  v.sort((a, b) => a - b);
  return { p50: Math.round(quantile(v, 0.5)), p90: Math.round(quantile(v, 0.9)), max: Math.round(v[v.length - 1] ?? 0) };
};
const capLine = config.eco.maxPopulation - config.eco.birthReserve; // births stop here
let pinnedTicks = 0; // ticks with the population at capLine or above

function line(): object {
  const count = places.map(() => 0), energy = places.map(() => 0);
  const energies = places.map((): number[] => []), all: number[] = [];
  const lineage = places.map(() => ({} as Record<string, number>));
  for (const m of eco.members) {
    const p = placeOf(m.creature.state.x, m.creature.state.y);
    count[p]!++;
    energy[p]! += m.creature.state.energy;
    energies[p]!.push(m.creature.state.energy);
    all.push(m.creature.state.energy);
    const h = places[lineageHome.get(m.founderId) ?? WASTE]!;
    lineage[p]![h] = (lineage[p]![h] ?? 0) + 1;
  }
  const place: Record<string, object> = {};
  places.forEach((n, i) => { place[n] = { count: count[i], lineages: lineage[i], meanEnergy: count[i] ? +(energy[i]! / count[i]!).toFixed(1) : 0, energy: spread(energies[i]!) }; });
  const byName = (a: number[]) => Object.fromEntries(places.map((n, i) => [n, a[i]]));
  return { min: +(eco.tick * dt / 60).toFixed(2), pop: eco.population, atCap: eco.population >= capLine, pinnedShare: +(pinnedTicks / Math.max(1, eco.tick)).toFixed(3), energy: spread(all), place, arrivals: byName(arrivals), hubArrivals, settlers, foreignBirths: byName(foreignBirths), deaths: byName(deaths) };
}

if (values.out) writeFileSync(values.out, "");
const lines: Record<string, any>[] = [];
const emit = () => { const l = line() as Record<string, any>; lines.push(l); if (values.out) appendFileSync(values.out, JSON.stringify(l) + "\n"); };
emit();
const t0 = performance.now();
let cpu0 = process.cpuUsage();
while (eco.tick < ticks && !eco.extinct) {
  live.step();
  if (eco.population >= capLine) pinnedTicks++;
  if (eco.tick % classifyEvery === 0) classify();
  if (eco.tick % logEvery === 0) emit();
}
const wallMs = performance.now() - t0, cpu = process.cpuUsage(cpu0);
if (lines[lines.length - 1]!.min !== +(eco.tick * dt / 60).toFixed(2)) emit();

console.log(`map ${spec.name} ${spec.width}x${spec.height} seed ${config.seed} seeded ${seeded} homes ${homes.join(",")}${eco.extinct ? " EXTINCT" : ""}`);
console.log(`ticks ${eco.tick} wall ${(wallMs / 1000).toFixed(1)}s, ${(wallMs / eco.tick).toFixed(2)} ms/tick (cpu user ${(cpu.user / 1000 / eco.tick).toFixed(2)} ms/tick), births ${eco.births} deaths ${eco.deaths}, peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
const last = lines[lines.length - 1]!;
const w = Math.max(...places.map((n) => n.length));
console.log(`${"place".padEnd(w)}  ${"count".padStart(6)} ${"energy".padStart(7)} ${"arrive".padStart(7)} ${"deaths".padStart(7)}  lineages`);
for (const n of places) {
  const p = last.place[n];
  console.log(`${n.padEnd(w)}  ${String(p.count).padStart(6)} ${String(p.meanEnergy).padStart(7)} ${String(last.arrivals[n]).padStart(7)} ${String(last.deaths[n]).padStart(7)}  ${JSON.stringify(p.lineages)}`);
}
console.log(`hubArrivals ${hubArrivals} settlers ${settlers}; energy ${JSON.stringify(last.energy)}; at the cap line (${capLine}) ${(100 * last.pinnedShare).toFixed(1)}% of ticks`);
live.close();
