// The selected creature on the wire (Live World protocol, see protocol.ts), decoded into the Ecosystem's SelectedDetails so its panels draw it as is.
//
// DETAIL (3): u8 type | u32 tick | u32 id | u8 alive | when alive:
//   f32 x | f32 y | f32 heading | f32 energy | f32 age | u32 children | u32 eaten | u32 depth | i32 parentId | u32 founderId | u8 founderPool
//   | u16 founderHue | u16 hue | f32 upkeep | f32 drain | f32 birthEnergy | f32 birthCost | f32 birthCooldown
//   | plan: u8 rayCount | f32 raySpread | f32 rayLength | u8 layers | layers x u8 neurons | u8 memoryShort | u8 memoryLong
//   | rayCount x (u8 kind | u16 closeness | u16 offset) | u16 inputs | inputs x i16
//   hues: 0..65535 over 360 degrees. closeness: 0..65535 over 0..1. offset: 0..65535 over -pi..pi. inputs: units of 1/INPUT_SCALE.
//   A creature that has died is sent once with alive 0 and nothing after, then the server stops.
// GENOME (4): u8 type | u32 id | u32 n | f32 scale | n x i16, weight = value * scale. Once per selection, when the viewer's detail allowance has room.

import { genomeLength } from "../sim/brain.ts";
import { PLAN_LIMITS } from "../sim/rl/validate.ts";
import type { BodyPlan, PlanView } from "../sim/sensors.ts";
import type { SelectedDetails } from "../worker/ecoProtocol.ts";
import { MSG_DETAIL, MSG_GENOME, q16, unq16 } from "./protocol.ts";

export const INPUT_SCALE = 4096; // inputs are sent to 1/4096 and clamped to about +-8
export const RAY_FEATURES = 6; // closeness, food, poison, wall, creature, seen energy (one species)
const EXTRA_INPUTS = 4;
const OUTPUTS = 2;
const L = PLAN_LIMITS;
export const MAX_INPUTS = L.rayCount[1] * RAY_FEATURES + EXTRA_INPUTS + 2 * L.memory[1];
export const MAX_GENOME = genomeLength([MAX_INPUTS, ...Array<number>(L.layers[1]).fill(L.neurons[1]), OUTPUTS + 2 * L.memory[1]]);
export const genomeBytes = (n: number): number => 13 + 2 * n;
const FIXED = 10 + 4 * 5 + 4 * 5 + 1 + 4 + 4 * 5 + 1 + 8 + 3 + 2; // header, five f32, five u32, pool, hues, five f32, plan scalars, memory, input count
export const MAX_DETAIL_BYTES = FIXED + L.layers[1] + 5 * L.rayCount[1] + 2 * MAX_INPUTS;

// What the server reads off a living creature.
export interface DetailSource {
  x: number;
  y: number;
  heading: number;
  energy: number;
  age: number;
  children: number;
  eaten: number;
  depth: number;
  parentId: number;
  founderId: number;
  founderPool: boolean;
  founderHue: number;
  hue: number;
  upkeep: number;
  drain: number;
  birthEnergy: number;
  birthCost: number;
  birthCooldown: number;
  plan: PlanView;
  rayKinds: ArrayLike<number>;
  rayCloseness: ArrayLike<number>;
  rayOffsets: ArrayLike<number>;
  inputs: ArrayLike<number>;
}

const TAU = 2 * Math.PI;
const hue16 = (h: number): number => q16(((h % 360) + 360) % 360, 360);
const u32 = (v: number): number => (Number.isFinite(v) ? Math.min(0xffffffff, Math.max(0, Math.round(v))) : 0);
const f32 = (v: number): number => (Number.isFinite(v) ? v : 0);

