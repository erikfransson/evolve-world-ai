import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { Lineages } from "../../src/typescript/src/sim/lineages.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";

describe("runtime lineages", () => {
  it("are dropped when their last member dies, and extinct rows in older saves are skipped on load", () => {
    const l = new Lineages(3);
    l.describe(10, 120, 0, false, "visitor");
    l.found(10);
    l.born(10);
    expect(l.size(10)).toBe(2);
    l.died(10);
    expect(l.has(10)).toBe(true);
    l.died(10);
    expect(l.has(10)).toBe(false);
    expect(l.toState().late).toEqual([]);

    l.describe(11, 40, 0, false, "kept");
    l.found(11);
    const state = l.toState();
    state.late.push([12, 0, 200, 0, 0, "extinct"]);
    const back = new Lineages(3);
    back.load(state);
    expect(back.has(11)).toBe(true);
    expect(back.has(12)).toBe(false);
    expect(back.firstMismatch(new Map([[11, 1]]))).toBe(-1);
  });

  it("keep seed founder rows at zero", () => {
    const l = new Lineages(2);
    l.describe(1, 10, 0, true);
    l.found(1);
    l.died(1);
    expect(l.has(1)).toBe(true);
    expect(l.size(1)).toBe(0);
  });
});

it("a Live-style world that inserted and lost more founders than a save may list still saves and restores", () => {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  const config = { ...d, seed: 3, world: { ...d.world, width: 600, height: 600 }, eco: { ...d.eco, wasm: false, initialPopulation: 2, birthEnergyRange: [1e6, 1e6] as [number, number] } };
  const eco = new Ecosystem(config);
  const plan: BodyPlan = { rayCount: 3, raySpread: 1, rayLength: 60, hiddenLayers: [2], memoryShort: 0, memoryLong: 0 };
  const genome = randomGenome(layerSizes(config, plan), createRng(1));
  for (let i = 0; i < 20_050; i++) {
    const r = eco.insertCreature({ genome, plan, x: 300, y: 300, hue: 10, name: "v" });
    if (!r.ok) throw new Error(r.reason);
    eco.members.find((m) => m.id === r.id)!.creature.state.energy = 0;
    eco.step();
  }
  const state = JSON.parse(JSON.stringify(saveState(eco)));
  expect(state.lineages.late.length).toBeLessThan(5);
  expect(() => restoreState(state)).not.toThrow();
}, 120_000);
