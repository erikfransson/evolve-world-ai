import { itemsPerDensity } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { ItemEconomy, capsOf } from "../../src/typescript/src/sim/itemEconomy.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { HIT_FOOD, HIT_POISON } from "../../src/typescript/src/sim/types.ts";
import { World } from "../../src/typescript/src/sim/world.ts";

// ItemEconomy and capsOf alone: regrowth counting, the cap, the dropped fraction and seasons (Ecosystem runs them in whole worlds elsewhere).

const ITEMS = 5; // the cap of each kind in these worlds
function setup(over: Partial<EcoConfig["eco"]> = {}) {
  const config = structuredClone(DEFAULT_ECO_CONFIG);
  config.world = { ...config.world, width: 1000, height: 1000, stoneDensity: 0, ridgeDensity: 0 };
  const per = itemsPerDensity(config);
  // regrow rates in density units per second: 2.5 items per tick for food, none for poison
  config.eco = { ...config.eco, seasons: false, foodMaxDensity: ITEMS / per, poisonMaxDensity: ITEMS / per, foodRegrow: 2.5 / (per * config.dt), poisonRegrow: 0, ...over };
  const items = new World(config, 100);
  const econ = new ItemEconomy(config, items, createRng(1), capsOf(config, config.eco));
  return { config, items, econ, per };
}
const count = (items: World, kind: number): number => Array.from(items.kinds).filter((k) => k === kind).length;

describe("capsOf", () => {
  it("is the density times the items per density, rounded, with no cell limits on a map without weights", () => {
    const { config, per } = setup();
    const caps = capsOf(config, { foodMaxDensity: 0.5, poisonMaxDensity: 0.25 });
    expect(caps).toEqual({ food: Math.round(0.5 * per), poison: Math.round(0.25 * per), limits: null });
  });
});

describe("ItemEconomy.regrow", () => {
  it("adds the whole items due, carries the fraction, and stops at the cap", () => {
    const { items, econ } = setup();
    econ.regrow(0);
    expect([econ.food, econ.foodDue]).toEqual([2, 0.5]);
    econ.regrow(1);
    expect([econ.food, econ.foodDue]).toEqual([5, 0]);
    expect(count(items, HIT_FOOD)).toBe(5); // the counter agrees with the world
    econ.regrow(2);
    expect(econ.food).toBe(5); // at the cap nothing grows
    expect(econ.foodDue).toBeCloseTo(0.5, 12); // and the whole items due are dropped, the fraction kept
    expect(count(items, HIT_FOOD)).toBe(5);
    expect(econ.poison).toBe(0); // no poison regrowth
    expect(count(items, HIT_POISON)).toBe(0);
  });

  it("drops a huge due at the cap at once and stops when the world has no free slot", () => {
    const { config, items, econ } = setup();
    econ.foodDue = 1e15;
    for (let i = 0; i < 10; i++) econ.regrow(i);
    expect(econ.food).toBe(5);
    expect(econ.foodDue).toBeLessThan(10); // not counted down one item at a time
    const small = new World(config, 3); // a world of 3 slots with a cap of 5
    const tight = new ItemEconomy(config, small, createRng(2), { food: 5, poison: 5, limits: null });
    tight.foodDue = 100;
    tight.regrow(0);
    expect(tight.food).toBe(3); // the slots ran out first
    expect(small.used).toBe(3);
    expect(items.used).toBe(5);
  });

  it("follows the seasons: food regrows in summer and not at mid-winter with winterFood 0", () => {
    const { config, econ } = setup({ seasons: true, winterFood: 0, yearMinutes: 1 });
    econ.regrow(0); // t = 0 is mid-summer: the full rate
    expect(econ.food).toBe(2);
    const winterTick = Math.round(30 / config.dt); // half a year of 60 s
    const before = econ.foodDue;
    econ.regrow(winterTick);
    expect(econ.foodDue).toBeCloseTo(before, 6); // a factor 0 adds nothing
    expect(econ.food).toBe(2);
  });

  it("takes new caps and rates in retune", () => {
    const { config, econ, per } = setup();
    econ.regrow(0);
    econ.regrow(1);
    expect(econ.food).toBe(5);
    config.eco.foodMaxDensity = 8 / per;
    config.eco.foodRegrow = 1 / (per * config.dt);
    econ.retune(capsOf(config, config.eco));
    econ.foodDue = 0;
    econ.regrow(2);
    econ.regrow(3);
    econ.regrow(4);
    expect(econ.food).toBe(8); // one more per tick up to the new cap of 8
  });
});

describe("ItemEconomy.startOk", () => {
  it("accepts a spot on open ground", () => {
    const { econ } = setup();
    expect(econ.startOk(500, 500, 5)).toBe(true);
  });
});
