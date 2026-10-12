// Live World wire protocol, shared by server/ and the live/ page. Version 4 (4: founder u32 in CREATURES, names, add; see docs/live-plan.md).
//
// Client to server, text only, at most MAX_CLIENT_MESSAGE_BYTES: "ping", or {"t":"select","id":<integer 0..MAX_ID>|null} (parseClientMessage),
// or an add of at most MAX_ADD_BYTES (live/add.ts). Anything else gets the client cut off.
//
// Server to client, text: JSON objects with a "t" field (Hello, Stats, History, Pong, Busy below; Added, Refused in live/add.ts).

// Server to client, binary: little-endian, the first byte is the type. All x, y are u16 over the world width / height.
//
// CREATURES (1), 5 Hz shared between viewers:  u8 type | u32 tick | u32 count | count x record
//   record, 19 bytes: u32 id | u16 x | u16 y | u16 heading | u8 radius | u8 energy | u8 age | u16 hue | u32 founder
//   heading: 0..65535 over 0..2pi. radius: units of 0.25. energy: 0..255 as a share of Hello.fullEnergy, 255 means full or more.
//   age: whole seconds, capped at 255. hue: 0..65535 over 0..360 degrees. founder: founder id (an added creature founds a lineage with its own id).
// ITEMS (2), a full item set, on connect and when a viewer has fallen too far behind for deltas:
//   u8 type | u32 tick | u32 slots | u32 n | ceil(slots / 4) bytes of 2-bit kinds by slot (0 free, 1 food, 2 poison) | n x (u16 x, u16 y) in slot order
// DELTA (5), item changes and collision events, sent with each creature frame a viewer gets: u8 type | u8 n | n x delta
//   delta, one per server frame since the viewer's last: u32 tick | u16 ops | u8 events | ops | events
//   op: u32 slot (18 bits) | kind << 18 (2 bits, 0 removed, 1 food, 2 poison) | back << 20 (12 bits, ticks before the delta's tick); a placed item adds u16 x, u16 y
//   event, 7 bytes: u8 kind (0 impact, 1 death) | u16 x | u16 y | u16 value (impact: energy lost, death: hue as 0..65535 over 360)
// DETAIL (3), about 5 Hz, only to the viewer that selected the creature: see live/detail.ts.
// GENOME (4), once per selection: see live/detail.ts.
//
// The page applies item changes, events, details, births and deaths when its interpolated tick passes theirs, so the world on
// screen matches the simulation at that tick.

import { HIT_FOOD, HIT_POISON } from "../sim/types.ts";
import type { AddRules, Added, Refused } from "./add.ts";

export const PROTOCOL_VERSION = 4;
export const MSG_CREATURES = 1;
export const MSG_ITEMS = 2;
export const MSG_DETAIL = 3;
export const MSG_GENOME = 4;
export const MSG_DELTA = 5;
export const PING = "ping";
export const CREATURE_HEADER = 9;
export const CREATURE_RECORD = 19;
export const ITEMS_HEADER = 13;
export const FRAME_HZ = 5;
export const MAX_AGE_S = 255; // ages at or above this are sent as this
export const MAX_CLIENT_MESSAGE_BYTES = 256;
export const MAX_ID = 0xffffffff; // ids are u32 on the wire
export const MAX_ITEM_SLOTS = 1 << 18; // slot field of an op
export const MAX_BACK_TICKS = (1 << 12) - 1; // back field of an op
export const MAX_DELTA_OPS = 4096; // per server frame; more and the frame counts as too big, viewers get the full set instead
export const MAX_DELTA_EVENTS = 32; // per server frame, the engine's EVENT_CAP
export const MAX_DELTAS = 32; // per DELTA message; a viewer further behind gets the full set
export const OP_REMOVE = 0;
export const EVENT_BYTES = 7;
export const HISTORY_FIELDS = 3; // time, population, food per population sample
export const LINEAGE_TOP = 8;
export const LINEAGE_FIELDS = 2 + 3 * LINEAGE_TOP; // time, others, then (founder, count, hue) per top lineage; the Ecosystem's LINEAGE_STRIDE
export const MAX_HISTORY = 1080; // population samples kept and sent
export const MAX_LINEAGE_HISTORY = 180;
export const MAX_RECORDS = 3; // per board

