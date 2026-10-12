import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { rockBodies } from "../../src/typescript/src/ui/rockOutline.ts";

const map = () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.world = { ...c.world, width: 3000, height: 2000, stoneDensity: 0.06, ridgeDensity: 0.05, slowDensity: 0, fastDensity: 0 };
  return terrainOf(c);
};

describe("rockBodies", () => {
  it("draws every lump of rock with an outline that hugs the union of its discs", () => {
    const t = map();
    const bodies = rockBodies(t);
    expect(bodies.length).toBeGreaterThan(2);
    expect(rockBodies(t)).toBe(bodies); // built once per map
    let worst = 0;
    for (const b of bodies) {
      expect(b.loops.length).toBeGreaterThan(0);
      for (const loop of b.loops) {
        for (let k = 0; k < loop.length; k += 2) {
          let inside = -Infinity; // signed distance to the union: positive inside
          for (let i = 0; i < t.rockCount; i++) inside = Math.max(inside, t.rockR[i]! - Math.hypot(loop[k]! - t.rockX[i]!, loop[k + 1]! - t.rockY[i]!));
          worst = Math.max(worst, Math.abs(inside));
        }
      }
    }
    expect(worst).toBeLessThan(2); // world units; the outline is the contour, simplified
  });

  it("has no rock bodies on an open map", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    expect(rockBodies(terrainOf(c))).toEqual([]);
  });
});
