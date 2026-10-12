import { readFileSync } from "node:fs";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { STATE_VERSION, restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";

// A version 1 save made by the engine before the terrain input (tests/typescript/fixtures), with the fingerprint, deaths and food
// eaten that engine reached 150 ticks later. The fixture has no births, whose mutations draw one number per gene and so differ now.
interface Fixture {
  state: EcoState;
  after: { ticks: number; tick: number; fingerprint: number; population: number; deaths: number; foodEaten: number };
}
const fixture = (): Fixture => JSON.parse(readFileSync(new URL("./fixtures/eco-state-v1.json", import.meta.url), "utf8")) as Fixture;

describe("restoring a version 1 save", () => {
  it("is the version the production server saved", () => {
    expect(fixture().state.version).toBe(1);
    expect(STATE_VERSION).toBe(2);
  });

  it("gives every creature the terrain input and runs exactly as the old engine did, with no map", () => {
    const { state, after } = fixture();
    const eco = restoreState(state);
    expect(eco.config.world).toMatchObject({ stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0 });
    expect(eco.members.length).toBe(state.creatures.count);
    const saved = state.creatures.plans.reduce((n, p) => n + p[5]!, 0);
    expect(eco.members.reduce((n, m) => n + m.creature.brain.genome.length, 0)).toBeGreaterThan(saved);
    for (let t = 0; t < after.ticks; t++) eco.step();
    expect({ tick: eco.tick, fingerprint: eco.fingerprint(), population: eco.population, deaths: eco.deaths, foodEaten: eco.foodEaten }).toEqual({ tick: after.tick, fingerprint: after.fingerprint, population: after.population, deaths: after.deaths, foodEaten: after.foodEaten });
  });

  it("saves as version 2 and restores that without change", () => {
    const eco = restoreState(fixture().state);
    const again = saveState(eco);
    expect(again.version).toBe(2);
    const copy = restoreState(JSON.parse(JSON.stringify(again)) as EcoState);
    for (let t = 0; t < 40; t++) {
      eco.step();
      copy.step();
    }
    expect(copy.fingerprint()).toBe(eco.fingerprint());
  });

  it("still rejects a genome of the wrong length, judged in the new layout", () => {
    const wrong = fixture().state;
    wrong.creatures.plans[0]![6] = wrong.creatures.plans[0]![6]! + 1; // another hidden neuron: no layout has this genome length
    expect(() => restoreState(wrong)).toThrow(/does not fit the layout/);
    const unlabelled = fixture().state;
    unlabelled.version = 2; // old-layout genomes under the new version are not upgraded
    expect(() => restoreState(unlabelled)).toThrow(/does not fit the layout/);
    const current = restoreState(fixture().state);
    const modern = saveState(current);
    modern.version = 1; // new-layout genomes under the old version are not accepted either
    expect(() => restoreState(JSON.parse(JSON.stringify(modern)) as EcoState)).toThrow(/does not fit the layout/);
  });

  it("keeps rejecting what it rejected, and unknown versions", () => {
    const state = fixture().state;
    state.creatures.genomes = state.creatures.genomes.slice(0, -8);
    expect(() => restoreState(state)).toThrow(/wrong size/);
    expect(() => restoreState({ ...fixture().state, version: 3 })).toThrow(/version/);
  });
});

describe("a version 2 save with a map", () => {
  it("restores the same world, rock and ground from the saved config and seed", () => {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    const config: EcoConfig = {
      ...d,
      seed: 3,
      world: { ...d.world, width: 1800, height: 1200, stoneDensity: 0.06, ridgeDensity: 0.05, slowDensity: 0.1, fastDensity: 0.1 },
      eco: { ...d.eco, wasm: false, initialPopulation: 60, birthEnergyRange: [76, 76], birthCostRange: [60, 60], birthCooldownRange: [4, 4] },
    };
    const eco = new Ecosystem(config);
    for (let t = 0; t < 60; t++) eco.step();
    const restored = restoreState(JSON.parse(JSON.stringify(saveState(eco))) as EcoState);
    expect(restored.config.world.stoneDensity).toBe(0.06);
    for (let t = 0; t < 60; t++) {
      eco.step();
      restored.step();
    }
    expect(restored.fingerprint()).toBe(eco.fingerprint());
  });
});
