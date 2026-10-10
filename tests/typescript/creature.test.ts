import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG, itemCounts } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Creature } from "../../src/typescript/src/sim/creature.ts";
import { Episode } from "../../src/typescript/src/sim/episode.ts";
import { createRng, deriveSeed } from "../../src/typescript/src/sim/rng.ts";
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
    const genome = randomGenome(layerSizes(config), createRng(2));
    const episode = new Episode(config, genome, seed, index);
    const counts = itemCounts(config);
    const world = new World(config, counts.food + counts.poison);
    world.scatter(counts.food, counts.poison, createRng(seed));
    const respawnRng = createRng(deriveSeed(seed, index));
    const { x, y, heading } = episode.state;
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
