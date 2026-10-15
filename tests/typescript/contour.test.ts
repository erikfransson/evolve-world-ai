import { insidePolygon, marchingSquares, simplifyClosed } from "../../src/typescript/src/geom/contour.ts";

const area = (flat: readonly number[]): number => {
  let a = 0;
  for (let i = 0, n = flat.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[2 * i]! * flat[2 * j + 1]! - flat[2 * j]! * flat[2 * i + 1]!;
  }
  return Math.abs(a) / 2;
};

describe("marchingSquares", () => {
  const disc = (w: number, h: number, cx: number, cy: number, r: number): Float32Array => Float32Array.from({ length: w * h }, (_, k) => r - Math.hypot((k % w) - cx, Math.floor(k / w) - cy));

  it("traces one closed loop around a disc, scaled and offset into world units", () => {
    const loops = marchingSquares(disc(30, 30, 15, 15, 8), 30, 30, 0, { scale: 2, ox: 100, oy: -50, strict: true });
    expect(loops).toHaveLength(1);
    const pts = loops[0]!;
    for (let i = 0; i < pts.length; i += 2) expect(Math.hypot(pts[i]! - (100 + 30), pts[i + 1]! - (-50 + 30))).toBeCloseTo(16, 0);
    expect(area(pts)).toBeCloseTo(Math.PI * 16 * 16, -1);
  });

  it("finds an outer loop and a hole, and joins the diagonal pairs of a saddle by the centre value", () => {
    const ring = Float32Array.from({ length: 400 }, (_, k) => 3.5 - Math.abs(Math.hypot((k % 20) - 9.5, Math.floor(k / 20) - 9.5) - 5));
    expect(marchingSquares(ring, 20, 20, 0, { scale: 1 })).toHaveLength(2);
    const saddle = Float32Array.from([-1, -1, -1, -1, -1, 1, -1, -1, -1, -1, 1, -1, -1, -1, -1, -1]); // two diagonal inside nodes with a centre value of 0
    expect(marchingSquares(saddle, 4, 4, 0, { scale: 1 })).toHaveLength(1); // the centre is inside, so they join
    expect(marchingSquares(saddle, 4, 4, 0.5, { scale: 1 })).toHaveLength(2); // the centre is outside, so they stay apart
  });

  it("skips blocks marked inactive and loops under minPoints", () => {
    const f = disc(30, 30, 15, 15, 8);
    expect(marchingSquares(f, 30, 30, 0, { scale: 1, strict: true, active: new Uint8Array(100), block: 3 })).toEqual([]);
    expect(marchingSquares(f, 30, 30, 0, { scale: 1, strict: true, minPoints: 1000 })).toEqual([]);
  });

  it("counts a node at the threshold as inside unless strict", () => {
    const f = Float32Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(marchingSquares(f, 3, 3, 1, { scale: 1 })).toHaveLength(1);
    expect(marchingSquares(f, 3, 3, 1, { scale: 1, strict: true })).toHaveLength(0);
  });
});

describe("simplifyClosed", () => {
  it("keeps the corners of a square drawn with extra points on its sides", () => {
    const sq: number[] = [];
    for (let i = 0; i < 10; i++) sq.push(i, 0);
    for (let i = 0; i < 10; i++) sq.push(10, i);
    for (let i = 0; i < 10; i++) sq.push(10 - i, 10);
    for (let i = 0; i < 10; i++) sq.push(0, 10 - i);
    const out = simplifyClosed(sq, 0.1);
    expect(out).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
  });

  it("drops points within the tolerance and keeps those beyond it", () => {
    const wavy = [0, 0, 5, 0.3, 10, 0, 10, 10, 0, 10];
    expect(simplifyClosed(wavy, 0.5)).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(simplifyClosed(wavy, 0.1)).toEqual(wavy);
  });
});

describe("insidePolygon", () => {
  it("is even-odd", () => {
    const sq = Float64Array.from([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(insidePolygon(sq, 5, 5)).toBe(true);
    expect(insidePolygon(sq, 11, 5)).toBe(false);
  });
});
