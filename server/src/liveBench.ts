// Live World benchmark: the server's LiveWorld (liveConfig, The Inland Sea) seeded with the live founders, stepped headless on this thread.
// Prints CPU ms per steady tick, the phase profile, peak RSS and a fingerprint (equal runs give equal fingerprints).
// Usage (in server/): node src/liveBench.ts [--seconds 60] [--copies 800] [--seed 1] [--founders ../src/typescript/public/live-founders.json]
//   [--dt 0.0333] [--memcomp] [--only juggernaut,grazer] [--frames [--idle]] [--profile] [--profileEvery 300] [--every 10] [--threads 0] [--think 1] [--save 15]
// --copies: copies of each founder seeded (4 founders x 800 = 3200 creatures, 6 M brain weights, under the birth weight cap).
// --only: seed these founder ids only (so --only juggernaut --copies 4900 fills the 5000 cap with small brains).
// --frames: also encode the creature frame and item delta at the server's 5 Hz (FRAME_MS), as the public loop does for viewers.
// --dt: seconds per tick instead of liveConfig's (1/30); --memcomp: with it, scale the memory rates so their time constants in seconds stay as at 1/30.
// Per simulated minute the output also lists births, deaths, food and poison eaten, mean speed, mean absolute turn rate, mean energy and mean lifespan of the deaths (ecoWindows).
// --idle: with --frames, the loop as it runs with no viewer connected (item changes drained, no creature frame, stats without the per-creature pass).
// --think: eco.thinkEvery instead of liveConfig's (1 is every tick).
// --threads: helper threads that sense and think (createNodeThinkPool), as LIVE_THREADS on the server; speedAchieved then shows the wall gain.
// --save: save every this many simulated seconds through the server's Saves into a temporary state directory, and report per save the
//   main-thread time it took between ticks (blockMs wall, cpuMs this thread's CPU, longest single block maxBlockMs) and its log line.
// --fixed: births stop at the seeded count (maxPopulation = seeded, no reserve), so the population cannot grow; with --profile the phases then give the cost per tick against the population (docs/perf-explore/intercept.md).
// --food: world.foodDensity instead of liveConfig's (0.1 gives the 20-25k items of an aged world, the default about 85k).
// --profile: CPU ms per engine phase per steady tick (the first quarter of the ticks is warm-up and left out of every steady number).
// --profileEvery: with --profile, also print the phases per window of this many simulated seconds, ms per tick per 1000 creatures (the warm-up is then not left out of the phase totals).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { PhaseTimer } from "../../src/typescript/src/sim/profile.ts";
import { LIVE, liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld } from "./liveWorld.ts";
import { Saves } from "./saves.ts";
import { StateStore } from "./state.ts";
import { SCALARS, type EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import type { World } from "../../src/typescript/src/sim/world.ts";
import { FRAME_MS } from "./public.ts";
import { createNodeThinkPool } from "../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "60" },
    copies: { type: "string", default: "800" },
    seed: { type: "string", default: "1" },
    founders: { type: "string", default: fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)) },
    only: { type: "string" },
    frames: { type: "boolean" },
    idle: { type: "boolean" },
    profile: { type: "boolean" },
    fixed: { type: "boolean" },
    food: { type: "string" },
    every: { type: "string", default: "10" }, // seconds between population samples
    threads: { type: "string", default: "0" },
    think: { type: "string" },
    dt: { type: "string" },
    memcomp: { type: "boolean" },
    save: { type: "string" },
    keep: { type: "string" }, // with --save: keep the saves in this directory
    load: { type: "string" }, // restore the newest save of this directory instead of seeding
    scatter: { type: "boolean" }, // with --load: scratch, scatter the creatures uniformly (study only)
    reach: { type: "boolean" }, // scratch: print the creatures and items within each creature's ray length, at the start and end
    profileEvery: { type: "string" }, // with --profile: print the phase profile per this many simulated seconds
  },
});

// Small deterministic generator for the seeding draws (spots, hues), so runs repeat.
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

const seed = Number(values.seed);
const config = structuredClone(liveConfig);
config.seed = seed;
if (values.dt) config.dt = Number(values.dt);
if (values.memcomp) {
  const k = config.dt / liveConfig.dt;
  config.brain.shortRate = 1 - (1 - config.brain.shortRate) ** k;
  config.brain.longRate = 1 - (1 - config.brain.longRate) ** k;
}
if (values.think) config.eco.thinkEvery = Number(values.think);
if (values.food) config.world.foodDensity = Number(values.food);
let founders = loadFounders(values.founders!);
if (values.only) {
  const ids = new Set(values.only.split(","));
  founders = founders.filter((f) => ids.has(f.id));
  if (founders.length === 0) throw new Error(`no founder matches --only ${values.only}`);
}
const copies = Number(values.copies);
const seconds = Number(values.seconds);
const dt = config.dt;
let ticks = Math.round(seconds / dt);
const every = Math.max(1, Math.round(Number(values.every) / dt));
const frameEvery = Math.max(1, Math.round(FRAME_MS / 1000 / dt * LIVE.speed)); // ticks per frame at the server's set speed
const statsEvery = Math.max(1, Math.round(LIVE.speed / dt)); // the stats go out once a second (public.ts statsLoop)

