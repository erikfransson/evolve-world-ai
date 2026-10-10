import { DEFAULT_CONFIG, itemCounts } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { World } from "../../src/typescript/src/sim/world.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import type { RayHit } from "../../src/typescript/src/sim/types.ts";
import { testRng } from "./helpers.ts";

const cfg = (): SimConfig => structuredClone(DEFAULT_CONFIG);

// Empty world with all items parked far in a corner, then hand-placed.
function emptyWorld(config: SimConfig): World {
  const w = new World(config, testRng(1), testRng(2));
  for (let i = 0; i < w.count; i++) w.setItem(i, 900, 900, w.kinds[i] as 1 | 2);
  return w;
}

function brute(w: World, config: SimConfig, x: number, y: number, a: number): RayHit {
  const L = config.creature.rayLength;
  const r = config.world.itemRadius;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let best = Infinity;
  let kind = HIT_NONE as number;
  const walls: number[] = [];
  if (dx > 0) walls.push((config.world.width - x) / dx);
  if (dx < 0) walls.push(-x / dx);
  if (dy > 0) walls.push((config.world.height - y) / dy);
  if (dy < 0) walls.push(-y / dy);
  const tw = Math.min(...walls);
  if (tw <= L) {
    best = tw;
    kind = HIT_WALL;
  }
  for (let i = 0; i < w.count; i++) {
    if (w.kinds[i] === HIT_NONE) continue;
    const fx = w.xs[i] - x;
    const fy = w.ys[i] - y;
    const b = fx * dx + fy * dy;
    const c = fx * fx + fy * fy - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = c < 0 ? 0 : b - Math.sqrt(disc);
    if (t < 0 || t > L) continue;
    if (t < best) {
      best = t;
      kind = w.kinds[i];
    }
  }
  return { closeness: kind === HIT_NONE ? 0 : 1 - best / L, kind: kind as RayHit["kind"] };
}

describe("World", () => {
  it("equal layout rngs give identical layouts", () => {
    const a = new World(cfg(), testRng(5), testRng(1));
    const b = new World(cfg(), testRng(5), testRng(99));
    const n = itemCounts(DEFAULT_CONFIG);
    expect(a.count).toBe(n.food + n.poison);
    expect(Array.from(a.xs)).toEqual(Array.from(b.xs));
    expect(Array.from(a.ys)).toEqual(Array.from(b.ys));
    expect(Array.from(a.kinds)).toEqual(Array.from(b.kinds));
  });

  it("has no poison when disabled", () => {
    const c = cfg();
    c.world.poisonDensity = 0;
    const w = new World(c, testRng(5), testRng(1));
    expect(w.count).toBe(itemCounts(c).food);
    expect(w.kinds.every((k) => k === HIT_FOOD)).toBe(true);
  });

  it("items lie inside the allowed box", () => {
    const c = cfg();
    const w = new World(c, testRng(3), testRng(1));
    const r = c.world.itemRadius;
    for (let i = 0; i < w.count; i++) {
      expect(w.xs[i]).toBeGreaterThanOrEqual(r);
      expect(w.xs[i]).toBeLessThanOrEqual(c.world.width - r);
      expect(w.ys[i]).toBeGreaterThanOrEqual(r);
      expect(w.ys[i]).toBeLessThanOrEqual(c.world.height - r);
    }
  });

  it("ray hits a placed item at the expected closeness", () => {
    const c = cfg();
    const w = emptyWorld(c);
    w.setItem(0, 150, 500, HIT_FOOD);
    w.setItem(itemCounts(c).food, 500, 150, HIT_POISON);
    const out: RayHit = { closeness: 0, kind: HIT_NONE };
    w.castRayDir(100, 500, Math.cos(0), Math.sin(0), out);
    expect(out.kind).toBe(HIT_FOOD);
    expect(out.closeness).toBeCloseTo(1 - (50 - c.world.itemRadius) / c.creature.rayLength, 5);
    w.castRayDir(500, 100, Math.cos(Math.PI / 2), Math.sin(Math.PI / 2), out);
    expect(out.kind).toBe(HIT_POISON);
  });

  it("ray towards a nearby wall reports HIT_WALL", () => {
    const w = emptyWorld(cfg());
    const out: RayHit = { closeness: 0, kind: HIT_NONE };
    w.castRayDir(DEFAULT_CONFIG.world.width - 20, 500, Math.cos(0), Math.sin(0), out);
    expect(out.kind).toBe(HIT_WALL);
    expect(out.closeness).toBeCloseTo(1 - 20 / 100, 5);
  });

  it("ray into empty space reports nothing", () => {
    const w = emptyWorld(cfg());
    const out: RayHit = { closeness: 1, kind: HIT_WALL };
    w.castRayDir(500, 500, Math.cos(1), Math.sin(1), out);
    expect(out.closeness).toBe(0);
    expect(out.kind).toBe(HIT_NONE);
  });

  it("eatAt with respawn returns the kind and moves the item", () => {
    const c = cfg();
    c.world.respawn = true;
    const w = emptyWorld(c);
    w.setItem(3, 300, 300, HIT_FOOD);
    w.setItem(itemCounts(c).food, 600, 600, HIT_POISON);
    expect(w.eatAt(300 + c.creature.radius + c.world.itemRadius + 0.5, 300, c.creature.radius)).toBe(HIT_NONE);
    expect(w.eatAt(305, 300, c.creature.radius)).toBe(HIT_FOOD);
    expect(w.kinds[3]).toBe(HIT_FOOD);
    expect(w.xs[3] === 300 && w.ys[3] === 300).toBe(false);
    expect(w.eatAt(300, 300, c.creature.radius)).toBe(HIT_NONE);
    expect(w.eatAt(600, 600, c.creature.radius)).toBe(HIT_POISON);
  });

  it("eatAt without respawn removes the item for good", () => {
    const c = cfg();
    c.world.respawn = false;
    const w = emptyWorld(c);
    w.setItem(3, 300, 300, HIT_FOOD);
    expect(w.eatAt(305, 300, c.creature.radius)).toBe(HIT_FOOD);
    expect(w.kinds[3]).toBe(HIT_NONE);
    expect(w.eatAt(305, 300, c.creature.radius)).toBe(HIT_NONE);
    const out: RayHit = { closeness: 0, kind: HIT_NONE };
    w.castRayDir(250, 300, Math.cos(0), Math.sin(0), out);
    expect(out.kind).toBe(HIT_NONE);
  });

  it.each([true, false])("grid results match brute force over random rays and after eating (respawn %s)", (respawn) => {
    const c = cfg();
    c.world.respawn = respawn;
    const w = new World(c, testRng(7), testRng(8));
    const rng = testRng(11);
    const out: RayHit = { closeness: 0, kind: HIT_NONE };
    for (let n = 0; n < 5000; n++) {
      if (n % 10 === 0) w.eatAt(rng.range(0, 1000), rng.range(0, 1000), 40);
      const x = rng.range(0, 1000);
      const y = rng.range(0, 1000);
      const a = rng.range(-Math.PI, Math.PI);
      w.castRayDir(x, y, Math.cos(a), Math.sin(a), out);
      const ref = brute(w, c, x, y, a);
      expect(out.kind).toBe(ref.kind);
      expect(out.closeness).toBeCloseTo(ref.closeness, 9);
    }
  });
});