export function encodeDetail(tick: number, id: number, d: DetailSource | null): Uint8Array {
  if (!d) {
    const out = new Uint8Array(10);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, MSG_DETAIL);
    dv.setUint32(1, tick, true);
    dv.setUint32(5, id, true);
    return out;
  }
  const plan = d.plan;
  const rays = Math.min(plan.rayCount, d.rayKinds.length, L.rayCount[1]);
  const layers = Math.min(plan.hiddenLayers.length, L.layers[1]);
  const inputs = Math.min(d.inputs.length, MAX_INPUTS);
  const out = new Uint8Array(FIXED + layers + 5 * rays + 2 * inputs);
  const dv = new DataView(out.buffer);
  let p = 0;
  const u8 = (v: number): void => void dv.setUint8(p++, v);
  const u16 = (v: number): void => { dv.setUint16(p, v, true); p += 2; };
  const w32 = (v: number): void => { dv.setUint32(p, v, true); p += 4; };
  const fl = (v: number): void => { dv.setFloat32(p, f32(v), true); p += 4; };
  u8(MSG_DETAIL);
  w32(tick);
  w32(id);
  u8(1);
  fl(d.x); fl(d.y); fl(d.heading); fl(d.energy); fl(d.age);
  w32(u32(d.children)); w32(u32(d.eaten)); w32(u32(d.depth));
  dv.setInt32(p, Number.isSafeInteger(d.parentId) ? Math.max(-1, Math.min(0x7fffffff, d.parentId)) : -1, true); p += 4;
  w32(u32(d.founderId));
  u8(d.founderPool ? 1 : 0);
  u16(hue16(d.founderHue)); u16(hue16(d.hue));
  fl(d.upkeep); fl(d.drain); fl(d.birthEnergy); fl(d.birthCost); fl(d.birthCooldown);
  u8(rays); fl(plan.raySpread); fl(plan.rayLength);
  u8(layers);
  for (let i = 0; i < layers; i++) u8(Math.min(255, plan.hiddenLayers[i]!));
  u8(Math.min(255, plan.memoryShort)); u8(Math.min(255, plan.memoryLong));
  for (let i = 0; i < rays; i++) {
    u8(d.rayKinds[i]!);
    u16(q16(Math.min(1, Math.max(0, f32(d.rayCloseness[i]!))), 1));
    u16(q16(Math.min(Math.PI, Math.max(-Math.PI, f32(d.rayOffsets[i]!))) + Math.PI, TAU));
  }
  u16(inputs);
  for (let i = 0; i < inputs; i++) {
    dv.setInt16(p, Math.max(-32767, Math.min(32767, Math.round(f32(d.inputs[i]!) * INPUT_SCALE))), true);
    p += 2;
  }
  return out;
}

export interface Detail {
  tick: number;
  id: number;
  details: SelectedDetails; // alive false once it has died; genome always null, it comes in its own message
}

const range = (v: number, [lo, hi]: readonly [number, number]): boolean => Number.isInteger(v) && v >= lo && v <= hi;

