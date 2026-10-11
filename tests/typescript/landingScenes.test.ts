import { TICK_SECONDS, WARMUP_TICKS, ecosystemScene, predatorScene } from "../../src/typescript/src/ui/landingScenes.ts";

import { arenaScene } from "../../src/typescript/src/ui/arenaCardScene.ts";

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

describe("predatorScene", () => {
  it("chases and catches prey every few seconds, keeps the herd, stays finite and deterministic", () => {
    const scene = predatorScene(7);
    const ctx = finiteCtx();
    for (let t = 0; t < WARMUP_TICKS; t++) scene.step();
    const caught = scene.catches;
    for (let t = 1; t <= TICKS; t++) {
      scene.step();
      expect(scene.prey()).toBeGreaterThanOrEqual(3);
      expect(scene.prey()).toBeLessThanOrEqual(5);
      if (t % 5 === 0) scene.draw(ctx);
    }
    // 60 simulated seconds are 40 s on the page at 1.5x: a catch every 3 to 10 s on screen.
    expect(scene.catches - caught).toBeGreaterThanOrEqual(4);
    expect(scene.catches - caught).toBeLessThanOrEqual(13);
    expect(scene.births).toBeGreaterThanOrEqual(scene.catches - 1);
    const again = predatorScene(7);
    for (let t = 0; t < WARMUP_TICKS + TICKS; t++) again.step();
    expect(again.catches).toBe(scene.catches);
  });

  it("catches a prey whenever it visibly touches the hunter, never overlapping otherwise", () => {
    for (const seed of [1, 7, 21]) {
      const scene = predatorScene(seed);
      for (let t = 0; t < WARMUP_TICKS + TICKS; t++) {
        scene.step();
        expect(scene.overlaps()).toBe(0);
      }
    }
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
