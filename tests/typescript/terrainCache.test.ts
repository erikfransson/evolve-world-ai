import { TerrainCache } from "../../src/typescript/src/ui/terrainCache.ts"; // vi.mock is hoisted above this import

const draws: { scale: number; view: { x0: number; x1: number; y0: number; y1: number } }[] = [];
vi.mock("../../src/typescript/src/ui/terrainScene.ts", () => ({ drawTerrain: (_g: unknown, _t: unknown, scale: number, view: (typeof draws)[number]["view"]) => draws.push({ scale, view }) }));
vi.mock("../../src/typescript/src/ui/groundScene.ts", () => ({
  makeCanvas: (width: number, height: number) => ({ width, height }),
  context2d: () => ({ setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} }),
}));

const terrain = { width: 30000, height: 18750 } as never;
const blits: number[][] = [];
let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const ctx = { drawImage: (_c: unknown, ...r: number[]) => blits.push(r), getTransform: () => transform, save() {}, restore() {}, setTransform() {} } as unknown as CanvasRenderingContext2D;
const whole = { x0: 0, x1: 30000, y0: 0, y1: 18750 };
let clock = 0;
const later = (): number => (clock += 1000); // frames far enough apart that a rebuild is allowed

describe("TerrainCache", () => {
  beforeEach(() => {
    draws.length = 0;
    blits.length = 0;
  });

  it("draws the map once per zoom and then only copies it, also for small pans inside the margin", () => {
    const c = new TerrainCache();
    for (let k = 0; k < 5; k++) expect(c.draw(ctx, terrain, 0.035, whole, false, later())).toBe(true);
    expect(draws).toHaveLength(1);
    expect(blits).toHaveLength(5);
    const view = { x0: 10000, x1: 15000, y0: 5000, y1: 8000 };
    expect(c.draw(ctx, terrain, 0.2, view, false, later())).toBe(false); // the zoom just changed: drawn directly
    c.draw(ctx, terrain, 0.2, view, false, later()); // held for a frame: cached
    c.draw(ctx, terrain, 0.2, { x0: 10500, x1: 15500, y0: 5200, y1: 8200 }, false, later()); // inside the 25% margin
    expect(draws).toHaveLength(2);
    expect(draws[1]!.view).toEqual({ x0: 8750, x1: 16250, y0: 4250, y1: 8750 });
    c.draw(ctx, terrain, 0.2, { x0: 13000, x1: 18000, y0: 5000, y1: 8000 }, false, later()); // past it
    expect(draws).toHaveLength(3);
  });

  it("at its own zoom the bitmap is copied unscaled onto whole device pixels", () => {
    const c = new TerrainCache();
    transform = { a: 0.2, b: 0, c: 0, d: 0.2, e: -1999.6, f: -999.3 };
    const view = { x0: 10000, x1: 15000, y0: 5000, y1: 8000 };
    c.draw(ctx, terrain, 0.2, view, false, later());
    c.draw(ctx, terrain, 0.2, view, false, later());
    const [sx, sy, sw, sh, dx, dy, dw, dh] = blits.at(-1)!;
    expect([sx, sy, dw, dh]).toEqual([0, 0, sw, sh]);
    expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
    transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  });

  it("while the camera moves it stretches the cached map or draws directly, and redraws the cache once the camera settles", () => {
    const c = new TerrainCache();
    c.draw(ctx, terrain, 0.035, whole, false, later());
    expect(c.draw(ctx, terrain, 0.05, whole, true, later())).toBe(true); // within 2x: stretched
    expect(c.draw(ctx, terrain, 0.2, { x0: 10000, x1: 15000, y0: 5000, y1: 8000 }, true, later())).toBe(false); // too far off: drawn directly
    expect(draws).toHaveLength(1);
    expect(c.draw(ctx, terrain, 0.2, { x0: 10000, x1: 15000, y0: 5000, y1: 8000 }, false, later())).toBe(true);
    expect(draws).toHaveLength(2);
  });

  it("a wheel or pinch zoom (no animation) stretches or draws directly while the zoom changes, and redraws the cache one frame after it stops", () => {
    const c = new TerrainCache();
    c.draw(ctx, terrain, 0.035, whole, false, later());
    for (const z of [0.04, 0.045, 0.05, 0.06]) expect(c.draw(ctx, terrain, z, whole, false, later())).toBe(true);
    expect(draws).toHaveLength(1);
    c.draw(ctx, terrain, 0.06, whole, false, later());
    expect(draws).toHaveLength(2);
  });

  it("a fast pan (no animation flag, as the Ecosystem render worker sends) rebuilds at most every 250 ms and draws directly between", () => {
    const c = new TerrainCache();
    let t = later();
    c.draw(ctx, terrain, 0.2, { x0: 0, x1: 5000, y0: 5000, y1: 8000 }, false, t);
    let direct = 0;
    for (let k = 1; k <= 24; k++) if (!c.draw(ctx, terrain, 0.2, { x0: 1000 * k, x1: 5000 + 1000 * k, y0: 5000, y1: 8000 }, false, (t += 16))) direct++;
    expect(draws.length).toBeLessThanOrEqual(2); // the first frame out of the cached area rebuilds; the frames after it, still uncovered, draw directly
    expect(direct).toBeGreaterThan(20);
    c.draw(ctx, terrain, 0.2, { x0: 30000, x1: 35000, y0: 5000, y1: 8000 }, false, (t += 16)); // the pan stops
    expect(c.draw(ctx, terrain, 0.2, { x0: 30000, x1: 35000, y0: 5000, y1: 8000 }, false, (t += 16))).toBe(true); // held still: cached again
  });

  it("a zoom that settles while the view keeps moving (following a creature) rebuilds the cache", () => {
    const c = new TerrainCache();
    let t = later();
    c.draw(ctx, terrain, 0.2, { x0: 10000, x1: 15000, y0: 5000, y1: 8000 }, false, t);
    c.draw(ctx, terrain, 0.2, { x0: 10000, x1: 15000, y0: 5000, y1: 8000 }, false, (t += 16));
    expect(c.draw(ctx, terrain, 0.035, { x0: 0, x1: 30000, y0: 0, y1: 18750 }, true, (t += 16))).toBe(false);
    for (let k = 1; k <= 30; k++) c.draw(ctx, terrain, 0.035, { x0: k, x1: 30000 + k, y0: 0, y1: 18750 }, false, (t += 16));
    expect(draws.at(-1)!.scale).toBe(0.035);
  });

  it("a bitmap past 8 million pixels is never made: the caller draws the map directly", () => {
    const c = new TerrainCache();
    expect(c.draw(ctx, terrain, 0.2, whole, false, later())).toBe(false); // 6000 x 3750 = 22.5 M px
    expect(draws).toHaveLength(0);
  });
});
