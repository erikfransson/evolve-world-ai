import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";

const PLAN: BodyPlan = { rayCount: 5, raySpread: 2, rayLength: 90, hiddenLayers: [7], memoryShort: 2, memoryLong: 1 };

// The member table is private; the batch order and finishTick rely on bySlot matching the member list, and the hot loops on every column matching it too.
function check(eco: Ecosystem): void {
  const { bySlot, states, kinds, birthEnergies, byId } = (eco as unknown as { table: { bySlot: Ecosystem["members"]; states: unknown[]; kinds: Int32Array; birthEnergies: Float64Array; byId: Map<number, unknown> } }).table;
  const sorted = [...eco.members].sort((a, b) => a.creature.slot - b.creature.slot);
  expect(bySlot.length).toBe(sorted.length);
  expect(bySlot.every((m, i) => m === sorted[i])).toBe(true);
  expect(eco.members.every((m, i) => m.index === i)).toBe(true);
  expect(states.length).toBe(eco.members.length);
  expect(byId.size).toBe(eco.members.length);
  eco.members.forEach((m, i) => {
    expect(states[i]).toBe(m.creature.state);
    expect(kinds[i]).toBe(m.species);
    expect(birthEnergies[i]).toBe(m.birth.energy);
    expect(byId.get(m.id)).toBe(m);
  });
}

describe("members in slot order", () => {
  it("bySlot and index stay consistent through births, deaths, inserts, restore and two species", () => {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    const base: EcoConfig = {
      ...d, seed: 5, world: { ...d.world, width: 900, height: 900 }, creature: { ...d.creature, startEnergy: 60 },
      eco: { ...d.eco, initialPopulation: 60, structuralRate: 0.3, aging: true, agingStart: 5, agingRate: 3, birthEnergyRange: [76, 76], birthCostRange: [75, 75], birthCooldownRange: [10, 10] },
    };
    const hunt = structuredClone(DEFAULT_PREDATOR_CONFIG);
    hunt.species![0]!.founders = 70;
    hunt.species![1]!.founders = 25;
    const hunting: EcoConfig = { ...hunt, seed: 7, world: { ...hunt.world, width: 900, height: 700 }, eco: { ...hunt.eco, structuralRate: 0.3 } };

    for (const config of [base, hunting]) {
      let eco = new Ecosystem(structuredClone(config));
      for (let t = 0; t < 300; t++) {
        eco.step();
        if (t % 50 === 0) check(eco);
        if (t === 100) eco.insertCreature({ genome: randomGenome(layerSizes(config, PLAN), createRng(11)), plan: PLAN, x: 450, y: 450, hue: 300, name: "Zed" });
        if (t === 200) eco = restoreState(JSON.parse(JSON.stringify(saveState(eco))), null);
      }
      expect(eco.births).toBeGreaterThan(0);
      expect(eco.deaths).toBeGreaterThan(0);
      check(eco);
    }
  });
});
