import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Episode, runEpisode } from "../../src/typescript/src/sim/episode.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  population: { size: 8, epochSeconds: 20 },
};
const sizes = layerSizes(cfg);
const rand = (seed: number) => randomGenome(sizes, createRng(seed));

describe("Episode", () => {
  it("all-zero genome never moves and starves at startEnergy / livingCost", () => {
    const long: SimConfig = { ...cfg, population: { size: 8, epochSeconds: 80 }, world: { ...cfg.world, foodDensity: 0, poisonDensity: 0 } };
    const e = new Episode(long, new Float32Array(genomeLength(sizes)), 5, 0);
    while (!e.done) {
      e.step();
      expect(Math.hypot(e.state.vx, e.state.vy)).toBe(0);
    }
    expect(e.state.alive).toBe(false);
    const expected = cfg.creature.startEnergy / cfg.creature.livingCost;
    expect(Math.abs(e.state.ticksAlive * cfg.dt - expected)).toBeLessThan(2 * cfg.dt);
  });

  it("is deterministic", () => {
    expect(runEpisode(cfg, rand(3), 11, 2)).toBe(runEpisode(cfg, rand(3), 11, 2));
  });

  it("manual stepping matches runEpisode", () => {
    const g = rand(4);
    const e = new Episode(cfg, g, 12, 1);
    while (!e.done) e.step();
    expect(e.fitness()).toBe(runEpisode(cfg, g, 12, 1));
  });

  it("keeps energy <= maxEnergy and the creature inside the walls", () => {
    const small: SimConfig = { ...cfg, world: { ...cfg.world, width: 200, height: 200, foodDensity: 15 } };
    const r = small.creature.radius;
    for (let seed = 1; seed <= 5; seed++) {
      const e = new Episode(small, randomGenome(layerSizes(small), createRng(seed)), seed, 0);
      while (!e.done) {
        e.step();
        const s = e.state;
        expect(s.energy).toBeLessThanOrEqual(small.creature.maxEnergy);
        expect(s.x).toBeGreaterThanOrEqual(r);
        expect(s.x).toBeLessThanOrEqual(small.world.width - r);
        expect(s.y).toBeGreaterThanOrEqual(r);
        expect(s.y).toBeLessThanOrEqual(small.world.height - r);
      }
    }
  });
});
