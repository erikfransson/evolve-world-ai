// Scratch (idea 131): cost of one refreshDetail against its crowd grid rebuild and the findIndex.
import { fileURLToPath } from "node:url";
import { liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld } from "./liveWorld.ts";
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const config = structuredClone(liveConfig);
config.seed = 1;
const live = new LiveWorld(config, null, null);
live.seedFounders(loadFounders(fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url))), mulberry32(1), 800);
const eco = live.eco as unknown as { members: { id: number; creature: { sense(...a: unknown[]): void; encode(): void } }[]; table: { length: number; kinds: Int32Array }; multi: boolean; items: unknown; crowd: unknown; detail: number | null; refreshDetail(): void; gridCrowd(n: number, k?: Int32Array): void };
for (let k = 0; k < 600; k++) live.step();
const bench = (name: string, fn: () => unknown, reps = 300): void => {
  for (let i = 0; i < 30; i++) fn();
  const c0 = process.threadCpuUsage();
  for (let i = 0; i < reps; i++) fn();
  const c = process.threadCpuUsage(c0);
  console.log(JSON.stringify({ name, cpuMeanMs: +(((c.user + c.system) / 1000) / reps).toFixed(3) }));
};
const id = eco.members[1500]!.id;
eco.detail = id;
bench("refreshDetail (whole)", () => eco.refreshDetail());
bench("gridCrowd only", () => eco.gridCrowd(eco.table.length, eco.multi ? eco.table.kinds : undefined));
bench("findIndex only", () => eco.members.findIndex((m) => m.id === id));
const c = eco.members[1500]!.creature;
bench("sense+encode of one creature", () => { c.sense(eco.items, eco.crowd, 1500); c.encode(); });
live.close();