// Scratch (study only): moves every creature of the state to a uniform random spot off the rock.
function scatter(state: EcoState, lw: LiveWorld, rnd: () => number): void {
  const { width, height } = config.world;
  const cr = state.creatures as unknown as { scalars: string | Float64Array; count: number };
  const sc = typeof cr.scalars === "string" ? new Float64Array(new Uint8Array(Buffer.from(cr.scalars, "base64")).buffer) : cr.scalars;
  const K = SCALARS.length;
  const xi = SCALARS.indexOf("x"), yi = SCALARS.indexOf("y");
  const terrain = (lw.eco.world as World).terrain;
  for (let i = 0; i < cr.count; i++) {
    let x = 0, y = 0;
    do { x = rnd() * width; y = rnd() * height; } while (terrain.touchesRock(x, y, config.creature.radius));
    sc[i * K + xi] = x;
    sc[i * K + yi] = y;
  }
  if (typeof cr.scalars === "string") cr.scalars = Buffer.from(sc.buffer, sc.byteOffset, sc.byteLength).toString("base64");
}

// Scratch (study only): per creature, the creatures and the items within its own ray length (a disc proxy of the sense candidates), plus plan means.
function reach(label: string): void {
  const items = (eco.world as World).snapshot();
  const R = config.creature.rayLength;
  const cell = Math.max(R, 1);
  const cols = Math.ceil(config.world.width / cell) + 1;
  const grid = (xs: ArrayLike<number>, ys: ArrayLike<number>, ok: (i: number) => boolean) => {
    const m = new Map<number, number[]>();
    for (let i = 0; i < xs.length; i++) if (ok(i)) { const k = Math.floor(ys[i]! / cell) * cols + Math.floor(xs[i]! / cell); (m.get(k) ?? m.set(k, []).get(k)!).push(i); }
    return m;
  };
  const near = (m: Map<number, number[]>, xs: ArrayLike<number>, ys: ArrayLike<number>, x: number, y: number, r: number, self = -1): number => {
    let n = 0;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of m.get((cy + dy) * cols + cx + dx) ?? []) if (j !== self && Math.hypot(xs[j]! - x, ys[j]! - y) <= r) n++;
    return n;
  };
  const ms = eco.members;
  const cx = ms.map((m) => m.creature.state.x), cy = ms.map((m) => m.creature.state.y);
  const cg = grid(cx, cy, () => true);
  const ig = grid(items.xs, items.ys, (i) => items.kinds[i]! > 0);
  let c = 0, it = 0, rays = 0, mem = 0, len = 0, w = 0, empty = 0;
  ms.forEach((m, i) => {
    const r = m.creature.plan.rayLength;
    const a = near(cg, cx, cy, cx[i]!, cy[i]!, r, i), b = near(ig, items.xs, items.ys, cx[i]!, cy[i]!, r);
    c += a; it += b; if (a + b === 0) empty++;
    rays += m.creature.plan.rayCount; mem += m.creature.memory.length; len += r; w += m.creature.brain.genomeLength;
  });
  const n = Math.max(1, ms.length);
  console.error(JSON.stringify({ reach: label, n: ms.length, tick: eco.tick, food: eco.food, poison: eco.poison, crowdPerCreature: +(c / n).toFixed(3), itemsPerCreature: +(it / n).toFixed(2), emptyShare: +(empty / n).toFixed(3), rays: +(rays / n).toFixed(2), memory: +(mem / n).toFixed(2), rayLength: +(len / n).toFixed(1), weights: Math.round(w / n), meanAgeTicks: +(ms.reduce((s, m) => s + m.creature.state.ticksAlive, 0) / n).toFixed(0), species: ms.reduce((o, m) => { o[m.species] = (o[m.species] ?? 0) + 1; return o; }, {} as Record<number, number>) }));
}

const tBuild = performance.now();
const threads = Number(values.threads);
const live = new LiveWorld(config, null, threads > 0 ? createNodeThinkPool(threads) : null);
let seeded = 0;
if (values.load) {
  const store = new StateStore(values.load);
  const newest = [...store.list()].sort((a, b) => (b.tick ?? 0) - (a.tick ?? 0))[0];
  if (!newest) throw new Error(`--load ${values.load}: no save`);
  const state = await store.read(newest.name, live.homeWorld());
  if (values.scatter) scatter(state, live, mulberry32(seed + 7));
  live.restoreState(state);
  seeded = live.eco.population;
  ticks += live.eco.tick;
} else seeded = live.seedFounders(founders, mulberry32(seed), copies);
const buildMs = performance.now() - tBuild;
if (values.fixed) {
  if (values.load) live.eco.retune({ eco: { maxPopulation: seeded, birthReserve: 0 } });
  else { config.eco.maxPopulation = seeded; config.eco.birthReserve = 0; }
}
const eco = live.eco;
const prof = values.profile ? new PhaseTimer() : null;
eco.profile = prof;

