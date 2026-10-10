import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { collide, decaysFor, keepInside, stepBody } from "../../src/typescript/src/sim/physics.ts";
import type { CreatureState } from "../../src/typescript/src/sim/types.ts";

const body = (x: number, y: number, vx: number, vy: number) => ({ x, y, vx, vy });

describe("collide", () => {
  it("separates overlapping discs to touching and conserves momentum", () => {
    const a = body(100, 100, 30, -5);
    const b = body(115, 108, -20, 10);
    const px = a.vx + b.vx;
    const py = a.vy + b.vy;
    const cx = a.x + b.x;
    const cy = a.y + b.y;
    expect(collide(a, b, 12, 0.5)).toBe(true);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(24, 9);
    expect(a.vx + b.vx).toBeCloseTo(px, 9);
    expect(a.vy + b.vy).toBeCloseTo(py, 9);
    expect(a.x + b.x).toBeCloseTo(cx, 9); // pushed half each
    expect(a.y + b.y).toBeCloseTo(cy, 9);
  });

  it("restitution 1 swaps the normal velocities of a head-on pair; 0 leaves them moving together", () => {
    const a = body(0, 0, 10, 3);
    const b = body(20, 0, -4, 0);
    collide(a, b, 12, 1);
    expect([a.vx, a.vy, b.vx, b.vy]).toEqual([-4, 3, 10, 0]);
    const c = body(0, 0, 10, 0);
    const d = body(20, 0, -4, 0);
    collide(c, d, 12, 0);
    expect(c.vx).toBeCloseTo(3, 12);
    expect(d.vx).toBeCloseTo(3, 12);
  });

  it("leaves separating or distant pairs' velocities alone", () => {
    const a = body(0, 0, -5, 0);
    const b = body(20, 0, 5, 0);
    expect(collide(a, b, 12, 1)).toBe(true);
    expect([a.vx, b.vx]).toEqual([-5, 5]);
    const c = body(0, 0, 5, 0);
    const d = body(30, 0, -5, 0);
    expect(collide(c, d, 12, 1)).toBe(false);
    expect([c.x, d.x, c.vx, d.vx]).toEqual([0, 30, 5, -5]);
  });

  it("separates coincident centres", () => {
    const a = body(50, 50, 0, 0);
    const b = body(50, 50, 0, 0);
    collide(a, b, 12, 1);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(24, 9);
  });

});

describe("keepInside", () => {
  it("clamps and reflects the normal velocity scaled by restitution, keeping the tangential part", () => {
    const s = body(-3, 50, -10, 4);
    keepInside(s, 12, 100, 100, 0.6);
    expect([s.x, s.y, s.vx, s.vy]).toEqual([12, 50, 6, 4]);
    const t = body(50, 95, 3, 9);
    keepInside(t, 12, 100, 100, 0.5);
    expect([t.x, t.y, t.vx, t.vy]).toEqual([50, 88, 3, -4.5]);
  });

  it("restitution 0 absorbs and a body moving away from the wall is untouched", () => {
    const s = body(5, 50, -10, 4);
    keepInside(s, 12, 100, 100, 0);
    expect(s.vx).toBeCloseTo(0, 12);
    const t = body(5, 50, 10, 4);
    keepInside(t, 12, 100, 100, 1);
    expect(t.vx).toBe(10);
  });

  it("never gains speed and stays inside, and a corner bounce is stable", () => {
    for (const e of [0, 0.6, 1]) {
      const s = body(2, 3, -7, -9);
      const before = Math.hypot(s.vx, s.vy);
      keepInside(s, 12, 100, 100, e);
      expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(before + 1e-12);
      expect([s.x, s.y]).toEqual([12, 12]);
      expect([s.vx, s.vy]).toEqual([7 * e, 9 * e]);
      keepInside(s, 12, 100, 100, e); // moving away now: unchanged
      expect([s.vx, s.vy]).toEqual([7 * e, 9 * e]);
    }
  });
});

describe("stepBody", () => {
  const config = { ...DEFAULT_CONFIG, world: { ...DEFAULT_CONFIG.world, width: 4000, height: 4000 } };
  const k = decaysFor(config);
  const state = (vx: number): CreatureState => ({ x: 2000, y: 2000, heading: 0, vx, vy: 0, turnRate: 0, energy: 50, alive: true, ticksAlive: 0 });
  const step = (s: CreatureState, thrust: number) => stepBody(s, 0, thrust, config, k, { cos: 1, sin: 0 });

  it("negative thrust brakes harder than coasting", () => {
    const coast = state(80);
    const brake = state(80);
    step(coast, 0);
    step(brake, -1);
    expect(brake.vx).toBeLessThan(coast.vx);
    expect(brake.vx).toBeGreaterThan(0);
  });

  it("braking never reverses, whatever the speed or strength", () => {
    for (const v of [0.5, 3, 20, -0.5, -20]) {
      for (const thrust of [-0.2, -1]) {
        const s = state(v);
        for (let i = 0; i < 60; i++) {
          step(s, thrust);
          expect(Math.sign(s.vx) * Math.sign(v)).toBeGreaterThanOrEqual(0);
        }
        expect(s.vx).toBe(0);
      }
    }
  });

  it("braking costs no energy beyond living, thrust still does", () => {
    const brake = state(80);
    const idle = state(80);
    const push = state(80);
    step(brake, -1);
    step(idle, 0);
    step(push, 1);
    expect(brake.energy).toBe(idle.energy);
    expect(push.energy).toBeLessThan(idle.energy);
  });
});
