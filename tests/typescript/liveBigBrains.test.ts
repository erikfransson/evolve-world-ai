// @vitest-environment node
import { liveConfig } from "../../server/src/config.ts";
import { loadFounders } from "../../server/src/founders.ts";
import type { SeedFounder } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { MAX_ADD_GENOME } from "../../src/typescript/src/live/add.ts";
import { PLAN_LIMITS } from "../../src/typescript/src/sim/rl/validate.ts";

import { smallConfig } from "./liveHelpers.ts";

// With no brain-weight cap a world may fill with the largest brains an add allows. Their tick cost against the shipped founders' is held
// under a ceiling, so a kernel or PLAN_LIMITS change that makes big brains much dearer shows here. CPU time of this thread, so a busy
// host slows both sides alike. LIVE_HEAVY=1 also runs it at the full 5000 on the Inland Sea (about 1.5 GB, a minute or more).
const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const L = PLAN_LIMITS;
let a = 11;
const rnd = (): number => {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const BIG: SeedFounder = {
  id: "big",
  name: "Big",
  plan: { rayCount: L.rayCount[1], raySpread: 1, rayLength: 100, hiddenLayers: Array<number>(L.layers[1]).fill(L.neurons[1]), memoryShort: L.memory[1], memoryLong: L.memory[1] },
  genome: Float32Array.from({ length: MAX_ADD_GENOME }, () => Math.fround(rnd() * 2 - 1)),
};

// CPU ms per tick of `n` creatures of these founders, after a short warm-up.
function msPerTick(founders: readonly SeedFounder[], n: number, full: boolean): number {
  const c = full ? structuredClone(liveConfig) : smallConfig();
  c.eco.initialPopulation = 0;
  c.eco.wasm = true; // the kernels the server runs
  c.eco.birthReserve = 0;
  const live = new LiveWorld(c, null);
  live.seedFounders(founders, rnd, Math.floor(n / founders.length));
  for (let i = 0; i < 10; i++) live.step();
  const ticks = full ? 30 : 60;
  const t0 = process.threadCpuUsage();
  for (let i = 0; i < ticks; i++) live.step();
  const t = process.threadCpuUsage(t0);
  return (t.user + t.system) / 1000 / ticks;
}

describe("a world of the largest brains", () => {
  it("ticks within 2.5x a founders world of the same size", () => {
    const ratio = msPerTick([BIG], 400, false) / msPerTick(FOUNDERS, 400, false);
    console.log(`big / founders ms per tick at 400: ${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThan(2.5); // 1.39 to 1.53 at 400, 1.71 at 5000 (2026-11-05)
  }, 120_000);

  it.runIf(process.env.LIVE_HEAVY === "1")("at 5000 on the Inland Sea, too", () => {
    const ratio = msPerTick([BIG], 5000, true) / msPerTick(FOUNDERS, 4998, true);
    console.log(`big / founders ms per tick at 5000: ${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThan(2.5); // 1.39 to 1.53 at 400, 1.71 at 5000 (2026-11-05)
  }, 900_000);
});