// Checks every count against the plan limits; throws on anything malformed.
export function decodeDetail(buf: ArrayBuffer | Uint8Array): Detail {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 10 || dv.getUint8(0) !== MSG_DETAIL || dv.byteLength > MAX_DETAIL_BYTES) throw new Error("not a detail");
  const tick = dv.getUint32(1, true);
  const id = dv.getUint32(5, true);
  const empty = { rayKinds: new Uint8Array(0), rayCloseness: new Float32Array(0), rayEnergy: new Float32Array(0), rayOffsets: new Float32Array(0), inputs: new Float32Array(0) };
  if (dv.getUint8(9) === 0) {
    if (dv.byteLength !== 10) throw new Error("bad detail size");
    const plan: BodyPlan = { rayCount: 0, raySpread: 0, rayLength: 0, hiddenLayers: [], memoryShort: 0, memoryLong: 0 };
    return { tick, id, details: { id, alive: false, x: 0, y: 0, heading: 0, energy: 0, age: 0, children: 0, eaten: 0, kills: 0, species: 0, depth: 0, parentId: -1, hue: 0, founderId: -1, founderPool: false, founderHue: 0, plan, upkeep: 0, drain: 0, birthEnergy: 0, birthCost: 0, birthCooldown: 0, ...empty, genome: null } };
  }
  let p = 10;
  const need = (n: number): void => {
    if (p + n > dv.byteLength) throw new Error("truncated detail");
  };
  const u8 = (): number => { need(1); return dv.getUint8(p++); };
  const u16 = (): number => { need(2); const v = dv.getUint16(p, true); p += 2; return v; };
  const r32 = (): number => { need(4); const v = dv.getUint32(p, true); p += 4; return v; };
  const fl = (): number => {
    need(4);
    const v = dv.getFloat32(p, true);
    p += 4;
    if (!Number.isFinite(v)) throw new Error("bad detail number");
    return v;
  };
  const x = fl(), y = fl(), heading = fl(), energy = fl(), age = fl();
  const children = r32(), eaten = r32(), depth = r32();
  need(4);
  const parentId = dv.getInt32(p, true);
  p += 4;
  const founderId = r32();
  const founderPool = u8() === 1;
  const founderHue = unq16(u16(), 360), hue = unq16(u16(), 360);
  const upkeep = fl(), drain = fl(), birthEnergy = fl(), birthCost = fl(), birthCooldown = fl();
  const rayCount = u8(), raySpread = fl(), rayLength = fl();
  const layers = u8();
  if (!range(rayCount, L.rayCount) || !range(layers, L.layers)) throw new Error("bad detail plan");
  const hiddenLayers: number[] = [];
  for (let i = 0; i < layers; i++) hiddenLayers.push(u8());
  const memoryShort = u8(), memoryLong = u8();
  if (!hiddenLayers.every((n) => range(n, L.neurons)) || !range(memoryShort, L.memory) || !range(memoryLong, L.memory)) throw new Error("bad detail plan");
  if (raySpread < 0 || raySpread > TAU + 1e-6 || rayLength < 0 || rayLength > L.rayLength[1]) throw new Error("bad detail plan");
  const rayKinds = new Uint8Array(rayCount);
  const rayCloseness = new Float32Array(rayCount);
  const rayOffsets = new Float32Array(rayCount);
  for (let i = 0; i < rayCount; i++) {
    const k = u8();
    if (k > 4) throw new Error("bad ray kind");
    rayKinds[i] = k;
    rayCloseness[i] = unq16(u16(), 1);
    rayOffsets[i] = unq16(u16(), TAU) - Math.PI;
  }
  const n = u16();
  if (n !== rayCount * RAY_FEATURES + EXTRA_INPUTS + memoryShort + memoryLong) throw new Error("bad detail inputs");
  const inputs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    need(2);
    inputs[i] = dv.getInt16(p, true) / INPUT_SCALE;
    p += 2;
  }
  if (p !== dv.byteLength) throw new Error("bad detail size");
  const plan: BodyPlan = { rayCount, raySpread, rayLength, hiddenLayers, memoryShort, memoryLong };
  return {
    tick,
    id,
    details: { id, alive: true, x, y, heading, energy, age, children, eaten, kills: 0, species: 0, depth, parentId, hue, founderId, founderPool, founderHue, plan, upkeep, drain, birthEnergy, birthCost, birthCooldown, rayKinds, rayCloseness, rayEnergy: new Float32Array(rayCount), rayOffsets, inputs, genome: null },
  };
}

export function encodeGenome(id: number, g: ArrayLike<number>): Uint8Array {
  const n = Math.min(g.length, MAX_GENOME);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(f32(g[i]!)));
  const scale = peak > 0 ? peak / 32767 : 1;
  const out = new Uint8Array(genomeBytes(n));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MSG_GENOME);
  dv.setUint32(1, id, true);
  dv.setUint32(5, n, true);
  dv.setFloat32(9, scale, true);
  for (let i = 0; i < n; i++) dv.setInt16(13 + 2 * i, Math.round(f32(g[i]!) / scale), true);
  return out;
}

export function decodeGenome(buf: ArrayBuffer | Uint8Array): { id: number; genome: Float32Array } {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 13 || dv.getUint8(0) !== MSG_GENOME) throw new Error("not a genome");
  const n = dv.getUint32(5, true);
  const scale = dv.getFloat32(9, true);
  if (n > MAX_GENOME || dv.byteLength !== genomeBytes(n) || !Number.isFinite(scale) || scale <= 0) throw new Error("bad genome");
  const genome = new Float32Array(n);
  for (let i = 0; i < n; i++) genome[i] = dv.getInt16(13 + 2 * i, true) * scale;
  return { id: dv.getUint32(1, true), genome };
}
