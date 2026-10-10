import { TICK_SECONDS, WARMUP_TICKS, ecosystemScene } from "../../src/typescript/src/ui/landingScenes.ts";

const TICKS = Math.round(60 / TICK_SECONDS);

// Canvas stub that fails on a non-finite number or negative arc radius passed to a drawing call.
function finiteCtx(): CanvasRenderingContext2D {
  const check = (...args: unknown[]): void => { for (const a of args) if (typeof a === "number") expect(Number.isFinite(a)).toBe(true); };
  const canvas = { width: 720, height: 450 };
  return new Proxy({}, { get: (_, k) => (k === "canvas" ? canvas : k === "arc" ? (...a: unknown[]) => { check(...a); expect(a[2]).toBeGreaterThanOrEqual(0); } : check), set: (_, _k, v) => { check(v); return true; } }) as unknown as CanvasRenderingContext2D;
}

describe("ecosystemScene births", () => {
  it("gives birth several times, keeps the cap, stays finite", () => {
    const scene = ecosystemScene(7);
    const ctx = finiteCtx();
    let firstBirth = -1;
    for (let t = 1; t <= TICKS + WARMUP_TICKS; t++) {
      scene.step();
      if (firstBirth < 0 && scene.births > 0) firstBirth = t;
      expect(scene.living()).toBeLessThanOrEqual(6);
      expect(scene.living()).toBeGreaterThan(0);
      if (t % 5 === 0) scene.draw(ctx);
    }
    expect(scene.births).toBeGreaterThanOrEqual(3);
    // Seen within 3-5 s after the warm-up at the page's 1.5x speed.
    const seen = ((firstBirth - WARMUP_TICKS) * TICK_SECONDS) / 1.5;
    expect(seen).toBeGreaterThan(3);
    expect(seen).toBeLessThan(5);
  });

  it("is deterministic per seed", () => {
    const a = ecosystemScene(3);
    const b = ecosystemScene(3);
    for (let t = 0; t < 1500; t++) { a.step(); b.step(); }
    expect(a.births).toBe(b.births);
  });
});
