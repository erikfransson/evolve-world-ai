import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";

// A small, rich world where creatures breed as fast as they can, so births reach any cap within a few seconds.
function cfg(reserve: number): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d, seed: 4,
    world: { ...d.world, width: 1500, height: 1500, foodDensity: 3 },
    eco: { ...d.eco, wasm: false, initialPopulation: 20, maxPopulation: 50, birthReserve: reserve, foodRegrow: 1, foodMaxDensity: 3,
      birthEnergyRange: [21, 21], birthCostRange: [10, 10], birthCooldownRange: [0.5, 0.5] },
  };
}
const PLAN: BodyPlan = { rayCount: 3, raySpread: 1, rayLength: 60, hiddenLayers: [2], memoryShort: 0, memoryLong: 0 };

describe("eco.birthReserve", () => {
  it("stops births that many below maxPopulation while inserts still fill to maxPopulation", () => {
    const eco = new Ecosystem(cfg(10));
    let peak = 0;
    for (let t = 0; t < 1200; t++) {
      eco.step();
      peak = Math.max(peak, eco.population);
    }
    expect(peak).toBe(40); // births reach the reserve line and stop there
    const genome = randomGenome(layerSizes(eco.config, PLAN), createRng(2));
    let added = 0;
    const cap = eco.config.eco.maxPopulation;
    while (added <= cap && eco.insertCreature({ genome, plan: PLAN, x: 750, y: 750, hue: 5, name: "v" }).ok) added++; // capped: an insert that never refuses would hang
    expect(added).toBeLessThanOrEqual(cap);
    expect(eco.population).toBe(50);
    expect(added).toBeGreaterThanOrEqual(10);
  });

  it("is 0 by default, so births run up to maxPopulation as before", () => {
    expect(DEFAULT_ECO_CONFIG.eco.birthReserve).toBe(0);
    const eco = new Ecosystem(cfg(0));
    let peak = 0;
    for (let t = 0; t < 1200; t++) {
      eco.step();
      peak = Math.max(peak, eco.population);
    }
    expect(peak).toBe(50);
  });

  it("is kept by saves, refused on restore when not a whole number in range, and tunable live within its bound", () => {
    const eco = new Ecosystem(cfg(7));
    const state = JSON.parse(JSON.stringify(saveState(eco)));
    expect(restoreState(state).config.eco.birthReserve).toBe(7);
    for (const bad of [-1, 2.5, 1e9]) {
      const s = JSON.parse(JSON.stringify(state));
      s.config.eco.birthReserve = bad;
      expect(() => restoreState(s)).toThrow(/birthReserve/);
    }
    expect(eco.retune({ eco: { birthReserve: 40 } }).ok).toBe(true);
    expect(eco.config.eco.birthReserve).toBe(40);
    expect(eco.retune({ eco: { birthReserve: 5000 } }).ok).toBe(false);
  });
});

// eco.energyCap: a world held at its cap with plenty of food. Red without the check in Ecosystem.eat: everyone ate on and stored
// energy without bound (no birth room, nobody starving), the frozen state the Live server sat in.
describe("eco.energyCap", () => {
  // poison: mild poison everywhere (a bite costs 1), else none, so no one dies and the cap holds births at 0.
  const capped = (energyCap: number, poison = false): Ecosystem => {
    const c = cfg(0);
    c.eco.maxPopulation = 20; // full from the start: births never have room
    c.eco.energyCap = energyCap;
    c.world.poisonDensity = poison ? 1.5 : 0;
    c.eco.poisonRegrow = poison ? 1 : 0;
    c.eco.poisonMaxDensity = poison ? 3 : 0;
    c.world.poisonDamage = 1;
    const eco = new Ecosystem(c);
    for (const m of eco.members) m.creature.state.energy = 15; // below every cap tested, so the start energy does not count
    return eco;
  };

  it("stops a creature eating at energyCap times its birth energy, and leaves the food for others", () => {
    const on = capped(2);
    const off = capped(0);
    for (const eco of [on, off]) for (const m of eco.members) m.creature.state.energy = 10 * m.birth.energy; // well above the cap of 2
    for (let t = 0; t < 900; t++) {
      on.step();
      off.step();
    }
    expect(off.foodEaten).toBeGreaterThan(0); // the same world without the ceiling eats
    expect(on.foodEaten).toBe(0);
  });

  // Red with the check before the item lookup (a full creature skipped eating anything): full creatures were immune to poison.
  it("still lets poison hurt a full creature, which leaves the food alone", () => {
    const eco = capped(2, true);
    for (const m of eco.members) m.creature.state.energy = 50 * m.birth.energy; // far above the cap
    for (let t = 0; t < 900; t++) eco.step();
    expect(eco.foodEaten).toBe(0);
    expect(eco.poisonEaten).toBeGreaterThan(0);
  });

  it("is off by default, kept out of saves when off, restored when on, and refused between 0 and 1 or past its maximum", () => {
    expect(DEFAULT_ECO_CONFIG.eco.energyCap).toBe(0);
    expect("energyCap" in (saveState(capped(0)).config.eco as object)).toBe(false); // saves of other modes are unchanged
    const back = restoreState(JSON.parse(JSON.stringify(saveState(capped(3)))));
    expect(back.config.eco.energyCap).toBe(3);
    const eco = capped(0);
    expect(eco.retune({ eco: { energyCap: 0.5 } }).ok).toBe(false);
    expect(eco.retune({ eco: { energyCap: 101 } }).ok).toBe(false);
    expect(eco.retune({ eco: { energyCap: 5 } }).ok).toBe(true);
    expect(eco.config.eco.energyCap).toBe(5);
    const bad = JSON.parse(JSON.stringify(saveState(capped(3))));
    bad.config.eco.energyCap = 0.5;
    expect(() => restoreState(bad)).toThrow(/energyCap/);
  });
});