export interface WorldSize {
  width: number;
  height: number;
}

export interface Hello {
  t: "hello";
  version: number;
  world: WorldSize;
  radius: number; // creature radius
  itemRadius: number;
  fullEnergy: number; // energy at which a creature's fill is full
  frameHz: number;
  dt: number; // simulated seconds per tick
  itemSlots: number; // item slot capacity, at most MAX_ITEM_SLOTS
  summary: { initialPopulation: number; maxPopulation: number; collisionDamage: boolean; seasons: boolean };
  maxViewers: number;
  add: AddRules | null; // what an add may ask for, null while adding is off
  serverVersion?: string; // the server's release (src/typescript/src/version.ts), may differ from the page's during a deploy
}

export interface Season {
  yearMinutes: number;
  winterFood: number;
}

export interface WireLineage {
  founder: number;
  hue: number;
  pool: boolean;
  count: number;
  name?: string; // the name an added founder was given (letters and digits), absent for none
}

export type RecordBoard = "age" | "children" | "eaten";
export const RECORD_BOARDS: readonly RecordBoard[] = ["age", "children", "eaten"];

export interface WireRecord {
  id: number;
  hue: number;
  value: number; // seconds for age, else a count
  from: number; // sim time of birth
  to: number; // sim time of death, or now while alive
  alive: boolean;
  plan: { rayCount: number; raySpread: number; rayLength: number; hiddenLayers: number[]; memoryShort: number; memoryLong: number };
}

export interface Stats {
  t: "stats";
  tick: number;
  simSeconds: number;
  speed: number; // simulated seconds per real second, as achieved
  population: number;
  births: number;
  deaths: number;
  food: number;
  poison: number;
  viewers: number;
  uptimeS: number; // seconds since the server started
  depth: number; // deepest lineage alive
  season: Season | null; // null when seasons are off
  best: { age: number; children: number } | null; // ids of the oldest living creature and the living one with the most children
  sample?: number[]; // a new population sample, HISTORY_FIELDS numbers
  lineageSample?: number[]; // a new lineage sample, LINEAGE_FIELDS numbers
  lineages?: WireLineage[]; // the largest living lineages, at most LINEAGE_TOP
  records?: { board: RecordBoard; entries: WireRecord[] }[]; // since the server started, dead creatures included, at most MAX_RECORDS each
}

// The world's past, once after the hello: flat samples, oldest first.
export interface History {
  t: "history";
  samples: number[]; // HISTORY_FIELDS per sample, at most MAX_HISTORY samples
  lineage: number[]; // LINEAGE_FIELDS per sample, at most MAX_LINEAGE_HISTORY samples
}

export interface Pong {
  t: "pong";
}
export interface Busy {
  t: "busy"; // sent before closing when the viewer cap is reached
  maxViewers: number;
}
export type ServerText = Hello | Stats | History | Pong | Busy | Added | Refused;

export type ClientMessage = { t: "ping" } | { t: "select"; id: number | null };

// A client's text message, or null for anything malformed. Strict: exactly the fields of a select, an integer id in range.
export function parseClientMessage(data: string): ClientMessage | null {
  if (data === PING) return { t: "ping" };
  if (data.length > MAX_CLIENT_MESSAGE_BYTES || data[0] !== "{") return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null || Array.isArray(m) || Object.getPrototypeOf(m) !== Object.prototype) return null;
  const keys = Object.keys(m);
  if (keys.length !== 2 || !keys.includes("t") || !keys.includes("id")) return null;
  const { t, id } = m as { t: unknown; id: unknown };
  if (t !== "select") return null;
  if (id === null) return { t: "select", id: null };
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id > MAX_ID) return null;
  return { t: "select", id };
}

