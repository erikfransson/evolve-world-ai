import { CREATURE_HEADER, CREATURE_RECORD, MAX_AGE_S, MAX_ID, MSG_CREATURES, creatureFrameBytes, q16 } from "../../src/typescript/src/live/protocol.ts";
import type { WorldSize } from "../../src/typescript/src/live/protocol.ts";
import { wrapAngle } from "../../src/typescript/src/sim/angle.ts";
import type { EcoCreature } from "../../src/typescript/src/sim/ecosystem.ts";

const TAU = 2 * Math.PI;
const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
const f32 = Math.fround;

// The creature frame straight from the members into the wire bytes, byte for byte what Ecosystem.readCreatures + encodeCreatures give
// (tests/typescript/liveFrame.test.ts compares them): every value goes through Math.fround where the old path stored it in a Float32Array
// (or Int32Array for the ids), and the float % of the heading and hue become exact branches with the old % as fallback.
export function encodeMembers(tick: number, members: readonly EcoCreature[], dt: number, radiusWorld: number, world: WorldSize, fullEnergy: number): Uint8Array {
  const n = members.length;
  const out = new Uint8Array(creatureFrameBytes(n));
  out[0] = MSG_CREATURES;
  out[1] = tick & 255; out[2] = (tick >>> 8) & 255; out[3] = (tick >>> 16) & 255; out[4] = (tick >>> 24) & 255;
  out[5] = n & 255; out[6] = (n >>> 8) & 255; out[7] = (n >>> 16) & 255; out[8] = (n >>> 24) & 255;
  const radius = clamp(Math.round(radiusWorld * 4), 255);
  for (let i = 0, o = CREATURE_HEADER; i < n; i++, o += CREATURE_RECORD) {
    const m = members[i]!;
    const s = m.creature.state;
    const id = m.id | 0;
    out[o] = id & 255; out[o + 1] = (id >>> 8) & 255; out[o + 2] = (id >>> 16) & 255; out[o + 3] = (id >>> 24) & 255;
    const x = q16(f32(s.x), world.width);
    out[o + 4] = x & 255; out[o + 5] = x >>> 8;
    const y = q16(f32(s.y), world.height);
    out[o + 6] = y & 255; out[o + 7] = y >>> 8;
    // The old path: ((h % TAU) + TAU) % TAU on the f32 heading. For |h| < 4 (a wrapped angle) h % TAU is h, and the second % is one subtraction.
    let h = f32(wrapAngle(s.heading));
    if (h > -4 && h < 4) {
      h += TAU;
      if (h >= TAU) h -= TAU;
    } else h = ((h % TAU) + TAU) % TAU;
    const q = q16(h, TAU);
    out[o + 8] = q & 255; out[o + 9] = q >>> 8;
    out[o + 10] = radius;
    out[o + 11] = clamp(Math.round((f32(s.energy) / fullEnergy) * 255), 255);
    out[o + 12] = clamp(Math.floor(f32(s.ticksAlive * dt)), MAX_AGE_S);
    const hue = f32(m.hue);
    const u = q16(hue >= 0 && hue < 360 ? hue : hue % 360, 360); // hue % 360 is hue inside [0, 360)
    out[o + 13] = u & 255; out[o + 14] = u >>> 8;
    const f = clamp(m.founderId | 0, MAX_ID);
    out[o + 15] = f & 255; out[o + 16] = (f >>> 8) & 255; out[o + 17] = (f >>> 16) & 255; out[o + 18] = (f >>> 24) & 255;
  }
  return out;
}
