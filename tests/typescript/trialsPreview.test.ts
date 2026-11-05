import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { buildPreview, turnPreview } from "../../src/typescript/src/ui/preview.ts";

const rocky = (seed: number): SimConfig => ({ ...DEFAULT_CONFIG, seed, world: { ...DEFAULT_CONFIG.world, stoneDensity: 0.2, ridgeDensity: 0.1 } });

describe("trials preview", () => {
  test("the creature sits clear of rock, with room for most of its rays", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const c = rocky(seed);
      const ep = buildPreview(c)!;
      expect(ep.world.terrain.touchesRock(ep.state.x, ep.state.y, 0.5 * c.creature.rayLength)).toBe(false);
    }
  });

  test("turning changes the heading and keeps the position", () => {
    const ep = buildPreview(rocky(3))!;
    const { x, y, heading } = ep.state;
    turnPreview(ep, 0.05);
    expect(ep.state.heading).toBeGreaterThan(heading);
    expect([ep.state.x, ep.state.y]).toEqual([x, y]);
  });
});