// Per-creature arrays as the server has them (engine units).
export interface CreatureSource {
  count: number;
  ids: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  heading: ArrayLike<number>;
  energy: ArrayLike<number>; // absolute
  hue: ArrayLike<number>; // degrees
  founder: ArrayLike<number>;
  age: ArrayLike<number>; // seconds
  radius: number;
}

export interface CreatureFrame {
  tick: number; // u32: wraps after 2^32 ticks (LiveScene orders by the nearest)
  count: number;
  ids: Uint32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array; // radians, 0..2pi
  radius: Float32Array;
  energyShare: Float32Array; // 0..1 of the full-energy level
  age: Float32Array;
  hue: Float32Array; // degrees
  founder: Int32Array;
}

const U16 = 65535;
const TAU = 2 * Math.PI;
const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
export const q16 = (v: number, span: number): number => clamp(Math.round((v / span) * U16), U16);
export const unq16 = (v: number, span: number): number => (v / U16) * span;

export function creatureFrameBytes(count: number): number {
  return CREATURE_HEADER + count * CREATURE_RECORD;
}

export function encodeCreatures(tick: number, src: CreatureSource, world: WorldSize, fullEnergy: number): Uint8Array {
  const out = new Uint8Array(creatureFrameBytes(src.count));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MSG_CREATURES);
  dv.setUint32(1, tick, true);
  dv.setUint32(5, src.count, true);
  const radius = clamp(Math.round(src.radius * 4), 255);
  for (let i = 0, o = CREATURE_HEADER; i < src.count; i++, o += CREATURE_RECORD) {
    dv.setUint32(o, src.ids[i]!, true);
    dv.setUint16(o + 4, q16(src.x[i]!, world.width), true);
    dv.setUint16(o + 6, q16(src.y[i]!, world.height), true);
    dv.setUint16(o + 8, q16((((src.heading[i]! % TAU) + TAU) % TAU), TAU), true);
    dv.setUint8(o + 10, radius);
    dv.setUint8(o + 11, clamp(Math.round((src.energy[i]! / fullEnergy) * 255), 255));
    dv.setUint8(o + 12, clamp(Math.floor(src.age[i]!), MAX_AGE_S));
    dv.setUint16(o + 13, q16(src.hue[i]! % 360, 360), true);
    dv.setUint32(o + 15, clamp(src.founder[i]!, MAX_ID), true);
  }
  return out;
}

const view = (buf: ArrayBuffer | Uint8Array): DataView => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

export function decodeCreatures(buf: ArrayBuffer | Uint8Array, world: WorldSize): CreatureFrame {
  const dv = view(buf);
  if (dv.byteLength < CREATURE_HEADER || dv.getUint8(0) !== MSG_CREATURES) throw new Error("not a creature frame");
  const count = dv.getUint32(5, true);
  if (dv.byteLength !== creatureFrameBytes(count)) throw new Error("bad creature frame size");
  const f: CreatureFrame = {
    tick: dv.getUint32(1, true),
    count,
    ids: new Uint32Array(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    heading: new Float32Array(count),
    radius: new Float32Array(count),
    energyShare: new Float32Array(count),
    age: new Float32Array(count),
    hue: new Float32Array(count),
    founder: new Int32Array(count),
  };
  for (let i = 0, o = CREATURE_HEADER; i < count; i++, o += CREATURE_RECORD) {
    f.ids[i] = dv.getUint32(o, true);
    f.x[i] = (dv.getUint16(o + 4, true) / U16) * world.width;
    f.y[i] = (dv.getUint16(o + 6, true) / U16) * world.height;
    f.heading[i] = (dv.getUint16(o + 8, true) / U16) * TAU;
    f.radius[i] = dv.getUint8(o + 10) / 4;
    f.energyShare[i] = dv.getUint8(o + 11) / 255;
    f.age[i] = dv.getUint8(o + 12);
    f.hue[i] = (dv.getUint16(o + 13, true) / U16) * 360;
    f.founder[i] = dv.getUint32(o + 15, true) | 0; // founder ids past 2^31 wrap negative, like the views' ids; compare them as i32
  }
  return f;
}

// ---- items ----

// The item set as slots: kinds[i] is 0 (free), HIT_FOOD or HIT_POISON. Positions in world units.
export interface ItemSlots {
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
  kinds: ArrayLike<number>;
  slots: number;
}

export interface ItemsSnapshot {
  tick: number;
  slots: number;
  kinds: Uint8Array; // per slot
  x: Float32Array; // per slot, meaningful where kinds is not 0
  y: Float32Array;
}

const itemKind = (k: number): number => (k === HIT_FOOD ? 1 : k === HIT_POISON ? 2 : 0);

export function itemsBytes(slots: number, n: number): number {
  return ITEMS_HEADER + Math.ceil(slots / 4) + 4 * n;
}

export function encodeItems(tick: number, s: ItemSlots, world: WorldSize): Uint8Array {
  if (s.slots > MAX_ITEM_SLOTS) throw new Error("too many item slots for the wire");
  let n = 0;
  for (let i = 0; i < s.slots; i++) if (itemKind(s.kinds[i]!)) n++;
  const out = new Uint8Array(itemsBytes(s.slots, n));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MSG_ITEMS);
  dv.setUint32(1, tick, true);
  dv.setUint32(5, s.slots, true);
  dv.setUint32(9, n, true);
  let p = ITEMS_HEADER + Math.ceil(s.slots / 4);
  for (let i = 0; i < s.slots; i++) {
    const k = itemKind(s.kinds[i]!);
    if (!k) continue;
    out[ITEMS_HEADER + (i >> 2)]! |= k << ((i & 3) * 2);
    dv.setUint16(p, q16(s.xs[i]!, world.width), true);
    dv.setUint16(p + 2, q16(s.ys[i]!, world.height), true);
    p += 4;
  }
  return out;
}

