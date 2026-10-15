import { DEFAULT_CONFIG, itemCounts } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { RayCache, World } from "../../src/typescript/src/sim/world.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import type { HitKind, RayHit, Rng } from "../../src/typescript/src/sim/types.ts";
import { testRng } from "./helpers.ts";

const cfg = (): SimConfig => structuredClone(DEFAULT_CONFIG);

// One ray at angle a through the batch API.
function castRay(w: World, x: number, y: number, a: number, out: RayHit, cache = new RayCache()): void {
  w.castRays(x, y, Float64Array.of(Math.cos(a)), Float64Array.of(Math.sin(a)), [out], cache, DEFAULT_CONFIG.creature.rayLength);
}

// Empty world with room for the config's items, to place them by hand.
function emptyWorld(config: SimConfig): World {
  const n = itemCounts(config);
  return new World(config, n.food + n.poison);
}

// The config's items scattered as Trials does.
function scattered(config: SimConfig, rng: Rng): World {
  const n = itemCounts(config);
  const w = new World(config, n.food + n.poison);
  w.scatter(n.food, n.poison, rng);
  return w;
}

// Applies Trials' rule to an eaten item: respawn elsewhere, else remove.
function eat(w: World, x: number, y: number, radius: number, cache: RayCache, respawn: boolean, rng: Rng): void {
  const i = w.eatAt(x, y, radius, cache);
  if (i < 0) return;
  if (respawn) w.placeRandomly(i, w.kinds[i] as HitKind, rng);
  else w.removeItem(i);
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
  return { closeness: kind === HIT_NONE ? 0 : 1 - best / L, kind: kind as RayHit["kind"], energy: 0, species: 0 };
}

