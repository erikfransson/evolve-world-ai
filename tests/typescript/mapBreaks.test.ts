// @vitest-environment node
import { buildMap } from "../../src/typescript/src/sim/maps/mapBuild.ts";
import { builtMap, mapSpec } from "../../src/typescript/src/sim/maps/index.ts";
import type { MapSpec } from "../../src/typescript/src/sim/maps/mapBuild.ts";

// A ridge with scree beside it, built with and without a break through the middle of the ridge.
const ridge: MapSpec = {
  name: "breaks-test", title: "breaks", seed: 5, width: 6000, height: 3000, scale: 1, layers: [], solidRock: true,
  rock: [
    { id: "ridge", kind: "massif", cover: 1, shape: { type: "path", path: [[600, 1500], [3000, 1300], [5400, 1500]], w: [500, 600, 500] }, warp: 200, rough: 60, feather: 260 },
    { id: "scree", kind: "talus", cover: 0.14, shape: { type: "path", path: [[600, 1900], [3000, 1700], [5400, 1900]], w: [900, 900, 900] }, warp: 200, rough: 100, feather: 500 },
    { id: "tors", kind: "outcrop", cover: 0.05, shape: { type: "poly", pts: [[500, 2300], [5500, 2300], [5500, 2900], [500, 2900]] }, warp: 100, rough: 60, feather: 400 },
  ],
};
const key = (d: { x: number; y: number; r: number }): string => `${d.x},${d.y},${d.r}`;

describe("map breaks", () => {
  it("cut an opening through the placed rock, wear the rock down towards it, and leave every disc beyond that band as it was", () => {
    const before = buildMap(ridge).rock;
    const after = buildMap({ ...ridge, breaks: [[3000, 1350, 700]] }).rock;
    const at = (d: { x: number; y: number }): string => `${d.x},${d.y}`;
    const dist = (d: { x: number; y: number }): number => Math.hypot(d.x - 3000, d.y - 1350);
    const now = new Map(after.map((d) => [at(d), d]));
    const gone = before.filter((d) => !now.has(at(d)));
    const worn = before.filter((d) => now.has(at(d)) && now.get(at(d))!.r !== d.r);
    expect(gone.length).toBeGreaterThan(5);
    expect(worn.length).toBeGreaterThan(5);
    for (const d of gone) expect(dist(d)).toBeLessThan(700 * 1.15); // only inside the roughened break
    for (const d of worn) {
      expect(dist(d)).toBeLessThan(700 * 1.15 * 1.35); // only in the worn band
      expect(now.get(at(d))!.r).toBeLessThan(d.r);
      expect(now.get(at(d))!.r).toBeGreaterThanOrEqual(Math.floor(d.r * 0.5)); // no thinner than half at the cut
    }
    const old = new Set(before.map(at));
    expect(after.filter((d) => !old.has(at(d))).every((d) => dist(d) < 700 * 1.15 * 1.35 + 400)).toBe(true); // fill only at the cut
    expect(after.some((d) => dist(d) < 300)).toBe(false); // the middle is open
  });

  it("refuses breaks that are not finite [x, y, radius] with a radius up to 5000, or too many", () => {
    for (const breaks of [[[1, 2]], [[1, 2, 0]], [[1, 2, 6000]], [[1, NaN, 30]], [5], ["1,2,3"], Array.from({ length: 17 }, () => [1, 2, 3])] as unknown as [number, number, number][][]) {
      expect(() => buildMap({ ...ridge, breaks })).toThrow(/breaks must be at most 16 finite \[x, y, radius\] with a radius over 0 and at most 5000/);
    }
  });

  // The Six Realms' two wall openings stay wide: the narrowest rock-to-rock gap across each break (discs within 3500 of it, split by the line
  // from the map centre through the break, so each side is one wall end). Breaks look only at disc centres, so a wall edit could narrow one.
  it("keeps both Six Realms openings at least 1,800 u clear", () => {
    const spec = mapSpec("clock")!;
    const rock = builtMap("clock").rock;
    expect(spec.breaks).toHaveLength(2);
    for (const [bx, by] of spec.breaks!) {
      const ux = -(by - spec.height / 2), uy = bx - spec.width / 2; // across the radial line
      const near = rock.filter((d) => Math.hypot(d.x - bx, d.y - by) < 3500);
      const side = (d: { x: number; y: number }): boolean => (d.x - bx) * ux + (d.y - by) * uy < 0;
      const a = near.filter(side), b = near.filter((d) => !side(d));
      expect(a.length).toBeGreaterThan(10);
      expect(b.length).toBeGreaterThan(10);
      let gap = Infinity;
      for (const p of a) for (const q of b) gap = Math.min(gap, Math.hypot(p.x - q.x, p.y - q.y) - p.r - q.r);
      expect(gap).toBeGreaterThan(1800);
    }
  }, 180_000);
});
