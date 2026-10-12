// Picks the four named Live World founders from public/pool.json by measured behaviour and writes public/live-founders.json.
// Usage (from src/typescript): nice -n 19 node scripts/pickFounders.ts [--out public/live-founders.json]
// Every pool entry is inserted (COPIES copies) into small Ecosystem worlds of BATCH entries each and watched for SECONDS of simulated time:
// speed (units/s), turning (|turn rate| as a share of the maximum) and the distance to the nearest other creature. Deterministic: fixed seeds.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_ECO_CONFIG } from "../src/sim/ecoConfig.ts";
import type { EcoConfig } from "../src/sim/ecoConfig.ts";
import { Ecosystem } from "../src/sim/ecosystem.ts";
import { parsePool, trialsToEcoGenome } from "../src/sim/seedPool.ts";
import type { PoolEntry } from "../src/sim/seedPool.ts";
import { createRng } from "../src/sim/rng.ts";

// parameters
const SECONDS = 30; // simulated seconds watched per batch
const BATCH = 25; // pool entries per world
const COPIES = 4; // copies of each entry
const BACKGROUND = 100; // pool-seeded creatures already living in each world
const WORLD = { width: 2400, height: 1500 };
const SAMPLE_EVERY = 10; // ticks between samples
const SEED = 7;

const { values } = parseArgs({ options: { out: { type: "string", default: "public/live-founders.json" } } });
const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;

interface Measure {
  index: number;
  speed: number;
  turn: number;
  nearest: number; // mean distance to the nearest other creature
  eaten: number; // food per copy
  alive: number; // share of copies alive at the end
}

const config = (seed: number): EcoConfig => {
  const c = structuredClone(DEFAULT_ECO_CONFIG);
  c.seed = seed;
  c.world.width = WORLD.width;
  c.world.height = WORLD.height;
  c.eco.initialPopulation = BACKGROUND;
  c.eco.poolFraction = 1;
  c.eco.foodRegrow = 0.05;
  return c;
};

function measureBatch(entries: { index: number; entry: PoolEntry }[], seed: number): Measure[] {
  const c = config(seed);
  const eco = new Ecosystem(c, pool);
  const rng = createRng(seed * 7919 + 1);
  const ids = new Map<number, number[]>(); // pool index -> inserted ids
  for (const { index, entry } of entries) {
    const genome = trialsToEcoGenome(entry.plan, entry.genome, c);
    const list: number[] = [];
    for (let k = 0; k < COPIES; k++) {
      for (let tries = 0; tries < 50; tries++) {
        const r = eco.insertCreature({ genome, plan: entry.plan, x: rng.range(50, WORLD.width - 50), y: rng.range(50, WORLD.height - 50), heading: rng.range(0, 2 * Math.PI), hue: 0, name: "" });
        if (r.ok) {
          list.push(r.id);
          break;
        }
      }
    }
    ids.set(index, list);
  }
  const acc = new Map<number, { dist: number; turn: number; near: number; n: number; nNear: number }>();
  const ate = new Map<number, number>(); // food eaten per inserted id, kept after it dies
  const last = new Map<number, { x: number; y: number }>();
  const ticks = Math.round(SECONDS / c.dt);
  const maxTurn = c.creature.maxTurnRate;
  for (let t = 1; t <= ticks; t++) {
    eco.step();
    if (t % SAMPLE_EVERY) continue;
    const others = eco.members.map((m) => [m.creature.state.x, m.creature.state.y, m.id] as const);
    for (const [index, list] of ids) {
      const a = acc.get(index) ?? { dist: 0, turn: 0, near: 0, n: 0, nNear: 0 };
      for (const id of list) {
        const m = eco.get(id);
        if (!m) continue;
        ate.set(id, m.eaten);
        const s = m.creature.state;
        const prev = last.get(id);
        if (prev) {
          a.dist += Math.hypot(s.x - prev.x, s.y - prev.y);
          a.turn += Math.abs(s.turnRate) / maxTurn;
          a.n++;
        }
        last.set(id, { x: s.x, y: s.y });
        let best = Infinity;
        for (const [x, y, oid] of others) if (oid !== id) best = Math.min(best, Math.hypot(x - s.x, y - s.y));
        if (Number.isFinite(best)) {
          a.near += best;
          a.nNear++;
        }
      }
      acc.set(index, a);
    }
  }
  return entries.map(({ index }) => {
    const a = acc.get(index)!;
    const list = ids.get(index)!;
    const eaten = list.reduce((s, id) => s + (ate.get(id) ?? 0), 0);
    return { index, speed: a.n ? a.dist / (a.n * SAMPLE_EVERY * c.dt) : 0, turn: a.n ? a.turn / a.n : 0, nearest: a.nNear ? a.near / a.nNear : Infinity, eaten: eaten / list.length, alive: list.filter((id) => eco.get(id)).length / list.length };
  });
}

