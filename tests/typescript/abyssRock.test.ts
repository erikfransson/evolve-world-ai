export {}; // a module: its names stay out of the other test files

// Rock images are built a frame's share at a time: a canvas stand-in records the images made (filled from pixels) per draw.
const images: { w: number; h: number; filled: boolean }[] = [];
const BUILD_CELLS = 120_000; // in abyssRock.ts
class FakeOffscreen {
  private readonly rec: (typeof images)[number];
  constructor(width: number, height: number) {
    this.rec = { w: width, h: height, filled: false };
    images.push(this.rec);
  }
  getContext = (): unknown => {
    const rec = this.rec;
    return new Proxy({}, { get: (_, k) => (k === "putImageData" ? () => void (rec.filled = true) : () => undefined), set: () => true });
  };
}
const ctx = new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
const built = (from: number): (typeof images)[number][] => images.slice(from).filter((b) => b.filled);

describe("rock images", () => {
  beforeAll(() => {
    vi.stubGlobal("Path2D", class { moveTo(): void {} lineTo(): void {} quadraticCurveTo(): void {} closePath(): void {} });
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    vi.stubGlobal("DOMMatrix", class { scale(): this { return this; } });
    if (typeof ImageData === "undefined") vi.stubGlobal("ImageData", class {});
  });
  afterAll(() => vi.unstubAllGlobals());

  it("are built a frame's share per draw, the draw says so while some wait, and prepareRock finishes them", async () => {
    vi.resetModules();
    const { ECO_PRESETS } = await import("../../src/typescript/src/sim/presets.ts");
    await import("../../src/typescript/src/sim/maps/index.ts");
    const { terrainOf } = await import("../../src/typescript/src/sim/terrain.ts");
    const { drawRock, prepareRock } = await import("../../src/typescript/src/ui/abyssRock.ts");
    const t = terrainOf({ seed: 1, world: ECO_PRESETS.find((p) => p.id === "inland-sea")!.world });
    const view = { x0: 0, x1: t.width, y0: 0, y1: t.height };
    const scale = 0.032;
    const start = images.length;
    expect(drawRock(ctx, t, scale, view, false)).toBe(false);
    const first = built(start);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length === 1 || first.reduce((s, b) => s + b.w * b.h, 0) <= BUILD_CELLS).toBe(true);
    let calls = 0;
    while (!prepareRock(t, scale, view) && calls < 1000) calls++;
    expect(calls).toBeGreaterThan(0);
    expect(built(start).length).toBeGreaterThan(first.length);
    const made = images.length;
    expect(drawRock(ctx, t, scale, view, false)).toBe(true);
    expect(images.length - made).toBe(0);
  });

  it("on a farm of workers are asked for once, drawn as stand-ins meanwhile, from the same body data as here", async () => {
    vi.resetModules();
    const { ECO_PRESETS } = await import("../../src/typescript/src/sim/presets.ts");
    await import("../../src/typescript/src/sim/maps/index.ts");
    const { terrainOf } = await import("../../src/typescript/src/sim/terrain.ts");
    const { drawRock, prepareRock, useRockFarm, rasterPixels, haloPixels } = await import("../../src/typescript/src/ui/abyssRock.ts");
    const { rockFarm } = await import("../../src/typescript/src/ui/rockFarm.ts");
    type Job = Parameters<typeof rasterPixels>[0];
    const t = terrainOf({ seed: 1, world: ECO_PRESETS.find((p) => p.id === "inland-sea")!.world });
    const view = { x0: 0, x1: t.width, y0: 0, y1: t.height };
    const scale = 0.032;
    const asked: { job: Job; cell: number; halo: boolean }[] = [];
    const fake = () => {
      const w = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null as (() => void) | null,
        postMessage(m: { n: number; job: Job; cell: number; halo: boolean }) {
          asked.push(m);
          queueMicrotask(() => w.onmessage?.({ data: { n: m.n, pixels: m.halo ? haloPixels(m.job, m.cell) : rasterPixels(m.job, m.cell) } } as MessageEvent));
        },
        terminate() {},
      };
      return w as unknown as Worker;
    };
    useRockFarm(rockFarm(2, fake));
    const start = images.length;
    expect(drawRock(ctx, t, scale, view, false)).toBe(false);
    expect(built(start)).toHaveLength(0); // nothing built on this thread
    const n = asked.length;
    expect(n).toBeGreaterThan(2);
    expect(prepareRock(t, scale, view)).toBe(false);
    expect(asked.length).toBe(n); // asked once
    await new Promise((r) => setTimeout(r, 0));
    expect(built(start)).toHaveLength(n);
    expect(prepareRock(t, scale, view)).toBe(true);
    expect(drawRock(ctx, t, scale, view, false)).toBe(true);
    const { rockBodies } = await import("../../src/typescript/src/ui/rockOutline.ts");
    const a = asked.find((m) => !m.halo)!;
    expect(a.job.body.loops).toEqual(rockBodies(t).find((b) => b.x0 === a.job.body.x0 && b.y0 === a.job.body.y0)!.loops); // the worker gets the body as it is here
    useRockFarm(null);
  }, 60_000);
  it("on a farm whose worker fails are built on this thread instead", async () => {
    vi.resetModules();
    const { ECO_PRESETS } = await import("../../src/typescript/src/sim/presets.ts");
    await import("../../src/typescript/src/sim/maps/index.ts");
    const { terrainOf } = await import("../../src/typescript/src/sim/terrain.ts");
    const { drawRock, prepareRock, useRockFarm } = await import("../../src/typescript/src/ui/abyssRock.ts");
    const { rockFarm } = await import("../../src/typescript/src/ui/rockFarm.ts");
    const t = terrainOf({ seed: 1, world: ECO_PRESETS.find((p) => p.id === "inland-sea")!.world });
    const broken = () => {
      const w = { onmessage: null, onerror: null as (() => void) | null, postMessage() { queueMicrotask(() => w.onerror?.()); }, terminate() {} };
      return w as unknown as Worker;
    };
    useRockFarm(rockFarm(1, broken));
    const view = { x0: 0, x1: t.width, y0: 0, y1: t.height };
    const start = images.length;
    expect(drawRock(ctx, t, 0.032, view, false)).toBe(false);
    expect(built(start)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    let calls = 0;
    while (!prepareRock(t, 0.032, view) && calls < 2000) calls++;
    expect(built(start).length).toBeGreaterThan(0);
    expect(drawRock(ctx, t, 0.032, view, false)).toBe(true);
    useRockFarm(null);
  }, 60_000);
});
