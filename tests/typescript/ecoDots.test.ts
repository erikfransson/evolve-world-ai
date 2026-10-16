import { EcoRenderer } from "../../src/typescript/src/ui/ecoScene.ts"; // vi.mock is hoisted above this import

const arcs: number[][] = [];
vi.mock("../../src/typescript/src/ui/groundScene.ts", () => ({
  makeCanvas: (width: number, height: number) => ({ width, height }),
  context2d: () => ({ fillStyle: "", beginPath() {}, fill() {}, clearRect() {}, arc: (x: number, y: number, r: number) => arcs.push([x, y, r]) }),
}));

// A view with 2 creatures, stamped through a camera at zoom 0.5 shifted by a fraction of a pixel.
function stamp(xs: number[], ys: number[]) {
  const blits: number[][] = [];
  let transform = { a: 0.5, b: 0, c: 0, d: 0.5, e: 10.3, f: 20.6 };
  const ctx = {
    getTransform: () => transform,
    setTransform: (...m: number[] | [typeof transform]) => void (transform = m.length === 6 ? { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } as typeof transform : (m[0] as typeof transform)),
    drawImage: (_img: unknown, ...r: number[]) => blits.push(r),
  } as unknown as CanvasRenderingContext2D;
  const v = { x: Float32Array.from(xs), y: Float32Array.from(ys), heading: new Float32Array(xs.length), species: new Int32Array(xs.length) } as never;
  const ok = (new EcoRenderer() as unknown as { stampDots(...a: unknown[]): boolean }).stampDots(ctx, v, Int32Array.from(xs.map((_, i) => i)), 0, xs.length, "red", 4.8, 0.5, () => false);
  return { ok, blits, transform };
}

describe("creature dots stamped from an atlas", () => {
  it("lands each dot on whole device pixels, its quarter-pixel offset taken from the atlas cell, and restores the camera", () => {
    arcs.length = 0;
    const { ok, blits, transform } = stamp([100, 101], [40, 40.5]);
    expect(ok).toBe(true);
    expect(arcs[0]![2]).toBe(2.5); // device px radius, quarter-rounded: 4.8 world units at zoom 0.5 is 2.4, then 2.5
    expect(arcs).toHaveLength(16); // one block of 4 x 4 offsets
    // device centres: (60.3, 40.6) and (60.8, 40.85); quarters 241, 162 and 243, 163
    const size = 2 * Math.ceil(2.5 + 1);
    expect(blits[0]).toEqual([1 * size, 2 * size, size, size, 60 - size / 2, 40 - size / 2, size, size]);
    expect(blits[1]).toEqual([3 * size, 3 * size, size, size, 60 - size / 2, 40 - size / 2, size, size]);
    for (const b of blits) expect(b.every(Number.isInteger)).toBe(true);
    expect(transform).toMatchObject({ a: 0.5, e: 10.3, f: 20.6 });
  });

  it("reuses the block for the same colour and size", () => {
    arcs.length = 0;
    const r = new EcoRenderer() as unknown as { dot(style: string, r: number): unknown };
    expect(r.dot("red", 2.5)).toBe(r.dot("red", 2.5));
    expect(arcs).toHaveLength(16);
  });
});
