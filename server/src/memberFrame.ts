import { CREATURE_HEADER, CREATURE_RECORD, MAX_AGE_S, MAX_ID, newCreatureFrame, putCreature, q16 } from "../../src/typescript/src/live/protocol.ts";
import type { WorldSize } from "../../src/typescript/src/live/protocol.ts";
import { wrapAngle } from "../../src/typescript/src/sim/angle.ts";
import type { EcoCreature } from "../../src/typescript/src/sim/ecosystem.ts";

const TAU = 2 * Math.PI;
const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
const f32 = Math.fround;

// The creature frame straight from the members into the wire bytes, byte for byte what Ecosystem.readCreatures + the reference encodeCreatures (tests/typescript/frameOracle.ts) give
// (tests/typescript/liveFrame.test.ts compares them): every value goes through Math.fround where the old path stored it in a Float32Array
// (or Int32Array for the ids), and the float % of the heading and hue become exact branches with the old % as fallback.
export function encodeMembers(tick: number, members: readonly EcoCreature[], dt: number, radiusWorld: number, world: WorldSize, fullEnergy: number): Uint8Array {
  const n = members.length;
  const out = newCreatureFrame(tick, n);
  const radius = clamp(Math.round(radiusWorld * 4), 255);
  for (let i = 0, o = CREATURE_HEADER; i < n; i++, o += CREATURE_RECORD) {
    const m = members[i]!;
    const s = m.creature.state;
    // The old path: ((h % TAU) + TAU) % TAU on the f32 heading. For |h| < 4 (a wrapped angle) h % TAU is h, and the second % is one subtraction.
    let h = f32(wrapAngle(s.heading));
    if (h > -4 && h < 4) {
      h += TAU;
      if (h >= TAU) h -= TAU;
    } else h = ((h % TAU) + TAU) % TAU;
    const hue = f32(m.hue);
    putCreature(
      out, o, m.id | 0, q16(f32(s.x), world.width), q16(f32(s.y), world.height), q16(h, TAU), radius,
      clamp(Math.round((f32(s.energy) / fullEnergy) * 255), 255), clamp(Math.floor(f32(s.ticksAlive * dt)), MAX_AGE_S),
      q16(hue >= 0 && hue < 360 ? hue : hue % 360, 360), clamp(m.founderId | 0, MAX_ID), // hue % 360 is hue inside [0, 360)
    );
  }
  return out;
}
