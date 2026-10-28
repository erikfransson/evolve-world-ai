// Scratch (idea 131): CPU per piece of the viewer frame path, from the bench's world. Usage: node src/fpParts.ts [--copies 800] [--only id] [--seconds 40]
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld } from "./liveWorld.ts";
import { namedTop } from "./chronicle.ts";
import { ItemFeed } from "./itemFeed.ts";
import { FRAME_MS } from "./public.ts";
import { LINEAGE_TOP, encodeCreatures, creatureFrameBytes } from "../../src/typescript/src/live/protocol.ts";
import { fullEnergy } from "../../src/typescript/src/sim/species.ts";
import { boardValue } from "../../src/typescript/src/sim/leaderboard.ts";

const { values } = parseArgs({ options: { copies: { type: "string", default: "800" }, only: { type: "string" }, seconds: { type: "string", default: "40" } } });
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const config = structuredClone(liveConfig);
config.seed = 1;
let founders = loadFounders(fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)));
if (values.only) founders = founders.filter((f) => values.only!.split(",").includes(f.id));
const live = new LiveWorld(config, null, null);
live.seedFounders(founders, mulberry32(1), Number(values.copies));
const eco = live.eco;
const dt = config.dt;
const ticks = Math.round(Number(values.seconds) / dt);
const warm = Math.floor(ticks / 4);
const frameEvery = Math.round(FRAME_MS / 1000 / dt * 3);
const statsEvery = Math.round(3 / dt);
const cpu = (): number => { const c = process.threadCpuUsage(); return (c.user + c.system) / 1000; };
const acc: Record<string, number[]> = {};
const wall: Record<string, number[]> = {};
const t = <T,>(name: string, fn: () => T): T => { const c0 = cpu(); const w0 = performance.now(); const r = fn(); (wall[name] ??= []).push(performance.now() - w0); (acc[name] ??= []).push(cpu() - c0); return r; };
const lw = live as unknown as { frame: unknown; ages: Float32Array; chronicle: { offer(e: unknown, m: unknown, a: boolean): void; board: { snapshot(): unknown } } };
const feed = new ItemFeed();
let frameNo = 0, steadyTicks = 0, cpuStart = 0;
let bytes = 0;
for (let k = 0; k < ticks && !eco.extinct; k++) {
  if (k === warm) { cpuStart = cpu(); steadyTicks = 0; for (const key in acc) { acc[key] = []; wall[key] = []; } }
  const c0 = cpu();
  live.step();
  if (k >= warm) { steadyTicks++; (acc.step ??= []).push(cpu() - c0); }
  if (k % frameEvery === 0 && k >= warm) {
    // creatureFrame in pieces (same code as LiveWorld.creatureFrame)
    const f = t("1 readCreatures", () => (lw.frame = eco.readCreatures(lw.frame as never)));
    const ff = f as ReturnType<typeof eco.readCreatures>;
    t("2 ages (eco.get per creature)", () => { if (lw.ages.length < ff.count) lw.ages = new Float32Array(Math.max(ff.count, 2 * lw.ages.length)); for (let i = 0; i < ff.count; i++) lw.ages[i] = eco.get(ff.ids[i]!)!.ageTicks * config.dt; });
    const bytesOut = t("3 encodeCreatures", () => encodeCreatures(eco.tick, { ...ff, age: lw.ages, radius: config.creature.radius }, config.world, fullEnergy(config.eco)));
    bytes += bytesOut.length;
    t("3b whole creatureFrame()", () => live.creatureFrame());
    const d = t("4 takeDelta", () => live.takeDelta());
    t("5 feed.push + delta()", () => { feed.push(frameNo, d); feed.delta(frameNo - 1, frameNo, () => 1e9); });
    frameNo++;
  }
  if (k % statsEvery === 0 && k >= warm) {
    t("6 stats(1) total", () => live.stats(1));
    const s = t("6a stats(1, records)", () => live.stats(1, true));
    t("6b JSON.stringify(stats)", () => JSON.stringify(s));
    t("7 namedTop", () => namedTop(eco, LINEAGE_TOP));
    t("8 offer loop only (members x offer)", () => { for (const m of eco.members) lw.chronicle.offer(eco, m, true); });
    t("9 best/depth scan only", () => {
      let oldest = null as unknown, parent = null as unknown, killer = null as unknown, kills = 0, depth = 0;
      for (const m of eco.members) { if (!oldest || m.ageTicks > (oldest as typeof m).ageTicks) oldest = m; if (!parent || m.children > (parent as typeof m).children) parent = m; const kv = boardValue(m, "kills"); if (!killer || kv > kills) { killer = m; kills = kv; } if (m.depth > depth) depth = m.depth; }
      return depth;
    });
    t("10 records snapshot", () => lw.chronicle.board.snapshot());
    t("11 itemsFrame (per joining viewer)", () => live.itemsFrame());
  }
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const out: Record<string, unknown> = {};
for (const key of Object.keys(acc).sort()) out[key] = { n: acc[key]!.length, cpuMean: +mean(acc[key]!).toFixed(3), wallMed: +med(wall[key] ?? [0]).toFixed(3), wallMin: +Math.min(...(wall[key] ?? [0])).toFixed(3) };
console.log(JSON.stringify({ steadyTicks, population: eco.population, frameBytes: creatureFrameBytes(eco.population), frameEvery, statsEvery, totalCpuMsPerTick: +((cpu() - cpuStart) / steadyTicks).toFixed(3), parts: out }, null, 1));
live.close();
