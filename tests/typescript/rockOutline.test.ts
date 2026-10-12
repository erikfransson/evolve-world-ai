import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { rockBodies, traceLoop } from "../../src/typescript/src/ui/rockOutline.ts";
import type { PathSink } from "../../src/typescript/src/ui/rockOutline.ts";

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
    const check = (x: number, y: number): void => {
      let inside = -Infinity; // signed distance to the union: positive inside
      for (let i = 0; i < t.rockCount; i++) inside = Math.max(inside, t.rockR[i]! - Math.hypot(x - t.rockX[i]!, y - t.rockY[i]!));
      worst = Math.max(worst, Math.abs(inside));
    };
    for (const b of bodies) {
      expect(b.loops.length).toBeGreaterThan(0);
      for (const loop of b.loops) {
        // the curve as drawn: points along every edge and corner curve
        let cx = 0;
        let cy = 0;
        const sink: PathSink = {
          moveTo: (x, y) => { cx = x; cy = y; },
          lineTo: (x, y) => {
            for (let k = 1; k <= 8; k++) check(cx + ((x - cx) * k) / 8, cy + ((y - cy) * k) / 8);
            cx = x;
            cy = y;
          },
          quadraticCurveTo: (qx, qy, x, y) => {
            for (let k = 1; k <= 8; k++) {
              const u = k / 8;
              check((1 - u) ** 2 * cx + 2 * u * (1 - u) * qx + u * u * x, (1 - u) ** 2 * cy + 2 * u * (1 - u) * qy + u * u * y);
            }
            cx = x;
            cy = y;
          },
          closePath: () => {},
        };
        traceLoop(sink, loop);
      }
    }
    expect(worst).toBeLessThan(2.2); // world units; straight edges between contour points stay inside their disc arcs by the simplification tolerance
  });

  it("has no rock bodies on an open map", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    expect(rockBodies(terrainOf(c))).toEqual([]);
  });
});
