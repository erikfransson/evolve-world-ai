import { TerrainCache, cacheStep } from "../../src/typescript/src/ui/terrainCache.ts"; // vi.mock is hoisted above this import

const draws: { scale: number; view: { x0: number; x1: number; y0: number; y1: number } }[] = [];
const ground = vi.hoisted(() => ({ complete: true, ready: false, prepares: 0 })); // what the mocked drawTerrain and prepareTerrain report
vi.mock("../../src/typescript/src/ui/terrainScene.ts", () => ({
  drawTerrain: (_g: unknown, _t: unknown, scale: number, view: (typeof draws)[number]["view"]) => (draws.push({ scale, view }), ground.complete),
  prepareTerrain: () => (ground.prepares++, ground.ready),
}));
vi.mock("../../src/typescript/src/ui/groundScene.ts", () => ({
  makeCanvas: (width: number, height: number) => ({ width, height, addEventListener() {} }),
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
    c.draw(ctx, terrain, 0.2, view, false, later()); // the first frame builds and already copies unscaled
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

  it("a map drawn with stand-in ground is not kept: its bitmaps are prepared while it shows, then it is drawn again once, complete", () => {
    const c = new TerrainCache();
    Object.assign(ground, { complete: false, ready: false, prepares: 0 });
    c.draw(ctx, terrain, 0.035, whole, false, later()); // built with a stand-in
    for (let k = 0; k < 3; k++) expect(c.draw(ctx, terrain, 0.035, whole, false, later())).toBe(true);
    expect(draws).toHaveLength(1);
    expect(ground.prepares).toBe(3);
    Object.assign(ground, { complete: true, ready: true });
    c.draw(ctx, terrain, 0.035, whole, false, later()); // all there: redrawn
    expect(draws).toHaveLength(2);
    for (let k = 0; k < 3; k++) c.draw(ctx, terrain, 0.035, whole, false, later());
    expect([draws.length, ground.prepares]).toEqual([2, 4]); // complete now: nothing more prepared or drawn
  });

  it("another map (a map switch) rebuilds at once, never showing the old one", () => {
    const c = new TerrainCache();
    const other = { width: 30000, height: 18750 } as never;
    c.draw(ctx, terrain, 0.035, whole, false, later());
    c.draw(ctx, terrain, 0.035, whole, false, later());
    expect(c.draw(ctx, other, 0.035, whole, false, later())).toBe(true);
    expect(draws).toHaveLength(2);
  });

  it("a bitmap past 8 million pixels is never made: the caller draws the map directly", () => {
    const c = new TerrainCache();
    expect(c.draw(ctx, terrain, 0.2, whole, false, later())).toBe(false); // 6000 x 3750 = 22.5 M px
    expect(draws).toHaveLength(0);
  });
});

describe("cacheStep, the rebuild policy", () => {
  const world = { width: 30000, height: 18750 };
  const view = { x0: 10000, x1: 15000, y0: 5000, y1: 8000 };
  const area = { x0: 8750, x1: 16250, y0: 4250, y1: 8750 };
  const memo = (o: Partial<Parameters<typeof cacheStep>[0]> = {}) => ({ ready: true, zoom: 0.2, area, builtAt: 0, lastZoom: 0.2, lastX: view.x0, lastY: view.y0, lastCovered: true, ...o });
  const step = (o: Partial<Parameters<typeof cacheStep>[0]>, v = view, zoom = 0.2, animating = false, now = 10_000) => cacheStep(memo(o), world, zoom, v, animating, now).step;

  it("copies a bitmap that covers the view at its zoom, and builds one when there is none", () => {
    expect(step({})).toBe("cached");
    expect(step({ ready: false })).toBe("rebuild");
  });

  it("while the zoom changes: stretches a bitmap within 2x, draws directly past it; rebuilds once the zoom holds", () => {
    expect(cacheStep(memo({ zoom: 0.15, lastZoom: 0.17 }), world, 0.18, view, false, 10_000).step).toBe("cached"); // stretched
    expect(cacheStep(memo({ zoom: 0.05, lastZoom: 0.17 }), world, 0.18, view, false, 10_000).step).toBe("direct"); // past 2x
    expect(cacheStep(memo({ zoom: 0.15, lastZoom: 0.18 }), world, 0.18, view, false, 10_000).step).toBe("rebuild"); // settled
    expect(cacheStep(memo({ zoom: 0.15, lastZoom: 0.18 }), world, 0.18, view, true, 10_000).step).toBe("cached"); // an animation still running: stretched
    expect(cacheStep(memo({ zoom: 0.15, lastZoom: 0.18, builtAt: 9_900 }), world, 0.18, view, false, 10_000).step).toBe("direct"); // settled, but within 250 ms of the last rebuild
  });

  it("a pan out of the cached area rebuilds on its first frame out or once still, at most every 250 ms, and draws directly between", () => {
    const out = { x0: 15000, x1: 20000, y0: 5000, y1: 8000 };
    expect(step({ lastCovered: true }, out)).toBe("rebuild"); // first frame out
    expect(step({ lastCovered: true, builtAt: 9_900 }, out)).toBe("direct"); // too soon after the last rebuild
    expect(step({ lastCovered: false, lastX: 14000 }, out)).toBe("direct"); // still moving, already out
    expect(step({ lastCovered: false, lastX: out.x0 }, out)).toBe("rebuild"); // held still
  });

  it("counts the view as covered at the world edge despite float error in the area", () => {
    const whole = { x0: 0, x1: 30000, y0: 0, y1: 18750 };
    const z = 0.035;
    const a = { x0: 0, x1: Math.ceil(30000 * z) / z, y0: 0, y1: Math.ceil(18750 * z) / z };
    expect(a.x1).toBeLessThan(30000);
    expect(cacheStep(memo({ zoom: z, lastZoom: z, area: a, lastX: 0, lastY: 0 }), world, z, whole, false, 10_000)).toEqual({ step: "cached", covered: true });
  });
});
