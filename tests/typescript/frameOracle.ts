import { CREATURE_HEADER, CREATURE_RECORD, MAX_AGE_S, MAX_ID, MSG_CREATURES, creatureFrameBytes, q16 } from "../../src/typescript/src/live/protocol.ts";
import type { WorldSize } from "../../src/typescript/src/live/protocol.ts";

const TAU = 2 * Math.PI;
const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);

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

// The creature frame written field by field through a DataView: the reference that the production writer (putCreature) must match byte for byte.
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