const measures: Measure[] = [];
for (let b = 0; b * BATCH < pool.length; b++) {
  const entries = pool.slice(b * BATCH, (b + 1) * BATCH).map((entry, k) => ({ index: b * BATCH + k, entry }));
  measures.push(...measureBatch(entries, SEED + b));
  process.stderr.write(`batch ${b + 1}/${Math.ceil(pool.length / BATCH)}\n`);
}

const hist = (f: (m: Measure) => number): string => [0, 0.25, 0.5, 0.75, 1].map((v) => measures.filter((m) => f(m) === v).length).join(" ");
process.stderr.write(`alive shares 0..1: ${hist((m) => m.alive)}; eaten>=1: ${measures.filter((m) => m.eaten >= 1).length}; mean eaten ${measures.reduce((s, m) => s + m.eaten, 0) / measures.length}\n`);
// Only creatures that kept half their copies alive and ate at least one food per copy count; the picks are distinct entries.
const fit = measures.filter((m) => m.alive >= 0.5 && m.eaten >= 1);
const taken = new Set<number>();
const pick = (score: (m: Measure) => number): Measure => {
  const best = fit.filter((m) => !taken.has(m.index)).sort((a, b) => score(b) - score(a))[0]!;
  taken.add(best.index);
  return best;
};
const plan = (m: Measure): PoolEntry["plan"] => pool[m.index]!.plan;
const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const medNear = median(fit.map((m) => m.nearest));
const medSpeed = median(fit.map((m) => m.speed));
const explorer = pick((m) => m.speed);
const slow = pick((m) => -m.speed / medSpeed + plan(m).raySpread / Math.PI); // barely moves, wide rays
const peaceful = pick((m) => m.nearest / medNear - (m.speed < 0.3 * medSpeed ? 10 : 0)); // keeps away, and moving (so it is not just parked)
const hunter = pick((m) => -m.nearest / medNear - (m.speed < 0.7 * medSpeed ? 10 : 0)); // stays close to others while moving

const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d || 0;
const ecoConfig = config(SEED);
const out = {
  version: 1,
  command: "nice -n 19 node scripts/pickFounders.ts",
  measured: { seconds: SECONDS, copies: COPIES, background: BACKGROUND, world: WORLD, medianSpeed: round(medSpeed), medianNearest: round(medNear), poolEntries: pool.length, fit: fit.length },
  founders: [
    { id: "explorer", name: "Explorer", blurb: "Moves a lot and covers ground fast.", m: explorer },
    { id: "steady", name: "Slow and steady", blurb: "Barely moves and watches wide.", m: slow },
    { id: "peaceful", name: "Peaceful", blurb: "Keeps its distance from others.", m: peaceful },
    { id: "hunter", name: "Hunter-ish", blurb: "Heads for other creatures.", m: hunter },
  ].map(({ m, ...f }) => {
    const e = pool[m.index]!;
    return { ...f, pool: m.index, speed: round(m.speed, 1), turn: round(m.turn), nearest: round(m.nearest, 0), plan: e.plan, genome: Array.from(trialsToEcoGenome(e.plan, e.genome, ecoConfig), (v) => round(v, 4)) };
  }),
};
writeFileSync(values.out!, JSON.stringify(out) + "\n");
for (const f of out.founders) console.log(`${f.name.padEnd(16)} pool #${f.pool}  speed ${f.speed}  turn ${f.turn}  nearest ${f.nearest}  rays ${f.plan.rayCount} x ${round(f.plan.raySpread, 2)} rad x ${f.plan.rayLength}`);
console.log(`medians: speed ${round(medSpeed, 1)}, nearest ${round(medNear, 0)}; ${fit.length} of ${pool.length} entries kept half their copies alive and ate`);
