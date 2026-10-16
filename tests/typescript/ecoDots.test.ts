import { EcoRenderer } from "../../src/typescript/src/ui/ecoScene.ts"; // vi.mock is hoisted above this import
import { snapshotBytes, snapshotViews } from "../../src/typescript/src/worker/ecoProtocol.ts";

const arcs: number[][] = [];
vi.mock("../../src/typescript/src/ui/groundScene.ts", () => ({
  makeCanvas: (width: number, height: number) => ({ width, height, addEventListener() {} }),
  context2d: () => ({ fillStyle: "", beginPath() {}, moveTo() {}, fill() {}, clearRect() {}, setTransform() {}, drawImage() {}, arc: (x: number, y: number, r: number) => arcs.push([x, y, r]) }),
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
  const r = new EcoRenderer() as unknown as { stampDots(...a: unknown[]): boolean; atlasFor(sizes: string): void };
  r.atlasFor("s");
  r.atlasFor("s"); // the size held for a frame: stamping
  const ok = r.stampDots(ctx, ctx.getTransform(), v, Int32Array.from(xs.map((_, i) => i)), 0, xs.length, "red", 4.8, 0.5, () => false);
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

  it("a full atlas draws the remaining colours as paths, and is not cleared within a frame", () => {
    arcs.length = 0;
    const r = new EcoRenderer() as unknown as { dot(style: string, r: number): unknown; atlasFor(sizes: string): void };
    r.atlasFor("a");
    r.atlasFor("a");
    const blocks: unknown[] = [];
    for (let k = 0; k < 700; k++) blocks.push(r.dot(`hsl(${k}, 50%, 50%)`, 9.75)); // blocks of 4 x 22 px: 121 fit in 1024 px
    expect(blocks.filter((b) => b !== null)).toHaveLength(121);
    expect(r.dot("hsl(0, 50%, 50%)", 9.75)).toBe(blocks[0]); // the first ones stay
    r.atlasFor("a");
    expect(r.dot("hsl(0, 50%, 50%)", 9.75)).toBe(blocks[0]);
    r.atlasFor("b");
    r.atlasFor("b"); // another size, held: starts over
    expect(r.dot("hsl(699, 50%, 50%)", 9.75)).not.toBeNull();
  });

  it("draws paths, not stamps, while the dot size changes (a zoom), so the atlas is not redrawn every frame", () => {
    const r = new EcoRenderer() as unknown as { stampDots(...a: unknown[]): boolean; atlasFor(sizes: string): void };
    const m = { a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 };
    const v = { x: Float32Array.of(1), y: Float32Array.of(1), heading: new Float32Array(1), species: new Int32Array(1) };
    const ctx = { drawImage() {}, setTransform() {} };
    for (const size of ["1", "2", "3"]) {
      r.atlasFor(size);
      expect(r.stampDots(ctx, m, v, Int32Array.of(0), 0, 1, "red", 4.8, 0.5, () => false)).toBe(false);
    }
    r.atlasFor("3");
    expect(r.stampDots(ctx, m, v, Int32Array.of(0), 0, 1, "red", 4.8, 0.5, () => false)).toBe(true);
  });

  it("skips a creature at a NaN position instead of stamping it at the corner", () => {
    const { blits } = stamp([Number.NaN, 100], [40, 40]);
    expect(blits).toHaveLength(1);
  });

  it("reuses the block for the same colour and size", () => {
    arcs.length = 0;
    const r = new EcoRenderer() as unknown as { dot(style: string, r: number): unknown };
    expect(r.dot("red", 2.5)).toBe(r.dot("red", 2.5));
    expect(arcs).toHaveLength(16);
  });
});

describe("dim and outline passes", () => {
  it("are stamped opaque into a layer laid down once at their opacity, so overlapping dots do not stack darker", () => {
    const n = 6;
    const v = snapshotViews(new ArrayBuffer(snapshotBytes(n, 0)), n, 0, n, 0);
    for (let i = 0; i < n; i++) {
      v.x[i] = 100 + i; // overlapping
      v.y[i] = 100;
      v.hue[i] = 40;
      v.founder[i] = i % 2; // founder 0 lit, founder 1 dimmed
    }
    const laid: { alpha: number; layer: boolean }[] = [];
    const stamps: { alpha: number }[] = [];
    const fills: { alpha: number; style: string }[] = [];
    let alpha = 1;
    let transform = { a: 0.1, b: 0, c: 0, d: 0.1, e: 0, f: 0 }; // zoomed out: flat dots, not detailed bodies
    const ctx = {
      canvas: { width: 400, height: 300 },
      get globalAlpha() { return alpha; },
      set globalAlpha(a: number) { alpha = a; },
      fillStyle: "",
      getTransform: () => transform,
      setTransform: (...m: unknown[]) => void (transform = m.length === 6 ? { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } as typeof transform : (m[0] as typeof transform)),
      save() {}, restore() { alpha = 1; }, beginPath() {}, moveTo() {}, arc() {},
      fill: () => void fills.push({ alpha, style: (ctx as unknown as { fillStyle: string }).fillStyle }),
      drawImage: (img: { width: number }, ...r: number[]) => (r.length === 2 ? laid.push({ alpha, layer: img.width === 400 }) : stamps.push({ alpha })),
    } as unknown as CanvasRenderingContext2D;
    const cfg = { worldW: 4000, worldH: 2500, radius: 12, itemRadius: 4, species: [{ fullEnergy: 150, hunter: false }] };
    const r = new EcoRenderer() as unknown as { drawCreatures(...a: unknown[]): void };
    for (let frame = 0; frame < 2; frame++) { // the first frame sets the size and draws paths, the second stamps
      laid.length = 0;
      stamps.length = 0;
      fills.length = 0;
      r.drawCreatures(ctx, cfg, v, 0, 4000, 0, 2500, 10, 0.1, 1, 0);
      if (frame === 0) expect(fills.slice(0, 2)).toEqual([{ alpha: 0.3, style: "hsl(150, 12%, 55%)" }, { alpha: 0.75, style: "rgb(6, 12, 9)" }]); // the paths: each opacity once
    }
    expect(laid).toEqual([{ alpha: 0.3, layer: true }, { alpha: 0.75, layer: true }]); // the dim pass, then the outline pass
    expect(stamps.length).toBe(3); // the lit creatures' fills, straight onto the canvas
    expect(stamps.every((st) => st.alpha === 1)).toBe(true);
  });
});