if (values.reach) reach("start");
const population: number[] = [eco.population];
const ecoWindows: object[] = [];
const minuteTicks = Math.max(1, Math.round(60 / dt));
const sampleTicks = Math.max(1, Math.round(5 / dt)); // speed, turn and energy are sampled every 5 simulated seconds
let wLast = { births: 0, deaths: 0, food: 0, poison: 0 };
let wSum = { speed: 0, turn: 0, energy: 0, n: 0, lifeS: 0, died: 0 };
eco.onDeath = (m) => { wSum.lifeS += m.ageTicks * dt; wSum.died++; };
function ecoWindow(): void {
  const mins = (eco.tick - (ecoWindows.length * minuteTicks)) / minuteTicks;
  const n = Math.max(1, wSum.n);
  ecoWindows.push({
    min: ecoWindows.length + 1, pop: eco.population, births: Math.round((eco.births - wLast.births) / mins), deaths: Math.round((eco.deaths - wLast.deaths) / mins),
    foodEaten: Math.round((eco.foodEaten - wLast.food) / mins), poisonEaten: Math.round((eco.poisonEaten - wLast.poison) / mins),
    foodItems: eco.food, poisonItems: eco.poison, meanSpeed: +(wSum.speed / n).toFixed(2), meanAbsTurn: +(wSum.turn / n).toFixed(3), meanEnergy: +(wSum.energy / n).toFixed(1),
    meanLifespanS: +(wSum.lifeS / Math.max(1, wSum.died)).toFixed(1),
  });
  wLast = { births: eco.births, deaths: eco.deaths, food: eco.foodEaten, poison: eco.poisonEaten };
  wSum = { speed: 0, turn: 0, energy: 0, n: 0, lifeS: 0, died: 0 };
}
function ecoSample(): void {
  for (const m of eco.members) {
    const s = m.creature.state;
    wSum.speed += Math.hypot(s.vx, s.vy);
    wSum.turn += Math.abs(s.turnRate);
    wSum.energy += s.energy;
    wSum.n++;
  }
}
const warm = eco.tick + Math.floor((ticks - eco.tick) / 4);
let frameBytes = 0;
let frameMs = 0;
let steadyCreatureTicks = 0;
let creatureTicks = 0;
const saveEvery = values.save ? Math.max(1, Math.round(Number(values.save) / dt)) : 0;
const saveDir = saveEvery ? (values.keep ?? mkdtempSync(join(tmpdir(), "liveBench-save-"))) : "";
const saves = saveEvery ? new Saves(live, new StateStore(saveDir)) : null;
const saveRuns: { tick: number; blockMs: number; cpuMs: number; maxBlockMs: number; wallMs: number; line: string }[] = [];
type SaveRun = { tick: number; blockMs: number; cpuMs: number; maxBlockMs: number; t0: number; done: string | null };
let saving: SaveRun | null = null;
// One yield to the event loop, timing what the save does on this thread meanwhile (its continuations run inside the await).
async function saveStep(waitMs = -1): Promise<void> {
  const b0 = performance.now();
  const c0 = process.threadCpuUsage();
  await new Promise((r) => (waitMs < 0 ? setImmediate(r) : setTimeout(r, waitMs)));
  const b = performance.now() - b0;
  const c = process.threadCpuUsage(c0);
  const run = saving!;
  run.blockMs += b;
  run.cpuMs += (c.user + c.system) / 1000;
  run.maxBlockMs = Math.max(run.maxBlockMs, b);
  if (run.done === null) return;
  saveRuns.push({ tick: run.tick, blockMs: Math.round(run.blockMs), cpuMs: Math.round(run.cpuMs), maxBlockMs: Math.round(run.maxBlockMs), wallMs: Math.round(performance.now() - run.t0), line: run.done });
  saving = null;
}
const winTicks = values.profileEvery ? Math.max(1, Math.round(Number(values.profileEvery) / dt)) : 0;
let winSnap = new Map<string, number>();
let winCpu = process.cpuUsage();
let winPop = 0;
const windows: object[] = [];
const t0 = performance.now();
let tWarm = t0;
let cpuWarm = process.cpuUsage();
while (eco.tick < ticks && !eco.extinct) {
  if (eco.tick === warm) { tWarm = performance.now(); cpuWarm = process.cpuUsage(); if (!winTicks) prof?.reset(); frameBytes = 0; frameMs = 0; }
  creatureTicks += eco.population;
  if (eco.tick >= warm) steadyCreatureTicks += eco.population;
  if (threads > 0) await live.tick();
  else live.step();
  if (values.frames && eco.tick % frameEvery === 0) {
    const f0 = performance.now();
    if (!values.idle) frameBytes += live.creatureFrame().length;
    frameBytes += live.takeDelta()?.length ?? 0;
    frameMs += performance.now() - f0;
  }
  if (values.frames && eco.tick % statsEvery === 0) {
    const f0 = performance.now();
    live.stats(values.idle ? 0 : 1);
    frameMs += performance.now() - f0;
  }
  winPop += eco.population;
  if (winTicks && eco.tick % winTicks === 0) {
    const c = process.cpuUsage(winCpu);
    const k = 1000 / (winPop / winTicks); // ms per tick per 1000 creatures
    const ph = prof ? Object.fromEntries([...prof.ms].map(([n, v]) => [n, +(((v - (winSnap.get(n) ?? 0)) / winTicks) * k).toFixed(3)])) : {};
    windows.push({ toSec: Math.round(eco.tick * dt), pop: Math.round(winPop / winTicks), weightsPerCreature: Math.round(eco.weights / Math.max(1, eco.population)), food: eco.food, poison: eco.poison, cpuMsPerKilo: +(c.user / 1000 / winTicks * k).toFixed(3), phasesPerKilo: ph });
    if (prof) winSnap = new Map(prof.ms);
    winCpu = process.cpuUsage();
    winPop = 0;
  }
  if (eco.tick % sampleTicks === 0) ecoSample();
  if (eco.tick % minuteTicks === 0) ecoWindow();
  if (eco.tick % every === 0) population.push(eco.population);
  if (saves && !saving && eco.tick % saveEvery === 0) {
    const run: SaveRun = { tick: eco.tick, blockMs: 0, cpuMs: 0, maxBlockMs: 0, t0: performance.now(), done: null };
    saving = run;
    void saves.save().then((l) => { run.done = l; }, (e: unknown) => { run.done = String(e); });
  }
  if (saving) await saveStep(); // with a save running, yield between ticks
}
while (saving) await saveStep(10); // the last save finishes before the numbers, without spinning this thread (its blockMs then counts the waits)
if (saveDir && !values.keep) rmSync(saveDir, { recursive: true, force: true });
if (values.reach) reach("end");
const t1 = performance.now();
const steadyTicks = Math.max(1, eco.tick - warm);
const cpu = process.cpuUsage(cpuWarm);
const steadyPop = steadyCreatureTicks / steadyTicks;
const perTick = prof ? [...prof.ms].map(([k, v]) => [k, +(v / steadyTicks).toFixed(3)] as const) : [];
console.log(JSON.stringify({
  seed,
  seconds,
  threads,
  thinkEvery: config.eco.thinkEvery,
  founders: founders.map((f) => f.id),
  copies,
  seeded,
  buildMs: Math.round(buildMs),
  ticks: eco.tick,
  wallSeconds: +((t1 - t0) / 1000).toFixed(2),
  cpuMsPerTick: +(cpu.user / 1000 / steadyTicks).toFixed(3), // user CPU per steady tick: the number to compare
  cpuMsPerKilo: +((cpu.user / 1000 / steadyTicks) * 1000 / Math.max(1, steadyPop)).toFixed(3), // per 1000 creatures of the steady population
  sysMsPerTick: +(cpu.system / 1000 / steadyTicks).toFixed(3),
  steadyMsPerTick: +((t1 - tWarm) / steadyTicks).toFixed(2),
  steadyPopulation: Math.round(steadyPop),
  meanPopulation: Math.round(creatureTicks / Math.max(1, eco.tick)),
  speedAchieved: +((steadyTicks * dt * 1000) / (t1 - tWarm)).toFixed(2), // simulated seconds per wall second with no pacing (the set speed is LIVE.speed)
  ...(values.frames ? { frameMsPerTick: +(frameMs / steadyTicks).toFixed(3), frameKBPerSecond: Math.round(frameBytes / 1024 / (steadyTicks * dt)) } : {}),
  peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  births: eco.births,
  deaths: eco.deaths,
  food: eco.food,
  poison: eco.poison,
  population,
  ...(saves ? { saves: saveRuns } : {}),
  ...(winTicks ? { windows } : {}),
  dt,
  memoryRates: [config.brain.shortRate, config.brain.longRate],
  ecoWindows,
  fingerprint: eco.fingerprint(),
  ...(prof ? { phasesTotalMs: +perTick.reduce((a, [, v]) => a + v, 0).toFixed(3), phases: Object.fromEntries(perTick) } : {}),
}));
live.close();
