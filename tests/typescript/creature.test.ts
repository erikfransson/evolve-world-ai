import { fastTanh, genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG, itemCounts } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Creature } from "../../src/typescript/src/sim/creature.ts";
import { Episode, poisonClearRadius } from "../../src/typescript/src/sim/episode.ts";
import { createRng, deriveSeed } from "../../src/typescript/src/sim/rng.ts";
import { OUTPUT_SIZE, inputLayout, planOf } from "../../src/typescript/src/sim/sensors.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_FOOD } from "../../src/typescript/src/sim/types.ts";
import type { HitKind } from "../../src/typescript/src/sim/types.ts";
import { World } from "../../src/typescript/src/sim/world.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 30 },
  world: { ...DEFAULT_CONFIG.world, width: 300, height: 300, foodDensity: 15, poisonDensity: 1 },
};

describe("Creature", () => {
  it.each([true, false])("sense and act in a hand-built world match Episode tick for tick (respawn %s)", (respawn) => {
    const config: SimConfig = { ...cfg, world: { ...cfg.world, respawn } };
    const seed = 31;
    const index = 4;
    const genome = randomGenome(layerSizes(config), createRng(3));
    const episode = new Episode(config, genome, seed, index);
    const counts = itemCounts(config);
    const world = new World(config, counts.food + counts.poison);
    const { x, y, heading } = episode.state;
    world.scatter(counts.food, counts.poison, createRng(seed), { x, y, radius: poisonClearRadius(config) });
    const respawnRng = createRng(deriveSeed(seed, index));
    const creature = new Creature(config, genome, x, y, heading);
    let eats = 0;
    while (!episode.done) {
      episode.step();
      creature.sense(world);
      const eaten = creature.act(world);
      if (eaten >= 0) {
        eats++;
        if (respawn) world.placeRandomly(eaten, world.kinds[eaten] as HitKind, respawnRng);
        else world.removeItem(eaten);
      }
      expect(creature.state).toEqual(episode.state);
      expect(creature.rays).toEqual(episode.rays);
    }
    expect(eats).toBeGreaterThan(0);
    expect(Array.from(world.xs)).toEqual(Array.from(episode.world.xs));
    expect(Array.from(world.kinds)).toEqual(Array.from(episode.world.kinds));
  });

  it("memory units relax toward their targets at the short and long rates, feed the next tick and reset at spawn", () => {
    const config: SimConfig = { ...cfg, brain: { ...cfg.brain, hiddenLayers: [4], memory: 0.125 } }; // 1 short + 1 long unit
    const sizes = layerSizes(config);
    const genome = new Float32Array(genomeLength(sizes));
    const outBias = genome.length - sizes[2]!; // zero weights, so the outputs are tanh of their biases
    genome[outBias + OUTPUT_SIZE] = 0.5;
    genome[outBias + OUTPUT_SIZE + 1] = 1;
    const creature = new Creature(config, genome, 100, 100, 0);
    const memoryAt = inputLayout(config).memoryAt;
    const { shortRate, longRate } = config.brain;
    const ticks = 10;
    for (let t = 0; t < ticks; t++) {
      const fed = Array.from(creature.memory);
      creature.think();
      expect(Array.from(creature.brain.layerActivations()[0]!.subarray(memoryAt))).toEqual(fed.map(Math.fround));
    }
    expect(creature.memory[0]).toBeCloseTo(fastTanh(0.5) * (1 - (1 - shortRate) ** ticks), 6);
    expect(creature.memory[1]).toBeCloseTo(fastTanh(1) * (1 - (1 - longRate) ** ticks), 6);
    creature.reset(genome, 50, 50, 0, 10);
    expect(Array.from(creature.memory)).toEqual([0, 0]);
  });

  it("a recycled creature takes over a new plan and then matches a fresh creature of that plan", () => {
    const plans: BodyPlan[] = [
      { ...planOf(cfg), rayCount: 12, raySpread: 2, rayLength: 160, hiddenLayers: [20, 6], memoryShort: 3, memoryLong: 1 },
      { ...planOf(cfg), rayCount: 3, rayLength: 70, hiddenLayers: [5], memoryShort: 0, memoryLong: 2 },
      planOf(cfg),
    ];
    const rng = createRng(9);
    const recycled = new Creature(cfg, randomGenome(layerSizes(cfg), rng), 150, 150, 0);
    const counts = itemCounts(cfg);
    const worldFor = () => {
      const w = new World(cfg, counts.food + counts.poison);
      w.scatter(counts.food, counts.poison, createRng(4));
      return w;
    };
    for (const plan of plans) {
      const a = worldFor();
      for (let t = 0; t < 20; t++) recycled.sense(a), recycled.act(a); // leaves state, rays and memory dirty
      const genome = randomGenome(layerSizes(cfg, plan), rng);
      recycled.reset(genome, 150, 150, 0.3, 40, plan);
      const fresh = new Creature(cfg, genome.slice(), 150, 150, 0.3, plan);
      fresh.state.energy = 40;
      const b = worldFor();
      const c = worldFor();
      for (let t = 0; t < 60; t++) {
        recycled.sense(b);
        fresh.sense(c);
        recycled.act(b);
        fresh.act(c);
        expect(recycled.state).toEqual(fresh.state);
        expect(recycled.rays).toEqual(fresh.rays);
        expect(Array.from(recycled.memory)).toEqual(Array.from(fresh.memory));
      }
      expect(recycled.brain.sizes).toEqual(layerSizes(cfg, plan));
      expect(recycled.upkeep).toBe(fresh.upkeep);
    }
  });

  it("move returns the eaten item, still in the world, and adds its energy", () => {
    const world = new World(cfg, 1);
    world.setItem(0, 103, 100, HIT_FOOD);
    const creature = new Creature(cfg, randomGenome(layerSizes(cfg), createRng(1)), 100, 100, 0);
    const before = creature.state.energy;
    expect(creature.move(world, 0, 0)).toBe(0);
    expect(world.kinds[0]).toBe(HIT_FOOD);
    expect(creature.state.energy).toBeGreaterThan(before + cfg.world.foodEnergy - 1);
    expect(creature.state.ticksAlive).toBe(1);
  });
});
