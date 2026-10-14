import { TICK_SECONDS, WARMUP_TICKS, arenaScene, ecosystemScene, inlandMapScene } from "../../src/typescript/src/ui/landing/index.ts";
import { ECO_CAP } from "../../src/typescript/src/ui/landing/ecosystem.ts";
import { MAP_CAP, rockAt } from "../../src/typescript/src/ui/landing/inlandMap.ts";
import { parseStats, statsText, statsUrl } from "../../src/typescript/src/ui/landing/liveStats.ts";

const TICKS = Math.round(60 / TICK_SECONDS);

// Canvas stub that throws on a non-finite number or negative arc radius passed to a drawing call.
// Plain throws, because one vitest expect per number made the draws the slowest part of the suite.
function finiteCtx(): CanvasRenderingContext2D {
  const check = (...args: unknown[]): void => {
    for (const a of args) if (typeof a === "number" && !Number.isFinite(a)) throw new Error(`non-finite drawing value ${a}`);
  };
  const canvas = { width: 720, height: 450 };
  return new Proxy({}, { get: (_, k) => (k === "canvas" ? canvas : k === "createRadialGradient" || k === "createLinearGradient" ? (...a: unknown[]) => { check(...a); return { addColorStop: check }; } : k === "arc" ? (...a: unknown[]) => { check(...a); if (!((a[2] as number) >= 0)) throw new Error(`negative arc radius ${String(a[2])}`); } : check), set: (_, _k, v) => { check(v); return true; } }) as unknown as CanvasRenderingContext2D;
}

describe("ecosystemScene births", () => {
  it("gives birth several times, keeps the cap, stays finite", () => {
    const scene = ecosystemScene(7);
    const ctx = finiteCtx();
    for (let t = 1; t <= TICKS + WARMUP_TICKS; t++) {
      scene.step();
      expect(scene.living()).toBeLessThanOrEqual(ECO_CAP);
      expect(scene.living()).toBeGreaterThan(0);
      if (t % 5 === 0) scene.draw(ctx);
    }
    expect(scene.births).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic per seed", () => {
    const a = ecosystemScene(3);
    const b = ecosystemScene(3);
    for (let t = 0; t < 1500; t++) { a.step(); b.step(); }
    expect(a.births).toBe(b.births);
  });
});

describe("arenaScene", () => {
  const record = (): { ctx: CanvasRenderingContext2D; calls: unknown[][] } => {
    const calls: unknown[][] = [];
    const ctx = new Proxy({}, { get: (_, k) => (k === "canvas" ? { width: 720, height: 450 } : (...args: unknown[]) => calls.push([k, ...args])), set: () => true }) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  };

  it("stays finite and deterministic through a whole learning loop", () => {
    const [a, b] = [arenaScene(7), arenaScene(7)];
    const ctx = finiteCtx();
    for (let t = 1; t <= 2200; t++) {
      a.step();
      b.step();
      if (t % 7 === 0) a.draw(ctx);
    }
    expect(a.rewards).toBe(b.rewards);
    expect(a.penalties).toBe(b.penalties);
    const [ra, rb] = [record(), record()];
    a.draw(ra.ctx);
    b.draw(rb.ctx);
    expect(ra.calls).toEqual(rb.calls);
  });

  it("pays out a reward every few seconds across the four boxes", () => {
    const scene = arenaScene(7);
    for (let t = 0; t < WARMUP_TICKS; t++) scene.step();
    const before = scene.rewards;
    for (let t = 0; t < TICKS; t++) scene.step();
    // 60 simulated seconds are 40 s on the page: a plus about every half second somewhere.
    expect(scene.rewards - before).toBeGreaterThanOrEqual(60);
    expect(scene.rewards - before).toBeLessThanOrEqual(170);
  });

  it("never lets the learner sit on poison without the penalty", () => {
    for (const seed of [1, 7, 21]) {
      const scene = arenaScene(seed);
      for (let t = 0; t < 2200; t++) {
        scene.step();
        expect(scene.poisonOverlaps()).toBe(0);
      }
      expect(scene.penalties).toBeGreaterThan(0); // the early, clumsy part brushes poison now and then
      expect(scene.penalties).toBeLessThan(scene.rewards / 3);
    }
  });
});

describe("inlandMapScene", () => {
  it("keeps its creatures off rock and under the cap, with births and deaths, and stays finite", () => {
    const scene = inlandMapScene(7);
    const ctx = finiteCtx();
    const start = scene.living();
    let low = Infinity;
    for (let t = 1; t <= 3 * TICKS; t++) {
      scene.step();
      expect(scene.living()).toBeLessThanOrEqual(MAP_CAP);
      low = Math.min(low, scene.living());
      if (t % 30 === 0) {
        for (const d of scene.dots()) expect(rockAt(d.x, d.y)).toBe(false);
        scene.draw(ctx);
      }
    }
    expect(start).toBeGreaterThan(150);
    expect(low).toBeGreaterThan(80); // the world never empties
    expect(scene.births).toBeGreaterThan(50);
    expect(scene.deaths).toBeGreaterThan(50);
  });

  it("is deterministic per seed", () => {
    const a = inlandMapScene(3);
    const b = inlandMapScene(3);
    for (let t = 0; t < 600; t++) { a.step(); b.step(); }
    expect(a.births).toBe(b.births);
    expect(a.dots()).toEqual(b.dots());
  });
});

describe("live stats line", () => {
  it("reads the server's stats address from its WebSocket address", () => {
    expect(statsUrl("wss://example.ts.net")).toBe("https://example.ts.net/stats");
    expect(statsUrl("ws://127.0.0.1:8787/?x=1")).toBe("http://127.0.0.1:8787/stats");
  });

  it("accepts only two whole numbers in range", () => {
    expect(parseStats('{"creatures":2987,"viewers":4}')).toEqual({ creatures: 2987, viewers: 4 });
    for (const bad of ["", "null", "[]", '"x"', '{"creatures":1.5,"viewers":1}', '{"creatures":-1,"viewers":1}', '{"creatures":1e9,"viewers":1}', '{"creatures":"5","viewers":1}', '{"creatures":5}', `{"creatures":1,"viewers":1,"pad":"${"x".repeat(600)}"}`]) {
      expect(parseStats(bad), bad.slice(0, 40)).toBeNull();
    }
    expect(statsText({ creatures: 2987, viewers: 4 })).toBe("2,987 creatures alive · 4 watching");
    expect(statsText({ creatures: 0, viewers: 1 })).toBe("No creatures right now, add the first one · 1 watching");
    expect(statsText({ creatures: 1, viewers: 0 })).toBe("1 creature alive");
  });
});
