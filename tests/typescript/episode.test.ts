import { DEFAULT_CONFIG, withOverrides } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Episode, poisonClearRadius, runEpisode } from "../../src/typescript/src/sim/episode.ts";
import { HIT_POISON } from "../../src/typescript/src/sim/types.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { planOf, planUpkeep } from "../../src/typescript/src/sim/sensors.ts";
import { setWasmDisabled } from "../../src/typescript/src/sim/wasm/loader.ts";
import { WasmBrainBank } from "../../src/typescript/src/sim/wasm/brainKernel.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 20 },
  population: { size: 8 },
};
const sizes = layerSizes(cfg);
const rand = (seed: number) => randomGenome(sizes, createRng(seed));

describe("Episode", () => {
  it("all-zero genome never moves and starves at startEnergy / upkeep", () => {
    const long: SimConfig = { ...cfg, creature: { ...cfg.creature, maxLifeSeconds: 80 }, world: { ...cfg.world, foodDensity: 0, poisonDensity: 0 } };
    const e = new Episode(long, new Float32Array(genomeLength(sizes)), 5, 0);
    while (!e.done) {
      e.step();
      expect(Math.hypot(e.state.vx, e.state.vy)).toBe(0);
    }
    expect(e.state.alive).toBe(false);
    const expected = cfg.creature.startEnergy / planUpkeep(planOf(cfg), cfg);
    expect(Math.abs(e.state.ticksAlive * cfg.dt - expected)).toBeLessThan(2 * cfg.dt);
  });

  it("adds a tiny distance term to fitness so movers outrank stand-stills", () => {
    const empty: SimConfig = { ...cfg, world: { ...cfg.world, foodDensity: 0, poisonDensity: 0 } };
    const base = (e: Episode) => e.state.ticksAlive * empty.dt + (1 - Math.exp(-e.state.energy / empty.creature.startEnergy)) * empty.dt;
    const still = new Episode(empty, new Float32Array(genomeLength(sizes)), 5, 0);
    while (!still.done) still.step();
    expect(still.fitness()).toBe(base(still));
    // The first random genome that moves at all; some brake for their whole life.
    let mover = new Episode(empty, rand(1), 5, 0);
    let path = 0;
    for (let seed = 1; seed < 40 && path === 0; seed++) {
      mover = new Episode(empty, rand(seed), 5, 0);
      path = 0;
      while (!mover.done) {
        const { x, y } = mover.state;
        mover.step();
        path += Math.hypot(mover.state.x - x, mover.state.y - y);
      }
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

describe("poison-free start", () => {
  it("keeps poison out of the clear radius around the start point", () => {
    const config = withOverrides(DEFAULT_CONFIG, { world: { poisonDensity: 1 } });
    const e = new Episode(config, new Float32Array(genomeLength(layerSizes(config))), 123, 0);
    const r = poisonClearRadius(config);
    expect(r).toBe(150);
    const { xs, ys, kinds, count } = e.world;
    let justOutside = 0; // poison is dense enough that a smaller disc would let some in
    for (let i = 0; i < count; i++) {
      if (kinds[i] !== HIT_POISON) continue;
      const d = Math.hypot(xs[i]! - e.state.x, ys[i]! - e.state.y);
      expect(d).toBeGreaterThanOrEqual(r);
      if (d < r + 30) justOutside++;
    }
    expect(justOutside).toBeGreaterThan(0);
  });

  it("caps the radius in small worlds so poison still fits", () => {
    const config = withOverrides(DEFAULT_CONFIG, { world: { width: 200, height: 200, poisonDensity: 1 } });
    expect(poisonClearRadius(config)).toBeCloseTo(70);
    expect(() => new Episode(config, new Float32Array(genomeLength(layerSizes(config))), 1, 0)).not.toThrow();
  });
});

describe("brain kernel", () => {
  const jsFitness = (c: SimConfig, genome: Float32Array, seed: number): number => {
    const e = new Episode(c, genome, seed, 0, false, null);
    while (!e.done) e.step();
    return e.fitness();
  };

  it("runs the brain on the kernel when available, close to the JS path but not bit-equal", () => {
    let differs = 0;
    for (let s = 1; s <= 6; s++) {
      const wasm = runEpisode(cfg, rand(s), 9, 0);
      const js = jsFitness(cfg, rand(s), 9);
      if (wasm !== js) differs++;
      expect(Math.abs(wasm - js)).toBeLessThan(0.5 * Math.max(1, js)); // f32 sums can tip a choice, so lifetimes may drift
    }
    expect(differs).toBeGreaterThan(0); // the kernel really ran
  });

  it("gives a viewing Episode (own bank, JS brain shown) the fitness runEpisode gave on the shared bank", () => {
    for (let s = 1; s <= 4; s++) {
      runEpisode(cfg, rand(s + 10), 3, s); // leaves the shared bank holding another brain
      const e = new Episode(cfg, rand(s), 3, 0);
      while (!e.done) e.step();
      expect(runEpisode(cfg, rand(s), 3, 0)).toBe(e.fitness());
      expect(e.brain.layerActivations()[1]!.some((v) => v !== 0)).toBe(true); // hidden layer kept current for the brain panel
    }
  });

  it("falls back to the JS brain for a layer the kernel does not take", () => {
    const wide: SimConfig = { ...cfg, creature: { ...cfg.creature, maxLifeSeconds: 2 }, brain: { ...cfg.brain, hiddenLayers: [1030] } };
    const g = randomGenome(layerSizes(wide), createRng(4));
    expect(runEpisode(wide, g, 2, 0)).toBe(jsFitness(wide, g, 2));
  });

  it("runs the JS brain when WebAssembly is disabled, also on a bank made before", () => {
    const bank = WasmBrainBank.createSync();
    runEpisode(cfg, rand(1), 9, 0); // the shared bank exists now
    setWasmDisabled(true);
    try {
      for (let s = 1; s <= 3; s++) {
        expect(runEpisode(cfg, rand(s), 9, 0)).toBe(jsFitness(cfg, rand(s), 9));
        const e = new Episode(cfg, rand(s), 9, 0, false, bank);
        while (!e.done) e.step();
        expect(e.fitness()).toBe(jsFitness(cfg, rand(s), 9));
      }
    } finally {
      setWasmDisabled(false);
    }
  });
});
