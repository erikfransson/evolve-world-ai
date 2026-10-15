// Canvas stand-ins that count what is painted: the bitmaps made and the fills and strokes the main canvas receives.
const bitmaps: { w: number; h: number }[] = [];
const MAX_PX = 8_000_000; // MAX_BAKED_PX in groundScene.ts
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
const paints = (): number => drawn.filter((c) => c.startsWith("fill") || c.startsWith("stroke")).length;

// The Inland Sea with its own bitmap store (the modules are loaded again), and a view of 1600 x 900 px centred on its biggest patch.
async function inlandSea() {
  vi.resetModules();
  const { ECO_PRESETS } = await import("../../src/typescript/src/sim/presets.ts");
  await import("../../src/typescript/src/sim/maps/index.ts");
  const { terrainOf } = await import("../../src/typescript/src/sim/terrain.ts");
  const { fineOf, groundBodies } = await import("../../src/typescript/src/ui/groundOutline.ts");
  const { bakedPixels, drawGround } = await import("../../src/typescript/src/ui/groundScene.ts");
  const terrain = terrainOf({ seed: 1, world: ECO_PRESETS.find((p) => p.id === "inland-sea")!.world });
  const big = groundBodies(terrain, fineOf(terrain)).reduce((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a));
  const cx = (big.x0 + big.x1) / 2;
  const cy = (big.y0 + big.y1) / 2;
  const frame = (scale: number): void => drawGround(mainCtx(scale), terrain, scale, { x0: cx - 800 / scale, x1: cx + 800 / scale, y0: cy - 450 / scale, y1: cy + 450 / scale }, false);
  // Frames at one scale until one makes no new bitmap, as the page does while it is looked at. Returns the frames it took.
  const settle = (scale: number): number => {
    let frames = 0;
    for (let made = -1; made !== bitmaps.length && frames < 200; frames++) {
      made = bitmaps.length;
      frame(scale);
    }
    return frames;
  };
  return { big, frame, settle, pixels: () => bakedPixels(terrain) };
}

describe("ground bitmaps of a patch larger than one bitmap", () => {
  beforeAll(() => {
    vi.stubGlobal("Path2D", class { moveTo(): void {} lineTo(): void {} quadraticCurveTo(): void {} closePath(): void {} });
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    vi.stubGlobal("DOMMatrix", class { scale(): this { return this; } });
  });
  afterAll(() => vi.unstubAllGlobals());

  it("is larger than one bitmap at the scales it is drawn from", async () => {
    const { big } = await inlandSea();
    expect(Math.max(big.x1 - big.x0, big.y1 - big.y0) * 0.08).toBeGreaterThan(640);
  });

  it("bakes one bitmap per frame, then draws from bitmaps of at most 640 px and paints nothing on the canvas", async () => {
    const { frame, settle } = await inlandSea();
    settle(0.05); // the textures, rim images and probe canvas, made once
    const from = bitmaps.length;
    frame(0.1);
    expect(bitmaps.length - from).toBe(1);
    expect(settle(0.1)).toBeGreaterThan(2);
    expect(bitmaps.slice(from).some((b) => b.w === 640 || b.h === 640)).toBe(true);
    expect(bitmaps.every((b) => b.w <= 640 && b.h <= 640)).toBe(true);
    drawn.length = 0;
    const made = bitmaps.length;
    frame(0.1);
    expect([paints(), bitmaps.length - made]).toEqual([0, 0]);
  });

  it("keeps a tier's bitmaps when the view moves to another tier and back", async () => {
    const { frame, settle } = await inlandSea();
    settle(0.1); // tier 0.16
    settle(0.05); // tier 0.08
    drawn.length = 0;
    const made = bitmaps.length;
    frame(0.1);
    frame(0.05);
    expect([paints(), bitmaps.length - made]).toEqual([0, 0]);
  });

  it("on a zoom in draws from the tier just left and paints nothing live while the new tier is baked", async () => {
    const { frame, settle } = await inlandSea();
    settle(0.05); // tier 0.08 covers the whole map
    drawn.length = 0;
    const made = bitmaps.length;
    for (let i = 0; i < 4; i++) frame(0.1); // tier 0.16, not yet baked
    expect([paints(), bitmaps.length - made]).toEqual([0, 4]);
  });

  it("on a zoom out paints live what the tier just left does not cover, then settles", async () => {
    const { frame, settle } = await inlandSea();
    settle(0.3); // tier 0.32: only the tiles of a small view
    drawn.length = 0;
    frame(0.05);
    expect(paints()).toBeGreaterThan(0);
    settle(0.05);
    drawn.length = 0;
    frame(0.05);
    expect(paints()).toBe(0);
  });

  it("holds at most the pixel budget however the scale changes", async () => {
    const { settle, pixels } = await inlandSea();
    for (const s of [0.02, 0.05, 0.1, 0.2, 0.3, 0.05, 0.3]) {
      settle(s);
      expect(pixels()).toBeLessThanOrEqual(MAX_PX);
    }
  });

  it("drops the tier least recently used first: A, B, A, C loses B", async () => {
    const { settle, pixels } = await inlandSea();
    for (const s of [0.05, 0.1, 0.05, 0.23]) settle(s); // tiers 0.08 (A, 0.9M px), 0.16 (B, 3.3M), 0.08, 0.32 (C, 6.1M): C needs B gone, then A fits beside it
    expect(pixels()).toBeLessThanOrEqual(MAX_PX);
    const made = bitmaps.length;
    settle(0.05); // A is still there
    expect(bitmaps.length - made).toBe(0);
    settle(0.1); // B is rebuilt
    expect(bitmaps.length - made).toBeGreaterThan(0);
  });
});