describe("World", () => {
  it("drops the dirty-cell list for a full rebuild once it outgrows the grid", () => {
    const w = new World(cfg(), 4);
    w.dirtyCells = [];
    for (let n = 0; n < w.cellHead.length; n++) w.removeItem(w.addItem(10, 10, HIT_FOOD));
    expect(w.dirtyCells).toBeNull();
  });

  it("equal layout rngs give identical layouts", () => {
    const a = scattered(cfg(), testRng(5));
    const b = scattered(cfg(), testRng(5));
    const n = itemCounts(DEFAULT_CONFIG);
    expect(a.count).toBe(n.food + n.poison);
    expect(Array.from(a.xs)).toEqual(Array.from(b.xs));
    expect(Array.from(a.ys)).toEqual(Array.from(b.ys));
    expect(Array.from(a.kinds)).toEqual(Array.from(b.kinds));
  });

  it("scatter keeps poison out of the clear disc and stays deterministic", () => {
    const c = cfg();
    c.world.poisonDensity = 3;
    const n = itemCounts(c);
    const clear = { x: c.world.width / 2, y: c.world.height / 2, radius: 200 };
    const make = () => {
      const w = new World(c, n.food + n.poison);
      w.scatter(n.food, n.poison, testRng(8), clear);
      return w;
    };
    const w = make();
    for (let i = 0; i < w.count; i++) {
      if (w.kinds[i] === HIT_POISON) expect(Math.hypot(w.xs[i] - clear.x, w.ys[i] - clear.y)).toBeGreaterThanOrEqual(200 - 1e-3);
    }
    expect(Array.from(make().xs)).toEqual(Array.from(w.xs));
  });

  it("scatter throws when the clear disc covers the whole box", () => {
    const c = cfg();
    const w = emptyWorld(c);
    const huge = { x: c.world.width / 2, y: c.world.height / 2, radius: 5000 };
    expect(() => w.scatter(1, 1, testRng(1), huge)).toThrow(/clear disc/);
  });

  it("clearPoison moves only poison touching the body and keeps the item count", () => {
    const c = cfg();
    const w = emptyWorld(c);
    w.setItem(0, 500, 500, HIT_POISON);
    w.setItem(1, 505, 500, HIT_FOOD);
    w.setItem(2, 508, 502, HIT_POISON);
    w.setItem(3, 900, 500, HIT_POISON);
    w.clearPoison(500, 500, 12, testRng(2));
    expect(w.kinds[0]).toBe(HIT_POISON);
    expect(w.kinds[2]).toBe(HIT_POISON);
    for (const i of [0, 2]) expect(Math.hypot(w.xs[i] - 500, w.ys[i] - 500)).toBeGreaterThanOrEqual(12 + c.world.itemRadius);
    expect([w.xs[1], w.xs[3]]).toEqual([505, 900]);
    expect(w.used).toBe(4);
  });

  it("has no poison when disabled", () => {
    const c = cfg();
    c.world.poisonDensity = 0;
    const w = scattered(c, testRng(5));
    expect(w.count).toBe(itemCounts(c).food);
    expect(w.kinds.every((k) => k === HIT_FOOD)).toBe(true);
  });

  it("items lie inside the allowed box", () => {
    const c = cfg();
    const w = scattered(c, testRng(3));
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
    w.setItem(1, 500, 150, HIT_POISON);
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    castRay(w, 100, 500, 0, out);
    expect(out.kind).toBe(HIT_FOOD);
    expect(out.closeness).toBeCloseTo(1 - (50 - c.world.itemRadius) / c.creature.rayLength, 5);
    castRay(w, 500, 100, Math.PI / 2, out);
    expect(out.kind).toBe(HIT_POISON);
  });

  it("ray towards a nearby wall reports HIT_WALL", () => {
    const w = emptyWorld(cfg());
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    castRay(w, DEFAULT_CONFIG.world.width - 20, 500, 0, out);
    expect(out.kind).toBe(HIT_WALL);
    expect(out.closeness).toBeCloseTo(1 - 20 / DEFAULT_CONFIG.creature.rayLength, 5);
  });

  it("ray into empty space reports nothing", () => {
    const w = emptyWorld(cfg());
    const out: RayHit = { closeness: 1, kind: HIT_WALL, energy: 0, species: 0 };
    castRay(w, 500, 500, 1, out);
    expect(out.closeness).toBe(0);
    expect(out.kind).toBe(HIT_NONE);
  });

  it("eatAt returns the touched item's index and leaves the item in place", () => {
    const c = cfg();
    const w = emptyWorld(c);
    const cache = new RayCache();
    w.setItem(3, 300, 300, HIT_FOOD);
    w.setItem(7, 600, 600, HIT_POISON);
    expect(w.eatAt(300 + c.creature.radius + c.world.itemRadius + 0.5, 300, c.creature.radius, cache)).toBe(-1);
    expect(w.eatAt(305, 300, c.creature.radius, cache)).toBe(3);
    expect(w.kinds[3]).toBe(HIT_FOOD);
    expect(w.eatAt(600, 600, c.creature.radius, cache)).toBe(7);
    // Through the anchored list too.
    castRay(w, 300, 300, 0, { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 }, cache);
    expect(w.eatAt(302, 300, c.creature.radius, cache)).toBe(3);
  });

  it("touchedBatch stores what eatAt finds, by owner", () => {
    const c = cfg();
    const w = scattered(c, testRng(5));
    const r = c.creature.radius;
    const px = Float64Array.from({ length: 60 }, (_, i) => (i * 97) % c.world.width);
    const py = Float64Array.from({ length: 60 }, (_, i) => (i * 61) % c.world.height);
    const owners = Int32Array.from({ length: 60 }, (_, i) => 59 - i);
    const out = new Int32Array(60);
    w.touchedBatch(px, py, owners, 60, r, out);
    for (let k = 0; k < 60; k++) expect(out[owners[k]!]).toBe(w.eatAt(px[k]!, py[k]!, r, new RayCache()));
  });

  it("addItem reuses the most recently freed slot and skips slots taken by setItem", () => {
    const w = new World(cfg(), 4);
    w.scatter(2, 0, testRng(1));
    expect(w.used).toBe(2);
    w.setItem(3, 100, 100, HIT_FOOD);
    expect(w.addItem(200, 200, HIT_FOOD)).toBe(2);
    expect(w.addItem(300, 300, HIT_FOOD)).toBe(-1);
    w.removeItem(0);
    w.removeItem(0); // freeing twice keeps one free slot
    expect(w.used).toBe(3);
    expect(w.addItem(400, 400, HIT_POISON)).toBe(0);
    expect(w.addItem(500, 500, HIT_POISON)).toBe(-1);
  });

  it("removeItem frees the slot, out of eating and ray reach, and addItem refills free slots", () => {
    const c = cfg();
    const w = new World(c, 2);
    const cache = new RayCache();
    expect(w.addItem(300, 300, HIT_FOOD)).toBe(0);
    expect(w.addItem(700, 700, HIT_POISON)).toBe(1);
    expect(w.addItem(500, 500, HIT_FOOD)).toBe(-1);
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    castRay(w, 250, 300, 0, out, cache);
    expect(out.kind).toBe(HIT_FOOD);
    w.removeItem(0);
    expect(w.kinds[0]).toBe(HIT_NONE);
    expect(w.eatAt(305, 300, c.creature.radius, cache)).toBe(-1);
    castRay(w, 250, 300, 0, out, cache);
    expect(out.kind).toBe(HIT_NONE);
    expect(w.addItem(310, 300, HIT_POISON)).toBe(0);
    castRay(w, 250, 300, 0, out, cache);
    expect(out.kind).toBe(HIT_POISON);
    expect(w.eatAt(305, 300, c.creature.radius, cache)).toBe(0);
  });

  it("addRandomly on a full world adds nothing and reports -1", () => {
    const w = new World(cfg(), 3);
    w.scatter(3, 0, testRng(1));
    expect(w.addRandomly(HIT_FOOD, testRng(2))).toBe(-1);
    expect(w.used).toBe(3);
  });

  it("a ray cache built before load() sees the loaded items, not the old ones", () => {
    const c = cfg();
    const a = emptyWorld(c);
    const b = emptyWorld(c);
    a.setItem(0, 150, 500, HIT_FOOD);
    b.setItem(0, 150, 500, HIT_POISON);
    const cache = new RayCache();
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    castRay(a, 100, 500, 0, out, cache);
    expect(out.kind).toBe(HIT_FOOD);
    a.load(b.snapshot());
    castRay(a, 100, 500, 0, out, cache);
    expect(out.kind).toBe(HIT_POISON);
    expect(a.eatAt(150, 500, c.creature.radius, cache)).toBe(0);
  });

  it("a ray cache reused with a different ray length still finds items in the longer reach", () => {
    const c = cfg();
    const w = emptyWorld(c);
    w.setItem(0, 400, 500, HIT_FOOD);
    const cache = new RayCache();
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    const cast = (length: number) => w.castRays(100, 500, Float64Array.of(1), Float64Array.of(0), [out], cache, length);
    cast(100);
    expect(out.kind).toBe(HIT_NONE);
    cast(400);
    expect(out.kind).toBe(HIT_FOOD);
  });

  it("eatAt from a cache anchored elsewhere still finds an item touching at the edge of the cached reach", () => {
    const c = cfg();
    const w = emptyWorld(c);
    const cache = new RayCache();
    const touch = c.creature.radius + c.world.itemRadius;
    const listReach = c.creature.rayLength * 1.3 + c.world.itemRadius + 2e-9 * c.creature.rayLength; // the reach the cast below gathers
    const x = 300 + listReach - touch / 2; // inside the cached reach, but the item below lies outside it
    w.setItem(0, x + 0.9 * touch, 500, HIT_FOOD);
    castRay(w, 300, 500, 0, { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 }, cache);
    expect(cache.count).toBe(0);
    expect(w.eatAt(x, 500, c.creature.radius, cache)).toBe(0);
  });

  it.each([true, false])("grid results match brute force over random rays and after eating (respawn %s)", (respawn) => {
    const c = cfg();
    const w = scattered(c, testRng(7));
    const respawnRng = testRng(8);
    const rng = testRng(11);
    const cache = new RayCache();
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    const mismatches: string[] = []; // one expect after the loop keeps the assertion library out of the hot path
    for (let n = 0; n < 5000; n++) {
      if (n % 10 === 0) eat(w, rng.range(0, 1000), rng.range(0, 1000), 40, cache, respawn, respawnRng);
      const x = rng.range(0, 1000);
      const y = rng.range(0, 1000);
      const a = rng.range(-Math.PI, Math.PI);
      castRay(w, x, y, a, out, cache);
      const ref = brute(w, c, x, y, a);
      if (out.kind !== ref.kind || Math.abs(out.closeness - ref.closeness) > 1e-9) mismatches.push(`ray ${n}: ${out.kind}/${out.closeness} vs ${ref.kind}/${ref.closeness}`);
    }
    expect(mismatches).toEqual([]);
  });

  it.each([true, false])("fans cast by creatures walking and eating in one world match brute force (respawn %s)", (respawn) => {
    const c = cfg();
    c.world.foodDensity = 4;
    const w = scattered(c, testRng(21));
    const respawnRng = testRng(22);
    const rng = testRng(23);
    const n = c.creature.rayCount;
    const offsets = Array.from({ length: n }, (_, i) => -c.creature.raySpread / 2 + (c.creature.raySpread * i) / (n - 1));
    // Each walker keeps its own anchored list, so one's eating must invalidate the other's when nearby.
    const walkers = [
      { x: 500, y: 400, heading: 0, cache: new RayCache() },
      { x: 560, y: 420, heading: 2, cache: new RayCache() },
      { x: 100, y: 900, heading: 4, cache: new RayCache() },
    ];
    const rays: RayHit[] = offsets.map(() => ({ closeness: 0, kind: HIT_NONE, energy: 0, species: 0 }));
    const mismatches: string[] = [];
    for (let tick = 0; tick < 1000; tick++) {
      for (const k of walkers) {
        k.heading += rng.range(-0.3, 0.3);
        k.x = Math.min(c.world.width, Math.max(0, k.x + 2.5 * Math.cos(k.heading)));
        k.y = Math.min(c.world.height, Math.max(0, k.y + 2.5 * Math.sin(k.heading)));
        const angles = offsets.map((o) => k.heading + o);
        w.castRays(k.x, k.y, Float64Array.from(angles, Math.cos), Float64Array.from(angles, Math.sin), rays, k.cache, c.creature.rayLength);
        angles.forEach((a, i) => {
          const ref = brute(w, c, k.x, k.y, a);
          if (rays[i].kind !== ref.kind || Math.abs(rays[i].closeness - ref.closeness) > 1e-9) mismatches.push(`tick ${tick} ray ${i}: ${rays[i].kind} vs ${ref.kind}`);
        });
        if (w.eatAt(k.x, k.y, c.creature.radius, k.cache) !== w.eatAt(k.x, k.y, c.creature.radius, new RayCache())) mismatches.push(`tick ${tick}: eatAt`);
        eat(w, k.x, k.y, c.creature.radius, k.cache, respawn, respawnRng);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("item spacing", () => {
  it("keeps food and poison apart by 3 item radii plus a creature radius, while food may cluster", () => {
    const c = cfg();
    c.world.width = c.world.height = 800;
    const w = new World(c, 120);
    w.scatter(60, 60, testRng(9));
    for (let k = 0; k < 20; k++) w.addRandomly(k % 2 ? HIT_FOOD : HIT_POISON, testRng(100 + k));
    const d = 3 * c.world.itemRadius + c.creature.radius;
    const items = Array.from({ length: w.count }, (_, i) => i).filter((i) => w.kinds[i] !== HIT_NONE);
    let foodPairs = 0;
    for (const i of items) {
      for (const j of items) {
        if (j <= i) continue;
        const close = Math.hypot(w.xs[i]! - w.xs[j]!, w.ys[i]! - w.ys[j]!) < d;
        if (w.kinds[i] === HIT_FOOD && w.kinds[j] === HIT_FOOD) foodPairs += close ? 1 : 0;
        else expect(close).toBe(false);
      }
    }
    expect(foodPairs).toBeGreaterThan(0); // food is not spaced from food, so not a clean zone
  });
});

describe("hidden food", () => {
  it("lets rays pass through food while it stays edible, and shows poison as before", () => {
    const w = emptyWorld(cfg());
    w.setItem(0, 300, 200, HIT_FOOD);
    w.setItem(1, 200, 300, HIT_POISON);
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    castRay(w, 200, 200, 0, out);
    expect(out.kind).toBe(HIT_FOOD);
    w.foodHidden = true;
    castRay(w, 200, 200, 0, out, new RayCache());
    expect(out.kind).not.toBe(HIT_FOOD);
    castRay(w, 200, 200, Math.PI / 2, out, new RayCache());
    expect(out.kind).toBe(HIT_POISON);
    expect(w.eatAt(300, 200, 12, new RayCache())).toBe(0); // still there to eat
  });
});
