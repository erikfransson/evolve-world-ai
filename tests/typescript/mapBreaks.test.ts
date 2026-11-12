// @vitest-environment node
import { buildMap } from "../../src/typescript/src/sim/maps/mapBuild.ts";
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
  it("cut an opening through the placed rock and leave every disc outside it as it was", () => {
    const before = buildMap(ridge).rock;
    const after = buildMap({ ...ridge, breaks: [[3000, 1350, 700]] }).rock;
    const kept = new Set(after.map(key));
    const gone = before.filter((d) => !kept.has(key(d)));
    expect(gone.length).toBeGreaterThan(5);
    for (const d of gone) expect(Math.hypot(d.x - 3000, d.y - 1350)).toBeLessThan(700 * 1.15); // only inside the roughened break
    const old = new Set(before.map(key));
    expect(after.filter((d) => !old.has(key(d))).every((d) => Math.hypot(d.x - 3000, d.y - 1350) < 700 * 1.15 + 400)).toBe(true); // fill only at the cut
    expect(after.some((d) => Math.hypot(d.x - 3000, d.y - 1350) < 300)).toBe(false); // the middle is open
  });

  it("refuses breaks that are not finite [x, y, radius] with a radius up to 5000, or too many", () => {
    for (const breaks of [[[1, 2]], [[1, 2, 0]], [[1, 2, 6000]], [[1, NaN, 30]], Array.from({ length: 17 }, () => [1, 2, 3])] as unknown as [number, number, number][][]) {
      expect(() => buildMap({ ...ridge, breaks })).toThrow(/breaks must be at most 16 finite/);
    }
  });
});
