// Scratch (idea 131): upper bounds. Fused JS creature frame (byte-equal check), offer-loop threshold pass, namedTop memo. Usage: node src/fpProbe.ts
import { fileURLToPath } from "node:url";
import { liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import { LiveWorld } from "./liveWorld.ts";
import { namedTop } from "./chronicle.ts";
import { CREATURE_HEADER, CREATURE_RECORD, MAX_AGE_S, MAX_ID, creatureFrameBytes, MSG_CREATURES, LINEAGE_TOP, RECORD_BOARDS, MAX_RECORDS } from "../../src/typescript/src/live/protocol.ts";
import { wireName } from "../../src/typescript/src/live/add.ts";
import { fullEnergy } from "../../src/typescript/src/sim/species.ts";
import { wrapAngle } from "../../src/typescript/src/sim/angle.ts";
import { boardValue } from "../../src/typescript/src/sim/leaderboard.ts";
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const config = structuredClone(liveConfig);
config.seed = 1;
const founders = loadFounders(fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)));
const live = new LiveWorld(config, null, null);
live.seedFounders(founders, mulberry32(1), 800);
const eco = live.eco;
for (let k = 0; k < 900; k++) live.step();
const U16 = 65535, TAU = 2 * Math.PI, fr = Math.fround;
const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
const q16 = (v: number, span: number): number => clamp(Math.round((v / span) * U16), U16);
const W = config.world.width, H = config.world.height, FE = fullEnergy(config.eco), dt = config.dt;
const radius = clamp(Math.round(config.creature.radius * 4), 255);
function fused(): Uint8Array {
  const n = eco.members.length;
  const out = new Uint8Array(creatureFrameBytes(n));
  out[0] = MSG_CREATURES;
  const tick = eco.tick;
  out[1] = tick & 255; out[2] = (tick >>> 8) & 255; out[3] = (tick >>> 16) & 255; out[4] = (tick >>> 24) & 255;
  out[5] = n & 255; out[6] = (n >>> 8) & 255; out[7] = (n >>> 16) & 255; out[8] = (n >>> 24) & 255;
  const members = eco.members, states = (eco as unknown as { table: { states: { x: number; y: number; heading: number; energy: number; ticksAlive: number }[] } }).table.states;
  for (let i = 0, o = CREATURE_HEADER; i < n; i++, o += CREATURE_RECORD) {
    const m = members[i]!, s = states[i]!;
    const id = m.id | 0;
    out[o] = id & 255; out[o + 1] = (id >>> 8) & 255; out[o + 2] = (id >>> 16) & 255; out[o + 3] = (id >>> 24) & 255;
    const x = q16(fr(s.x), W); out[o + 4] = x & 255; out[o + 5] = x >>> 8;
    const y = q16(fr(s.y), H); out[o + 6] = y & 255; out[o + 7] = y >>> 8;
    const h = q16((((fr(wrapAngle(s.heading)) % TAU) + TAU) % TAU), TAU); out[o + 8] = h & 255; out[o + 9] = h >>> 8;
    out[o + 10] = radius;
    out[o + 11] = clamp(Math.round((fr(s.energy) / FE) * 255), 255);
    out[o + 12] = clamp(Math.floor(fr(s.ticksAlive * dt)), MAX_AGE_S);
    const hu = q16(fr(m.hue) % 360, 360); out[o + 13] = hu & 255; out[o + 14] = hu >>> 8;
    const f = clamp(m.founderId | 0, MAX_ID); out[o + 15] = f & 255; out[o + 16] = (f >>> 8) & 255; out[o + 17] = (f >>> 16) & 255; out[o + 18] = (f >>> 24) & 255;
  }
  return out;
}
function fused2(): Uint8Array {
  const n = eco.members.length;
  const out = new Uint8Array(creatureFrameBytes(n));
  out[0] = MSG_CREATURES;
  const tick = eco.tick;
  out[1] = tick & 255; out[2] = (tick >>> 8) & 255; out[3] = (tick >>> 16) & 255; out[4] = (tick >>> 24) & 255;
  out[5] = n & 255; out[6] = (n >>> 8) & 255; out[7] = (n >>> 16) & 255; out[8] = (n >>> 24) & 255;
  const members = eco.members, states = (eco as unknown as { table: { states: { x: number; y: number; heading: number; energy: number; ticksAlive: number }[] } }).table.states;
  
  for (let i = 0, o = CREATURE_HEADER; i < n; i++, o += CREATURE_RECORD) {
    const m = members[i]!, s = states[i]!;
    const id = m.id | 0;
    out[o] = id & 255; out[o + 1] = (id >>> 8) & 255; out[o + 2] = (id >>> 16) & 255; out[o + 3] = (id >>> 24) & 255;
    const x = q16(fr(s.x), W); out[o + 4] = x & 255; out[o + 5] = x >>> 8;
    const y = q16(fr(s.y), H); out[o + 6] = y & 255; out[o + 7] = y >>> 8;
    let v = fr(wrapAngle(s.heading));
    if (v > -TAU && v < TAU) { if (v < 0) { v += TAU; } else { v += TAU; } if (v >= TAU) v -= TAU; } else v = ((v % TAU) + TAU) % TAU;
    const h = q16(v, TAU); out[o + 8] = h & 255; out[o + 9] = h >>> 8;
    out[o + 10] = radius;
    out[o + 11] = clamp(Math.round((fr(s.energy) / FE) * 255), 255);
    out[o + 12] = clamp(Math.floor(fr(s.ticksAlive * dt)), MAX_AGE_S);
    const hf = fr(m.hue);
    const hu = q16(hf >= 0 && hf < 360 ? hf : hf % 360, 360); out[o + 13] = hu & 255; out[o + 14] = hu >>> 8;
    const f = clamp(m.founderId | 0, MAX_ID); out[o + 15] = f & 255; out[o + 16] = (f >>> 8) & 255; out[o + 17] = (f >>> 16) & 255; out[o + 18] = (f >>> 24) & 255;
  }
  return out;
}
import { F } from "../../src/typescript/src/sim/wasm/resident.ts";
const rr = (eco as unknown as { residentRows(): { store: { f64: Float64Array }; rowAt: Int32Array } | null }).residentRows();
function fused3(): Uint8Array {
  const n = eco.members.length;
  const out = new Uint8Array(creatureFrameBytes(n));
  out[0] = MSG_CREATURES;
  const tick = eco.tick;
  out[1] = tick & 255; out[2] = (tick >>> 8) & 255; out[3] = (tick >>> 16) & 255; out[4] = (tick >>> 24) & 255;
  out[5] = n & 255; out[6] = (n >>> 8) & 255; out[7] = (n >>> 16) & 255; out[8] = (n >>> 24) & 255;
  const members = eco.members, f64 = rr!.store.f64, rowAt = rr!.rowAt;
  for (let i = 0, o = CREATURE_HEADER; i < n; i++, o += CREATURE_RECORD) {
    const m = members[i]!, r = rowAt[i]!;
    const id = m.id | 0;
    out[o] = id & 255; out[o + 1] = (id >>> 8) & 255; out[o + 2] = (id >>> 16) & 255; out[o + 3] = (id >>> 24) & 255;
    const x = q16(fr(f64[r + F.x]!), W); out[o + 4] = x & 255; out[o + 5] = x >>> 8;
    const y = q16(fr(f64[r + F.y]!), H); out[o + 6] = y & 255; out[o + 7] = y >>> 8;
    let v = fr(wrapAngle(f64[r + F.heading]!));
    if (v > -TAU && v < TAU) { v += TAU; if (v >= TAU) v -= TAU; } else v = ((v % TAU) + TAU) % TAU;
    const h = q16(v, TAU); out[o + 8] = h & 255; out[o + 9] = h >>> 8;
    out[o + 10] = radius;
    out[o + 11] = clamp(Math.round((fr(f64[r + F.energy]!) / FE) * 255), 255);
    out[o + 12] = clamp(Math.floor(fr(f64[r + F.ticks]! * dt)), MAX_AGE_S);
    const hf = fr(m.hue);
    const hu = q16(hf >= 0 && hf < 360 ? hf : hf % 360, 360); out[o + 13] = hu & 255; out[o + 14] = hu >>> 8;
    const f = clamp(m.founderId | 0, MAX_ID); out[o + 15] = f & 255; out[o + 16] = (f >>> 8) & 255; out[o + 17] = (f >>> 16) & 255; out[o + 18] = (f >>> 24) & 255;
  }
  return out;
}
const ref = live.creatureFrame(), mine = fused(), mine2 = fused2(), mine3 = fused3();
let diff3 = 0;
for (let i = 0; i < ref.length; i++) if (ref[i] !== mine3[i]) diff3++;
console.log(JSON.stringify({ diff3, resident: !!rr }));
let diff2 = 0;
for (let i = 0; i < ref.length; i++) if (ref[i] !== mine2[i]) diff2++;
console.log(JSON.stringify({ diff2 }));
let diff = 0;
for (let i = 0; i < ref.length; i++) if (ref[i] !== mine[i]) diff++;
console.log(JSON.stringify({ n: eco.members.length, bytes: ref.length, differingBytes: diff }));
const bench = (name: string, fn: () => unknown, reps = 200): void => {
  for (let i = 0; i < 40; i++) fn();
  const ws: number[] = [];
  const c0 = process.threadCpuUsage();
  for (let i = 0; i < reps; i++) { const t0 = performance.now(); fn(); ws.push(performance.now() - t0); }
  const c = process.threadCpuUsage(c0);
  ws.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, wallMedMs: +ws[reps >> 1]!.toFixed(3), wallMinMs: +ws[0]!.toFixed(3), cpuMeanMs: +(((c.user + c.system) / 1000) / reps).toFixed(3) }));
};
bench("creatureFrame (current)", () => live.creatureFrame());
bench("fused JS pass", fused);
bench("fused JS pass, no fmod", fused2);
bench("fused JS pass, rows direct", fused3);
// floor for a gather that still reads one member object per creature (id only)
bench("floor: read m.id, m.founderId, m.hue per member", () => { let a = 0; for (const m of eco.members) a += m.id + m.founderId + m.hue; return a; });
bench("floor: read m.id only (indexed loop)", () => { let a = 0; const ms = eco.members; for (let i = 0; i < ms.length; i++) a += ms[i]!.id; return a; });
// offer loop vs threshold pass
const ch = live as unknown as { chronicle: { offer(e: unknown, m: unknown, a: boolean): void; board: { lists: Map<string, { value: number }[]> } } };
bench("offer loop (current)", () => { for (const m of eco.members) ch.chronicle.offer(eco, m, true); });
const boards = RECORD_BOARDS;
bench("threshold pass (4 boards + best/depth scan fused)", () => {
  const lists = ch.chronicle.board.lists;
  const thr = boards.map((b) => { const l = lists.get(`0:${b}`); return l && l.length >= MAX_RECORDS ? l[l.length - 1]!.value : 0; });
  let slow = 0, depth = 0, bestAge = -1, bestKids = -1, bestKills = -1;
  const ms = eco.members;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]!;
    const a = m.ageTicks * dt, c = m.children, e = m.eaten, k = m.kills + m.bumpKills;
    if (a >= thr[0]! || c >= thr[1]! || e >= thr[2]! || k >= thr[3]!) slow++;
    if (m.depth > depth) depth = m.depth;
    if (m.ageTicks > bestAge) bestAge = m.ageTicks;
    if (c > bestKids) bestKids = c;
    if (k > bestKills) bestKills = k;
  }
  return slow + depth + bestAge + bestKids + bestKills;
});
console.log(JSON.stringify({ boards: boards.slice(), thresholds: boards.map((b) => ch.chronicle.board.lists.get(`0:${b}`)?.map((e) => e.value)) }));
// namedTop with a memo of wireName by raw name
const memo = new Map<string, { name: string; starter: boolean; key: string }>();
function namedTopMemo(k: number): unknown {
  const groups = new Map<string, { founder: number; hue: number; pool: boolean; count: number; name: string; starter: boolean; others: number[] }>();
  eco.lineages.forEachLiving((founder, count, hue, pool) => {
    const raw = eco.lineageName(founder);
    let w = memo.get(raw);
    if (!w) { const p = wireName(raw); memo.set(raw, (w = { ...p, key: p.name ? `${p.starter ? "*" : ""}${p.name.toLowerCase()}` : "" })); }
    const key = w.name ? w.key : `#${founder}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { founder, hue, pool, count, name: w.name, starter: w.starter, others: [] });
    else { g.count += count; if (founder < g.founder) { g.others.push(g.founder); Object.assign(g, { founder, hue, pool, name: w.name }); } else g.others.push(founder); }
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || a.founder - b.founder).slice(0, k);
}
console.log(JSON.stringify({ namedTopEqual: JSON.stringify(namedTop(eco, LINEAGE_TOP)) === JSON.stringify(namedTopMemo(LINEAGE_TOP)), families: eco.lineages.toState().late.length }));
bench("namedTop (current)", () => namedTop(eco, LINEAGE_TOP), 100);
bench("namedTop (memo wireName)", () => namedTopMemo(LINEAGE_TOP), 100);
bench("lineages.forEachLiving only", () => { let a = 0; eco.lineages.forEachLiving((f, c) => { a += f + c; }); return a; }, 100);
void boardValue;
live.close();
