import { pickCreature } from "../../src/typescript/src/ui/ecoPick.ts";

const xs = Float32Array.of(100, 110, 500);
const ys = Float32Array.of(100, 100, 500);

describe("pickCreature", () => {
  it("returns the nearest creature within reach", () => {
    expect(pickCreature(xs, ys, 3, 108, 102, 30)).toBe(1);
    expect(pickCreature(xs, ys, 3, 98, 100, 30)).toBe(0);
  });

  it("returns -1 when nothing is within reach, and ignores slots beyond count", () => {
    expect(pickCreature(xs, ys, 3, 300, 300, 30)).toBe(-1);
    expect(pickCreature(xs, ys, 2, 500, 500, 30)).toBe(-1);
    expect(pickCreature(xs, ys, 0, 100, 100, 30)).toBe(-1);
  });
});
