// Scratch (idea 131): the server's real loops (runTicks, startPublic) with N loopback viewers; CPU per second of the pieces. Usage: node src/fpViewers.ts <viewers> [select] [--only juggernaut --copies 4900]
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { LIMITS, liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld, runTicks } from "./liveWorld.ts";
import { startPublic } from "./public.ts";
import { PhaseTimer } from "../../src/typescript/src/sim/profile.ts";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { copies: { type: "string", default: "800" }, only: { type: "string" }, warm: { type: "string", default: "15" }, measure: { type: "string", default: "40" } } });
const nViewers = Number(positionals[0] ?? 0), select = positionals[1] === "select";
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const config = structuredClone(liveConfig);
config.seed = 1;
let founders = loadFounders(fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)));
if (values.only) founders = founders.filter((f) => values.only!.split(",").includes(f.id));
const live = new LiveWorld(config, null, null);
live.seedFounders(founders, mulberry32(1), Number(values.copies));
const cpu = (): number => { const c = process.threadCpuUsage(); return (c.user + c.system) / 1000; };
const acc: Record<string, { ms: number; n: number }> = {};
function wrap<T extends object>(obj: T, name: string, label: string): void {
  const o = (obj as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
  (obj as Record<string, unknown>)[name] = function (this: unknown, ...a: unknown[]) { const c0 = cpu(); try { return o.apply(this, a); } finally { const e = (acc[label] ??= { ms: 0, n: 0 }); e.ms += cpu() - c0; e.n++; } };
}
for (const [m, l] of [["creatureFrame", "creatureFrame"], ["takeDelta", "takeDelta"], ["stats", "stats"], ["itemsFrame", "itemsFrame"], ["refreshWatched", "refreshWatched"], ["detail", "detail"], ["genome", "genome"], ["hello", "hello"]] as const) wrap(live, m, l);
wrap(WebSocket.prototype, "send", "ws.send (sync part)");
const port = 18700 + Math.floor(Math.random() * 200);
const pub = startPublic("127.0.0.1", port, live, LIMITS);
runTicks(live, 50, (why) => { console.error(why); process.exit(1); });
const kids = nViewers > 0 ? spawn("node", ["src/fpClients.ts", String(port), String(nViewers), String(Number(values.warm) + Number(values.measure) + 3), ...(select ? ["select"] : [])], { stdio: ["ignore", "pipe", "inherit"] }) : null;
let kidOut = "";
kids?.stdout!.on("data", (d: Buffer) => (kidOut += d));
await new Promise((r) => setTimeout(r, Number(values.warm) * 1000));
for (const k in acc) delete acc[k];
const prof = process.env.PROFILE ? new PhaseTimer() : null;
if (prof) live.eco.profile = prof;
const c0 = process.cpuUsage(), t0 = performance.now(), tick0 = live.eco.tick, s0 = pub.sentBytes();
await new Promise((r) => setTimeout(r, Number(values.measure) * 1000));
const c1 = process.cpuUsage(c0), wall = (performance.now() - t0) / 1000, ticks = live.eco.tick - tick0, s1 = pub.sentBytes();
const perS: Record<string, string> = {};
for (const [k, v] of Object.entries(acc)) perS[k] = `${(v.ms / wall).toFixed(1)} ms/s, ${v.n} calls, ${(v.ms / Math.max(1, v.n)).toFixed(3)} ms/call`;
console.log(JSON.stringify({ viewers: pub.viewers(), select, population: live.eco.population, ticksPerS: +(ticks / wall).toFixed(1), userMsPerTick: +(c1.user / 1000 / ticks).toFixed(3), sysMsPerTick: +(c1.system / 1000 / ticks).toFixed(3), cpuMsPerWallS: +((c1.user + c1.system) / 1000 / wall).toFixed(0), sentKBps: { frames: Math.round((s1.frames - s0.frames) / 1024 / wall), items: Math.round((s1.items - s0.items) / 1024 / wall), details: Math.round((s1.details - s0.details) / 1024 / wall), text: Math.round((s1.text - s0.text) / 1024 / wall) }, perSecond: perS, ...(prof ? { phasesPerTick: Object.fromEntries([...prof.ms].map(([k, v]) => [k, +(v / ticks).toFixed(3)])) } : {}) }, null, 1));
kids?.kill();
pub.close();
live.close();
process.exit(0);
