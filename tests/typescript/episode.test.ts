import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Episode, runEpisode } from "../../src/typescript/src/sim/episode.ts";
import { HIT_POISON } from "../../src/typescript/src/sim/types.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 20 },
  population: { size: 8 },
};
const sizes = layerSizes(cfg);
const rand = (seed: number) => randomGenome(sizes, createRng(seed));

describe("Episode", () => {
  it("all-zero genome never moves and starves at startEnergy / livingCost", () => {
    const long: SimConfig = { ...cfg, creature: { ...cfg.creature, maxLifeSeconds: 80 }, world: { ...cfg.world, foodDensity: 0, poisonDensity: 0 } };
    const e = new Episode(long, new Float32Array(genomeLength(sizes)), 5, 0);
    while (!e.done) {
      e.step();
      expect(Math.hypot(e.state.vx, e.state.vy)).toBe(0);
    }
    expect(e.state.alive).toBe(false);
    const expected = cfg.creature.startEnergy / cfg.creature.livingCost;
    expect(Math.abs(e.state.ticksAlive * cfg.dt - expected)).toBeLessThan(2 * cfg.dt);
  });

  it("adds a tiny distance term to fitness so movers outrank stand-stills", () => {
    const empty: SimConfig = { ...cfg, world: { ...cfg.world, foodDensity: 0, poisonDensity: 0 } };
    const base = (e: Episode) => e.state.ticksAlive * empty.dt + (1 - Math.exp(-e.state.energy / empty.creature.startEnergy)) * empty.dt;
    const still = new Episode(empty, new Float32Array(genomeLength(sizes)), 5, 0);
    while (!still.done) still.step();
    expect(still.fitness()).toBe(base(still));
    const mover = new Episode(empty, rand(3), 5, 0);
    let path = 0;
    while (!mover.done) {
      const { x, y } = mover.state;
      mover.step();
      path += Math.hypot(mover.state.x - x, mover.state.y - y);
    }
    expect(path).toBeGreaterThan(0);
    expect(mover.fitness() - base(mover)).toBeCloseTo(path * 1e-6, 9);
    expect(mover.fitness() - base(mover)).toBeLessThan(empty.dt);
  });

  it("keeps poison off the start position", () => {
    const dense: SimConfig = { ...cfg, world: { ...cfg.world, width: 400, height: 400, foodDensity: 20, poisonDensity: 20 } };
    const c = dense.creature;
    for (let layout = 0; layout < 5; layout++) {
      const e = new Episode(dense, rand(1), layout, 0);
      for (let i = 0; i < e.world.count; i++) {
        if (e.world.kinds[i] === HIT_POISON) expect(Math.hypot(e.world.xs[i] - e.state.x, e.world.ys[i] - e.state.y)).toBeGreaterThan(c.radius + dense.world.itemRadius);
      }
      e.step();
      expect(e.state.alive).toBe(true); // no poison eaten on tick one
    }
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

  it("keeps energy non-negative and the creature inside the walls", () => {
    const small: SimConfig = { ...cfg, world: { ...cfg.world, width: 200, height: 200, foodDensity: 15 } };
    const r = small.creature.radius;
    for (let seed = 1; seed <= 5; seed++) {
      const e = new Episode(small, randomGenome(layerSizes(small), createRng(seed)), seed, 0);
      while (!e.done) {
        e.step();
        const s = e.state;
        expect(s.energy).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeGreaterThanOrEqual(r);
        expect(s.x).toBeLessThanOrEqual(small.world.width - r);
        expect(s.y).toBeGreaterThanOrEqual(r);
        expect(s.y).toBeLessThanOrEqual(small.world.height - r);
      }
    }
  });
});

describe("Episode.sense", () => {
  it("fills the rays the first step then senses, without moving the creature", () => {
    const dense: SimConfig = { ...cfg, world: { ...cfg.world, foodDensity: 15, poisonDensity: 15 } };
    const e = new Episode(dense, rand(6), 21, 0);
    const before = { ...e.state };
    e.sense();
    expect(e.state).toEqual(before);
    expect(e.rays.some((r) => r.kind !== 0)).toBe(true);
    const sensed = e.rays.map((r) => ({ ...r }));
    e.step();
    expect(e.rays).toEqual(sensed);
  });
});
