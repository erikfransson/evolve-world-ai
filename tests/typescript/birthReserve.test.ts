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
    eco: { ...d.eco, wasm: false, initialPopulation: 20, maxPopulation: 50, birthReserve: reserve, foodRegrow: 2, foodMaxDensity: 3,
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
    while (eco.insertCreature({ genome, plan: PLAN, x: 750, y: 750, hue: 5, name: "v" }).ok) added++;
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
    expect(eco.retune({ eco: { birthReserve: 100 } }).ok).toBe(true);
    expect(eco.config.eco.birthReserve).toBe(100);
    expect(eco.retune({ eco: { birthReserve: 5000 } }).ok).toBe(false);
  });
});