export function decodeItems(buf: ArrayBuffer | Uint8Array, world: WorldSize, maxSlots = MAX_ITEM_SLOTS): ItemsSnapshot {
  const dv = view(buf);
  if (dv.byteLength < ITEMS_HEADER || dv.getUint8(0) !== MSG_ITEMS) throw new Error("not an items frame");
  const slots = dv.getUint32(5, true);
  const n = dv.getUint32(9, true);
  if (slots > maxSlots || n > slots || dv.byteLength !== itemsBytes(slots, n)) throw new Error("bad items frame size");
  const kinds = new Uint8Array(slots);
  const x = new Float32Array(slots);
  const y = new Float32Array(slots);
  let p = ITEMS_HEADER + Math.ceil(slots / 4);
  let seen = 0;
  for (let i = 0; i < slots; i++) {
    const k = (dv.getUint8(ITEMS_HEADER + (i >> 2)) >> ((i & 3) * 2)) & 3;
    if (!k) continue;
    if (k === 3 || ++seen > n) throw new Error("bad items frame");
    kinds[i] = k;
    x[i] = unq16(dv.getUint16(p, true), world.width);
    y[i] = unq16(dv.getUint16(p + 2, true), world.height);
    p += 4;
  }
  if (seen !== n) throw new Error("bad items frame");
  return { tick: dv.getUint32(1, true), slots, kinds, x, y };
}

// One server frame's item changes and collision events, as recorded on the server.
export interface ItemOp {
  slot: number;
  kind: number; // 0 removed, 1 food, 2 poison
  x: number;
  y: number;
  tick: number;
}
export interface WireEvent {
  kind: number; // 0 impact, 1 death
  x: number;
  y: number;
  value: number;
}

