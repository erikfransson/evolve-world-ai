// Live World benchmark: the server's LiveWorld (liveConfig, The Inland Sea) seeded with the live founders, stepped headless on this thread.
// Prints CPU ms per steady tick, the phase profile, peak RSS and a fingerprint (equal runs give equal fingerprints).
// Usage (in server/): node src/liveBench.ts [--seconds 60] [--copies 800] [--seed 1] [--founders ../src/typescript/public/live-founders.json]
//   [--only juggernaut,grazer] [--frames] [--profile] [--every 10] [--think 1]
// --copies: copies of each founder seeded (4 founders x 800 = 3200 creatures, 6 M brain weights, under the birth weight cap).
// --only: seed these founder ids only (so --only juggernaut --copies 4900 fills the 5000 cap with small brains).
// --frames: also encode the creature frame and item delta at the server's 5 Hz (FRAME_MS), as the public loop does for viewers.
// --think: eco.thinkEvery instead of liveConfig's (1 is every tick).
// --profile: CPU ms per engine phase per steady tick (the first quarter of the ticks is warm-up and left out of every steady number).

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { PhaseTimer } from "../../src/typescript/src/sim/profile.ts";
import { LIVE, liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld } from "./liveWorld.ts";
import { FRAME_MS } from "./public.ts";

// parameters
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "60" },
    copies: { type: "string", default: "800" },
    seed: { type: "string", default: "1" },
    founders: { type: "string", default: fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)) },
    only: { type: "string" },
    frames: { type: "boolean" },
    profile: { type: "boolean" },
    every: { type: "string", default: "10" }, // seconds between population samples
    think: { type: "string" },
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
if (values.think) config.eco.thinkEvery = Number(values.think);
let founders = loadFounders(values.founders!);
if (values.only) {
  const ids = new Set(values.only.split(","));
  founders = founders.filter((f) => ids.has(f.id));
  if (founders.length === 0) throw new Error(`no founder matches --only ${values.only}`);
}
const copies = Number(values.copies);
const seconds = Number(values.seconds);
const dt = config.dt;
const ticks = Math.round(seconds / dt);
const every = Math.max(1, Math.round(Number(values.every) / dt));
const frameEvery = Math.max(1, Math.round(FRAME_MS / 1000 / dt * LIVE.speed)); // ticks per frame at the server's set speed

const tBuild = performance.now();
const live = new LiveWorld(config, null, null);
const seeded = live.seedFounders(founders, mulberry32(seed), copies);
const buildMs = performance.now() - tBuild;
const eco = live.eco;
const prof = values.profile ? new PhaseTimer() : null;
eco.profile = prof;

const population: number[] = [eco.population];
const warm = Math.floor(ticks / 4);
let frameBytes = 0;
let frameMs = 0;
let steadyCreatureTicks = 0;
let creatureTicks = 0;
const t0 = performance.now();
let tWarm = t0;
let cpuWarm = process.cpuUsage();
while (eco.tick < ticks && !eco.extinct) {
  if (eco.tick === warm) { tWarm = performance.now(); cpuWarm = process.cpuUsage(); prof?.reset(); frameBytes = 0; frameMs = 0; }
  creatureTicks += eco.population;
  if (eco.tick >= warm) steadyCreatureTicks += eco.population;
  live.step();
  if (values.frames && eco.tick % frameEvery === 0) {
    const f0 = performance.now();
    frameBytes += live.creatureFrame().length;
    frameBytes += live.takeDelta()?.length ?? 0;
    live.stats(1);
    frameMs += performance.now() - f0;
  }
  if (eco.tick % every === 0) population.push(eco.population);
}
const t1 = performance.now();
const steadyTicks = Math.max(1, eco.tick - warm);
const cpu = process.cpuUsage(cpuWarm);
const steadyPop = steadyCreatureTicks / steadyTicks;
const perTick = prof ? [...prof.ms].map(([k, v]) => [k, +(v / steadyTicks).toFixed(3)] as const) : [];
console.log(JSON.stringify({
  seed,
  seconds,
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
  fingerprint: eco.fingerprint(),
  ...(prof ? { phasesTotalMs: +perTick.reduce((a, [, v]) => a + v, 0).toFixed(3), phases: Object.fromEntries(perTick) } : {}),
}));
live.close();
