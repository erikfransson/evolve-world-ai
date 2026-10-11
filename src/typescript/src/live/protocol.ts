// Live World wire protocol, shared by server/ and the live/ page. Version 1.
//
// Text messages are JSON objects with a "t" field (Hello, Stats, Pong below); the client may only send "ping" (PING).
// Binary messages are little-endian, the first byte is the type.
//
// CREATURES (1), about 5 Hz:  u8 type | u32 tick | u32 count | count x record
//   record, 17 bytes: u32 id | u16 x | u16 y | u16 heading | u8 radius | u8 energy | u8 age | u16 hue | u16 founder
//   x, y: 0..65535 over the world width / height. heading: 0..65535 over 0..2pi. radius: units of 0.25.
//   energy: 0..255 as a share of the full-energy level (Hello.fullEnergy), 255 means full or more. age: whole seconds, capped at 255.
//   hue: 0..65535 over 0..360 degrees. founder: founder id, capped at 65535.
// ITEMS (2), every ITEMS_EVERY_S seconds: u8 type | u32 tick | u32 nFood | u32 nPoison | nFood x (u16 x, u16 y) | nPoison x (u16 x, u16 y)

export const PROTOCOL_VERSION = 1;
export const MSG_CREATURES = 1;
export const MSG_ITEMS = 2;
export const PING = "ping";
export const CREATURE_HEADER = 9;
export const CREATURE_RECORD = 17;
export const ITEMS_HEADER = 13;
export const ITEMS_EVERY_S = 2;
export const FRAME_HZ = 5;
export const MAX_AGE_S = 255; // ages at or above this are sent as this
export const MAX_CLIENT_MESSAGE_BYTES = 256;

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
  summary: { initialPopulation: number; maxPopulation: number; collisionDamage: boolean; seasons: boolean };
  maxViewers: number;
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
}

export interface Pong {
  t: "pong";
}
export interface Busy {
  t: "busy"; // sent before closing when the viewer cap is reached
  maxViewers: number;
}
export type ServerText = Hello | Stats | Pong | Busy;

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
  tick: number;
  count: number;
  ids: Int32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array; // radians, 0..2pi
  radius: Float32Array;
  energyShare: Float32Array; // 0..1 of the full-energy level
  age: Float32Array;
  hue: Float32Array; // degrees
  founder: Int32Array;
}

export interface ItemsFrame {
  tick: number;
  foodX: Float32Array;
  foodY: Float32Array;
  poisonX: Float32Array;
  poisonY: Float32Array;
}

const U16 = 65535;
const TAU = 2 * Math.PI;
const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
const q16 = (v: number, span: number): number => clamp(Math.round((v / span) * U16), U16);

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
    dv.setUint16(o + 15, clamp(src.founder[i]!, U16), true);
  }
  return out;
}

export function decodeCreatures(buf: ArrayBuffer | Uint8Array, world: WorldSize): CreatureFrame {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== MSG_CREATURES) throw new Error("not a creature frame");
  const count = dv.getUint32(5, true);
  if (bytes.byteLength !== creatureFrameBytes(count)) throw new Error("bad creature frame size");
  const f: CreatureFrame = {
    tick: dv.getUint32(1, true),
    count,
    ids: new Int32Array(count),
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
    f.founder[i] = dv.getUint16(o + 15, true);
  }
  return f;
}

// kinds: 1 = food, 2 = poison, anything else is a free slot (the engine's HIT_FOOD and HIT_POISON).
export function encodeItems(tick: number, xs: ArrayLike<number>, ys: ArrayLike<number>, kinds: ArrayLike<number>, slots: number, world: WorldSize): Uint8Array {
  let food = 0;
  let poison = 0;
  for (let i = 0; i < slots; i++) {
    if (kinds[i] === 1) food++;
    else if (kinds[i] === 2) poison++;
  }
  const out = new Uint8Array(ITEMS_HEADER + 4 * (food + poison));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MSG_ITEMS);
  dv.setUint32(1, tick, true);
  dv.setUint32(5, food, true);
  dv.setUint32(9, poison, true);
  let f = ITEMS_HEADER;
  let p = ITEMS_HEADER + 4 * food;
  for (let i = 0; i < slots; i++) {
    const k = kinds[i];
    if (k !== 1 && k !== 2) continue;
    const at = k === 1 ? f : p;
    dv.setUint16(at, q16(xs[i]!, world.width), true);
    dv.setUint16(at + 2, q16(ys[i]!, world.height), true);
    if (k === 1) f += 4;
    else p += 4;
  }
  return out;
}

export function decodeItems(buf: ArrayBuffer | Uint8Array, world: WorldSize): ItemsFrame {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== MSG_ITEMS) throw new Error("not an items frame");
  const food = dv.getUint32(5, true);
  const poison = dv.getUint32(9, true);
  if (bytes.byteLength !== ITEMS_HEADER + 4 * (food + poison)) throw new Error("bad items frame size");
  const read = (at: number, n: number): [Float32Array, Float32Array] => {
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = (dv.getUint16(at + 4 * i, true) / U16) * world.width;
      y[i] = (dv.getUint16(at + 4 * i + 2, true) / U16) * world.height;
    }
    return [x, y];
  };
  const [foodX, foodY] = read(ITEMS_HEADER, food);
  const [poisonX, poisonY] = read(ITEMS_HEADER + 4 * food, poison);
  return { tick: dv.getUint32(1, true), foodX, foodY, poisonX, poisonY };
}

export const frameType = (buf: ArrayBuffer | Uint8Array): number => (buf instanceof Uint8Array ? buf[0]! : new Uint8Array(buf, 0, 1)[0]!);
