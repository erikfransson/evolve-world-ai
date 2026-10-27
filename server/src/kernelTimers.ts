// Fixed-population run with CPU timers around the kernel calls and their JS wrappers (docs/perf-explore/intercept.md): what each costs per tick and per call.
// Usage (in server/): node src/kernelTimers.ts [--copies 25] [--ticks 400] [--only juggernaut] [--food 0.1] [--seed 1]
// Wrapper rows (Class.method) include the kernel call and the timers nested in them; "wasm" rows are the raw kernel exports. Each timer adds about 1 us (thread CPU clock), so rows under 10 us per call are upper bounds.
// Births stop at the seeded count, so the population only falls by deaths. The first 100 ticks are warm-up.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld } from "./liveWorld.ts";
import { WasmBrainBank } from "../../src/typescript/src/sim/wasm/brainKernel.ts";
import { WasmCrowd } from "../../src/typescript/src/sim/wasm/crowdKernel.ts";
import { WasmFiller } from "../../src/typescript/src/sim/wasm/fillKernel.ts";
import { WasmMembers } from "../../src/typescript/src/sim/wasm/membersKernel.ts";
import { WasmSenser } from "../../src/typescript/src/sim/wasm/senser.ts";
import { WasmStepper } from "../../src/typescript/src/sim/wasm/stepKernel.ts";
import { ItemEconomy } from "../../src/typescript/src/sim/itemEconomy.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { World } from "../../src/typescript/src/sim/world.ts";

// parameters
const { values } = parseArgs({ options: { copies: { type: "string", default: "25" }, ticks: { type: "string", default: "400" }, only: { type: "string" }, food: { type: "string" }, seed: { type: "string", default: "1" } } });
const warm = 100;

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

const total = new Map<string, [number, number]>(); // label -> [ns, calls]
const now = (): number => { const u = process.threadCpuUsage(); return (u.user + u.system) * 1000; };
const add = (label: string, ns: number): void => {
  const e = total.get(label);
  if (e) { e[0] += ns; e[1]++; } else total.set(label, [ns, 1]);
};
// Replaces obj[name] by a timed copy; the private methods are reached by name from JS.
function wrap(obj: any, name: string, label: string): void {
  const f = obj[name];
  obj[name] = function (this: unknown, ...a: unknown[]) { const t = now(); try { return f.apply(this, a); } finally { add(label, now() - t); } };
}
function wrapExports(owner: any, label: string): void {
  const ex = owner.exports;
  owner.exports = Object.fromEntries(Object.keys(ex).map((k) => [k, (...a: unknown[]) => { const t = now(); const r = ex[k](...a); add(`wasm ${label}.${k}`, now() - t); return r; }]));
}
for (const [cls, names] of [[WasmSenser, ["run", "syncItems", "patchCell"]], [WasmCrowd, ["rebuild", "refresh", "pack", "touch", "bind"]], [WasmFiller, ["fill", "prepare"]], [WasmStepper, ["step"]], [WasmMembers, ["settle", "birthCandidates"]], [WasmBrainBank, ["forwardRun", "runRegion"]], [ItemEconomy, ["regrow"]], [World, ["addRandomly", "removeItem"]], [Ecosystem, ["gridCrowd", "giveBirth", "eat", "prepareTick"]]] as [{ name: string; prototype: object }, string[]][])
  for (const n of names) wrap(cls.prototype, n, `${cls.name}.${n}`);

const config = structuredClone(liveConfig);
config.seed = Number(values.seed);
if (values.food) config.world.foodDensity = Number(values.food);
let founders = loadFounders(fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)));
if (values.only) { const ids = new Set(values.only.split(",")); founders = founders.filter((f) => ids.has(f.id)); }
const live = new LiveWorld(config, null, null);
const seeded = live.seedFounders(founders, mulberry32(config.seed), Number(values.copies));
config.eco.maxPopulation = seeded;
config.eco.birthReserve = 0;
const eco: any = live.eco;
const k = eco.kernels;
wrapExports(k.senser, "sense"); wrapExports(k.filler, "fill"); wrapExports(k.stepper, "step"); wrapExports(eco.wasmCrowd, "crowd"); wrapExports(eco.wasmMembers, "members"); wrapExports(k.brains.kernel, "brain");

const ticks = Number(values.ticks);
let popSum = 0;
let cpu0 = process.cpuUsage();
for (let i = 0; i < warm + ticks; i++) {
  if (i === warm) { total.clear(); cpu0 = process.cpuUsage(); }
  if (i >= warm) popSum += eco.population;
  live.step();
}
const cpu = process.cpuUsage(cpu0);
console.log(`seeded ${seeded} pop ${Math.round(popSum / ticks)} cpuMsPerTick ${(cpu.user / 1000 / ticks).toFixed(3)}`);
for (const [label, [ns, calls]] of [...total].sort()) console.log(`${label.padEnd(32)} ${(ns / 1e6 / ticks).toFixed(4)} ms/tick  ${(calls / ticks).toFixed(2)} calls/tick  ${(ns / calls / 1e3).toFixed(2)} us/call`);
live.close();
