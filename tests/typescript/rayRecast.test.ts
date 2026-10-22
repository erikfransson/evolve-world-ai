import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG, itemCounts } from "../../src/typescript/src/sim/config.ts";
import { Creature } from "../../src/typescript/src/sim/creature.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { Terrain } from "../../src/typescript/src/sim/terrain.ts";
import { HIT_CREATURE, HIT_FOOD, HIT_NONE, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import { World } from "../../src/typescript/src/sim/world.ts";
import { recastRays } from "../../src/typescript/src/live/rayRecast.ts";
import type { RayWorld } from "../../src/typescript/src/live/rayRecast.ts";

const cfg = DEFAULT_CONFIG;
const none = { x: new Float32Array(0), y: new Float32Array(0), kind: new Uint8Array(0), count: 0 };
const world = (over: Partial<RayWorld> = {}): RayWorld => ({ width: 1000, height: 1000, itemRadius: 4, radius: 10, terrain: null, items: none, creatures: { x: new Float32Array(0), y: new Float32Array(0), count: 0 }, self: -1, ...over });
const cast = (w: RayWorld, x: number, y: number, heading: number, offsets: number[], length = 100) => {
  const kinds = new Uint8Array(offsets.length);
  const closeness = new Float32Array(offsets.length);
  recastRays(w, x, y, heading, Float32Array.from(offsets), length, kinds, closeness);
  return { kinds: Array.from(kinds), closeness: Array.from(closeness) };
};

describe("recastRays", () => {
  it("turns with the heading: the ray that meets an item follows it", () => {
    const items = { x: Float32Array.of(500, 500), y: Float32Array.of(540, 460), kind: Uint8Array.of(HIT_FOOD, HIT_FOOD), count: 2 };
    const w = world({ items });
    expect(cast(w, 500, 500, Math.PI / 2, [0]).kinds).toEqual([HIT_FOOD]); // facing +y
    expect(cast(w, 500, 500, 0, [0]).kinds).toEqual([HIT_NONE]); // turned away: nothing there any more
    const hit = cast(w, 500, 500, -Math.PI / 2, [0]);
    expect(hit.kinds).toEqual([HIT_FOOD]);
    expect(hit.closeness[0]).toBeCloseTo(1 - 36 / 100, 6);
  });

  it("ends at rock, at the world edge and at other creatures, but not at itself", () => {
    const terrain = new Terrain([{ x: 560, y: 500, r: 20 }], null, 1000, 1000);
    const creatures = { x: Float32Array.of(500, 500), y: Float32Array.of(500, 440), count: 2 };
    const w = world({ terrain, creatures, self: 0 });
    const r = cast(w, 500, 500, 0, [0, -Math.PI / 2]);
    expect(r.kinds).toEqual([HIT_WALL, HIT_CREATURE]);
    expect(r.closeness[0]).toBeCloseTo(1 - 40 / 100, 6);
    expect(r.closeness[1]).toBeCloseTo(1 - 50 / 100, 6);
    expect(cast(world(), 30, 500, Math.PI, [0]).kinds).toEqual([HIT_WALL]);
  });

  // Red with items collected first: past the candidate cap the rock was dropped and the ray went through it.
  it("still ends at rock when more items lie in reach than the candidate cap takes", () => {
    const terrain = new Terrain([{ x: 560, y: 500, r: 20 }], null, 1000, 1000);
    const n = 5000;
    const items = { x: new Float32Array(n), y: new Float32Array(n), kind: new Uint8Array(n).fill(HIT_FOOD), count: n };
    for (let i = 0; i < n; i++) {
      items.x[i] = 440 + (i % 100) * 1.2; // a block within one ray length, all of it beside the ray, none on it
      items.y[i] = 420 + Math.floor(i / 100) * 1.4;
    }
    const r = cast(world({ terrain, items }), 500, 500, 0, [0]);
    expect(r.kinds).toEqual([HIT_WALL]);
    expect(r.closeness[0]).toBeCloseTo(1 - 40 / 100, 6);
  });

  it("matches the engine's own sense on a scattered world", () => {
    const counts = itemCounts(cfg);
    const eng = new World(cfg, counts.food + counts.poison);
    eng.scatter(counts.food, counts.poison, createRng(5));
    const w = world({ width: cfg.world.width, height: cfg.world.height, itemRadius: cfg.world.itemRadius, radius: cfg.creature.radius, items: { x: eng.xs, y: eng.ys, kind: eng.kinds, count: eng.count } });
    const rng = createRng(9);
    let hits = 0;
    for (let k = 0; k < 60; k++) {
      const x = k % 3 === 0 ? rng.range(0, 60) : rng.range(0, cfg.world.width); // some near the wall
      const y = rng.range(0, cfg.world.height);
      const heading = rng.range(-20, 20);
      const c = new Creature(cfg, new Float32Array(genomeLength(layerSizes(cfg))), x, y, heading);
      c.sense(eng);
      const got = cast(w, x, y, heading, Array.from(c.rayOffsets), cfg.creature.rayLength);
      c.rays.forEach((r, i) => {
        expect(got.kinds[i]).toBe(r.kind);
        expect(got.closeness[i]).toBeCloseTo(r.closeness, 5);
        if (r.kind !== HIT_NONE) hits++;
      });
    }
    expect(hits).toBeGreaterThan(30);
  });
});