// Encodes one frame's delta (tick, ops, events) as a standalone chunk, or null when it does not fit the format
// (too many ops or events, a slot or tick out of range); viewers then get the full set.
export function encodeDeltaChunk(tick: number, ops: readonly ItemOp[], events: readonly WireEvent[], world: WorldSize): Uint8Array | null {
  if (ops.length > MAX_DELTA_OPS || events.length > MAX_DELTA_EVENTS) return null;
  let size = 7 + events.length * EVENT_BYTES;
  for (const op of ops) size += op.kind === OP_REMOVE ? 4 : 8;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, tick, true);
  dv.setUint16(4, ops.length, true);
  dv.setUint8(6, events.length);
  let p = 7;
  for (const op of ops) {
    const back = tick - op.tick;
    if (op.slot < 0 || op.slot >= MAX_ITEM_SLOTS || back < 0 || back > MAX_BACK_TICKS || op.kind < 0 || op.kind > 2) return null;
    dv.setUint32(p, (op.slot | (op.kind << 18) | (back << 20)) >>> 0, true);
    p += 4;
    if (op.kind !== OP_REMOVE) {
      dv.setUint16(p, q16(op.x, world.width), true);
      dv.setUint16(p + 2, q16(op.y, world.height), true);
      p += 4;
    }
  }
  for (const e of events) {
    dv.setUint8(p, e.kind ? 1 : 0);
    dv.setUint16(p + 1, q16(e.x, world.width), true);
    dv.setUint16(p + 3, q16(e.y, world.height), true);
    dv.setUint16(p + 5, e.kind ? q16(((e.value % 360) + 360) % 360, 360) : clamp(Math.round(e.value), U16), true);
    p += EVENT_BYTES;
  }
  return out;
}

// A DELTA message from chunks, oldest first.
export function deltaMessage(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length > MAX_DELTAS) throw new Error("too many deltas");
  let size = 2;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out[0] = MSG_DELTA;
  out[1] = chunks.length;
  let p = 2;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export interface Delta {
  tick: number;
  ops: { slot: number; kind: number; x: number; y: number; tick: number }[];
  events: WireEvent[];
}

export function decodeDelta(buf: ArrayBuffer | Uint8Array, world: WorldSize, maxSlots = MAX_ITEM_SLOTS): Delta[] {
  const dv = view(buf);
  if (dv.byteLength < 2 || dv.getUint8(0) !== MSG_DELTA) throw new Error("not a delta");
  const n = dv.getUint8(1);
  if (n > MAX_DELTAS) throw new Error("too many deltas");
  const out: Delta[] = [];
  let p = 2;
  const need = (bytes: number): void => {
    if (p + bytes > dv.byteLength) throw new Error("truncated delta");
  };
  for (let d = 0; d < n; d++) {
    need(7);
    const tick = dv.getUint32(p, true);
    const nOps = dv.getUint16(p + 4, true);
    const nEvents = dv.getUint8(p + 6);
    if (nOps > MAX_DELTA_OPS || nEvents > MAX_DELTA_EVENTS) throw new Error("delta too big");
    p += 7;
    const ops: Delta["ops"] = [];
    for (let i = 0; i < nOps; i++) {
      need(4);
      const w = dv.getUint32(p, true);
      p += 4;
      const slot = w & (MAX_ITEM_SLOTS - 1);
      const kind = (w >>> 18) & 3;
      const back = w >>> 20;
      if (slot >= maxSlots || kind === 3) throw new Error("bad delta op");
      let x = 0;
      let y = 0;
      if (kind !== OP_REMOVE) {
        need(4);
        x = unq16(dv.getUint16(p, true), world.width);
        y = unq16(dv.getUint16(p + 2, true), world.height);
        p += 4;
      }
      ops.push({ slot, kind, x, y, tick: (tick - back) >>> 0 }); // u32 like the frame's tick, wrapping below 0
    }
    const events: WireEvent[] = [];
    for (let i = 0; i < nEvents; i++) {
      need(EVENT_BYTES);
      const kind = dv.getUint8(p) ? 1 : 0;
      const raw = dv.getUint16(p + 5, true);
      events.push({ kind, x: unq16(dv.getUint16(p + 1, true), world.width), y: unq16(dv.getUint16(p + 3, true), world.height), value: kind ? unq16(raw, 360) : raw });
      p += EVENT_BYTES;
    }
    out.push({ tick, ops, events });
  }
  if (p !== dv.byteLength) throw new Error("bad delta size");
  return out;
}

export const frameType = (buf: ArrayBuffer | Uint8Array): number => (buf instanceof Uint8Array ? buf[0]! : new Uint8Array(buf, 0, 1)[0]!);
