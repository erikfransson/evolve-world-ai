import { TerrainCache } from "../../src/typescript/src/ui/terrainCache.ts"; // vi.mock is hoisted above this import

const draws: { scale: number; view: { x0: number; x1: number; y0: number; y1: number } }[] = [];
vi.mock("../../src/typescript/src/ui/terrainScene.ts", () => ({ drawTerrain: (_g: unknown, _t: unknown, scale: number, view: (typeof draws)[number]["view"]) => draws.push({ scale, view }) }));
vi.mock("../../src/typescript/src/ui/groundScene.ts", () => ({
  makeCanvas: (width: number, height: number) => ({ width, height }),
  context2d: () => ({ setTransform() {}, clearRect() {} }),
}));

const terrain = { width: 30000, height: 18750 } as never;
const blits: number[][] = [];
const ctx = { drawImage: (_c: unknown, ...r: number[]) => blits.push(r) } as unknown as CanvasRenderingContext2D;
const whole = { x0: 0, x1: 30000, y0: 0, y1: 18750 };

describe("TerrainCache", () => {
  beforeEach(() => {
    draws.length = 0;
    blits.length = 0;
  });

  it("draws the map once per zoom and then only copies it, also for small pans inside the margin", () => {
    const c = new TerrainCache();
    for (let k = 0; k < 5; k++) expect(c.draw(ctx, terrain, 0.035, whole, false)).toBe(true);
    expect(draws).toHaveLength(1);
    expect(blits).toHaveLength(5);
    const view = { x0: 10000, x1: 15000, y0: 5000, y1: 8000 };
    expect(c.draw(ctx, terrain, 0.2, view, false)).toBe(false); // the zoom just changed: drawn directly
    c.draw(ctx, terrain, 0.2, view, false); // held for a frame: cached
    c.draw(ctx, terrain, 0.2, { x0: 10500, x1: 15500, y0: 5200, y1: 8200 }, false); // inside the 25% margin
    expect(draws).toHaveLength(2);
    expect(draws[1]!.view).toEqual({ x0: 8750, x1: 16250, y0: 4250, y1: 8750 });
    c.draw(ctx, terrain, 0.2, { x0: 13000, x1: 18000, y0: 5000, y1: 8000 }, false); // past it
    expect(draws).toHaveLength(3);
  });

  it("while the camera moves it stretches the cached map or draws directly, and redraws the cache once the camera settles", () => {
    const c = new TerrainCache();
    c.draw(ctx, terrain, 0.035, whole, false);
    expect(c.draw(ctx, terrain, 0.05, whole, true)).toBe(true); // within 2x: stretched
    expect(c.draw(ctx, terrain, 0.2, { x0: 10000, x1: 15000, y0: 5000, y1: 8000 }, true)).toBe(false); // too far off: drawn directly
    expect(draws).toHaveLength(1);
    expect(c.draw(ctx, terrain, 0.2, { x0: 10000, x1: 15000, y0: 5000, y1: 8000 }, false)).toBe(true);
    expect(draws).toHaveLength(2);
  });

  it("a wheel or pinch zoom (no animation) stretches or draws directly while the zoom changes, and redraws the cache one frame after it stops", () => {
    const c = new TerrainCache();
    c.draw(ctx, terrain, 0.035, whole, false);
    for (const z of [0.04, 0.045, 0.05, 0.06]) expect(c.draw(ctx, terrain, z, whole, false)).toBe(true);
    expect(draws).toHaveLength(1);
    c.draw(ctx, terrain, 0.06, whole, false);
    expect(draws).toHaveLength(2);
  });

  it("a bitmap past 8 million pixels is never made: the caller draws the map directly", () => {
    const c = new TerrainCache();
    expect(c.draw(ctx, terrain, 0.2, whole, false)).toBe(false); // 6000 x 3750 = 22.5 M px
    expect(draws).toHaveLength(0);
  });
});
