import { layoutConfig } from "../../src/typescript/src/sim/rl/env.ts";
import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_FOOD, HIT_NONE } from "../../src/typescript/src/sim/types.ts";
import { PERIOD, PreviewScene, ROOM_H, ROOM_W, pathAt } from "../../src/typescript/src/ui/previewScene.ts";

const config = layoutConfig("ecosystem");
const plan = (over: Partial<BodyPlan> = {}): BodyPlan => ({ rayCount: 7, raySpread: (140 * Math.PI) / 180, rayLength: 150, hiddenLayers: [10], memoryShort: 2, memoryLong: 2, ...over });
const make = (p = plan()) => new PreviewScene(config, p, randomGenome(layerSizes(config, p), createRng(3)));

describe("pathAt", () => {
  it("stays inside the room, clear of the walls, and repeats each lap", () => {
    for (let t = 0; t < 60; t += 0.05) {
      const p = pathAt(t);
      expect(p.x).toBeGreaterThan(20);
      expect(p.x).toBeLessThan(ROOM_W - 20);
      expect(p.y).toBeGreaterThan(20);
      expect(p.y).toBeLessThan(ROOM_H - 20);
    }
    expect(pathAt(5.5).x).toBeCloseTo(pathAt(5.5 + PERIOD).x, 6);
  });

  it("is smooth: small steps move the position and heading only a little", () => {
    let prev = pathAt(0);
    for (let t = 0.05; t < 40; t += 0.05) {
      const p = pathAt(t);
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThan(6);
      expect(Math.abs(Math.atan2(Math.sin(p.heading - prev.heading), Math.cos(p.heading - prev.heading)))).toBeLessThan(0.25);
      prev = p;
    }
  });
});

describe("PreviewScene", () => {
  it("senses finite rays and a finite brain input as it moves", () => {
    const scene = make();
    for (let k = 0; k < 400; k++) {
      scene.step(1 / 30);
      for (const ray of scene.creature.rays) {
        expect(Number.isFinite(ray.closeness)).toBe(true);
        expect(ray.closeness).toBeGreaterThanOrEqual(0);
      }
      for (const v of scene.creature.brain.layerActivations()[0]!) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("follows the path with its heading and sees an item placed ahead", () => {
    const scene = make(plan({ rayCount: 1, raySpread: 0 }));
    scene.step(0);
    const { x, y, heading } = scene.creature.state;
    expect(heading).toBeCloseTo(pathAt(0).heading, 9);
    scene.world.setItem(0, x + Math.cos(heading) * 60, y + Math.sin(heading) * 60, HIT_FOOD);
    scene.creature.sense(scene.world);
    const ray = scene.creature.rays[0]!;
    expect(ray.kind).toBe(HIT_FOOD);
    expect(ray.closeness).toBeCloseTo(1 - 54 / 150, 1); // the item's near edge, radius 4... within a few units of 60
  });

  it("moves an item the creature touches somewhere else and keeps the item count", () => {
    const scene = make();
    scene.step(0);
    const { x, y } = scene.creature.state;
    const before = scene.world.used;
    scene.world.setItem(0, x, y, HIT_FOOD);
    scene.step(0);
    expect(Math.hypot(scene.world.xs[0]! - x, scene.world.ys[0]! - y)).toBeGreaterThan(20);
    expect(scene.world.used).toBe(before);
    expect(scene.world.kinds[0]).not.toBe(HIT_NONE);
  });

  it("keeps the room and place on its path when the creature changes", () => {
    const scene = make();
    scene.step(4);
    const items = Array.from(scene.world.xs);
    const p = plan({ rayCount: 3 });
    scene.setCreature(p, randomGenome(layerSizes(config, p), createRng(9)));
    expect(scene.creature.rays).toHaveLength(3);
    expect(scene.t).toBe(4);
    expect(Array.from(scene.world.xs)).toEqual(items);
    expect(scene.creature.state.x).toBeCloseTo(pathAt(4).x, 9);
  });
});
