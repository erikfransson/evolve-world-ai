import { collide, keepInside } from "../../src/typescript/src/sim/physics.ts";

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

  it("keepInside clamps and absorbs the velocity into the wall", () => {
    const s = body(-3, 50, -10, 4);
    keepInside(s, 12, 100, 100);
    expect([s.x, s.y, s.vx, s.vy]).toEqual([12, 50, 0, 4]);
  });
});
