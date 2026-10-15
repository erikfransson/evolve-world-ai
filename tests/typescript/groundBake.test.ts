import { ECO_PRESETS } from "../../src/typescript/src/sim/presets.ts";
import "../../src/typescript/src/sim/maps/index.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { fineOf, groundBodies } from "../../src/typescript/src/ui/groundOutline.ts";
import { bakedPixels, drawGround } from "../../src/typescript/src/ui/groundScene.ts";

// Canvas stand-ins that count what is painted: the bitmaps made and the fills and strokes the main canvas receives.
const bitmaps: { w: number; h: number }[] = [];
const MAX_PX = 16_000_000; // MAX_BAKED_PX in groundScene.ts
class FakeOffscreen {
  constructor(width: number, height: number) {
    bitmaps.push({ w: width, h: height });
  }
  getContext = (): unknown => new Proxy({}, { get: (_, k) => (k === "createRadialGradient" ? () => ({ addColorStop: () => undefined }) : k === "createPattern" ? () => ({ setTransform: () => undefined }) : () => undefined), set: () => true });
}
const drawn: string[] = [];
const mainCtx = (scale: number): CanvasRenderingContext2D =>
  new Proxy({}, {
    get: (_, k) => (k === "getTransform" ? () => ({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }) : k === "createPattern" ? () => ({ setTransform: () => undefined }) : (...a: unknown[]) => void drawn.push(`${String(k)}${a.length}`)),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;

const sea = ECO_PRESETS.find((p) => p.id === "inland-sea")!.world;
const terrain = terrainOf({ seed: 1, world: sea });
const big = groundBodies(terrain, fineOf(terrain)).reduce((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a));
const cx = (big.x0 + big.x1) / 2;
const cy = (big.y0 + big.y1) / 2;
const view = (scale: number) => ({ x0: cx - 800 / scale, x1: cx + 800 / scale, y0: cy - 450 / scale, y1: cy + 450 / scale });
const frame = (scale: number): void => drawGround(mainCtx(scale), terrain, scale, view(scale), false);
const paints = (): number => drawn.filter((c) => c.startsWith("fill") || c.startsWith("stroke")).length;

describe("ground bitmaps of a patch larger than one bitmap", () => {
  beforeAll(() => {
    vi.stubGlobal("Path2D", class { moveTo(): void {} lineTo(): void {} quadraticCurveTo(): void {} closePath(): void {} });
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    vi.stubGlobal("DOMMatrix", class { scale(): this { return this; } });
  });
  afterAll(() => vi.unstubAllGlobals());

  it("is larger than one bitmap at the scales it is drawn from", () => {
    expect(Math.max(big.x1 - big.x0, big.y1 - big.y0) * 0.04).toBeGreaterThan(640);
  });

  it("draws a view from bitmaps of at most 640 px, and the next frame paints nothing on the canvas", () => {
    frame(0.05);
    expect(bitmaps.some((b) => b.w === 640 || b.h === 640)).toBe(true);
    expect(bitmaps.every((b) => b.w <= 640 && b.h <= 640)).toBe(true);
    drawn.length = 0;
    const made = bitmaps.length;
    frame(0.05);
    expect([paints(), bitmaps.length - made]).toEqual([0, 0]);
  });

  it("keeps a tier's bitmaps when the view moves to another tier and back", () => {
    frame(0.05); // tier 0.08
    frame(0.1); // tier 0.16
    drawn.length = 0;
    const made = bitmaps.length;
    frame(0.05);
    frame(0.1);
    expect([paints(), bitmaps.length - made]).toEqual([0, 0]);
  });

  it("holds at most the pixel budget however the scale changes", () => {
    for (const s of [0.02, 0.05, 0.1, 0.2, 0.3, 0.05, 0.3]) {
      frame(s);
      expect(bakedPixels(terrain)).toBeLessThanOrEqual(MAX_PX);
    }
  });
});
