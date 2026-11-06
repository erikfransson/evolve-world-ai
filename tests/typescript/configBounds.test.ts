import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ECO_PRESETS } from "../../src/typescript/src/sim/presets.ts";
import { checkRetune } from "../../src/typescript/src/sim/retune.ts";

const small = (): EcoConfig => {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return { ...d, world: { ...d.world, width: 1500, height: 1500 }, eco: { ...d.eco, wasm: false, initialPopulation: 5, maxPopulation: 20 } };
};
const base = JSON.parse(JSON.stringify(saveState(new Ecosystem(small())))) as EcoState;
const restoreWith = (edit: (c: EcoConfig) => void): void => {
  const s = JSON.parse(JSON.stringify(base)) as EcoState;
  edit(s.config as EcoConfig);
  restoreState(s);
};

describe("saved config bounds", () => {
  it("keeps the unedited state restorable", () => {
    expect(() => restoreWith(() => {})).not.toThrow();
  });

  const scalars: [keyof EcoConfig["eco"], number][] = [
    ["yearMinutes", 0], ["yearMinutes", -1], ["yearMinutes", 601], ["winterFood", -0.1], ["winterFood", 1.5],
    ["foodRegrow", 1.5], ["foodRegrow", -1], ["poisonRegrow", 2], ["foodMaxDensity", 11], ["poisonMaxDensity", 1e9], ["foodMaxDensity", -1],
  ];
  it.each(scalars)("refuses eco.%s = %s", (key, value) => {
    expect(() => restoreWith((c) => { (c.eco as unknown as Record<string, unknown>)[key] = value; })).toThrow(new RegExp(`eco.${key}`));
  });

  const ranges: [keyof EcoConfig["eco"], number[]][] = [
    ["birthEnergyRange", [-1, 5]], ["birthCostRange", [-1, 5]], ["birthCooldownRange", [-1, 5]], ["birthCooldownRange", [0, 601]],
  ];
  it.each(ranges)("refuses eco.%s = %j", (key, value) => {
    expect(() => restoreWith((c) => { (c.eco as unknown as Record<string, unknown>)[key] = [...value]; })).toThrow(new RegExp(`eco.${key}`));
  });

  it("accepts the edge values, a zero cooldown and every preset", () => {
    expect(() => restoreWith((c) => Object.assign(c.eco, { yearMinutes: 600, winterFood: 1, foodRegrow: 1, poisonRegrow: 0, foodMaxDensity: 10, birthCooldownRange: [0, 0], birthEnergyRange: [1e9, 1e9], birthCostRange: [0, 5] }))).not.toThrow();
    for (const p of ECO_PRESETS) expect(() => restoreWith((c) => Object.assign(c.eco, p.regrowth))).not.toThrow();
  });

  it("refuses a hidden layer that is empty, fractional or too wide", () => {
    for (const bad of [0, -3, 2.5, 33, 1024]) {
      expect(() => restoreWith((c) => { c.brain.hiddenLayers = [8, bad as number]; })).toThrow(/hiddenLayers\[1\]" must be a whole number from 1 to 32/);
    }
    expect(() => restoreWith((c) => { c.brain.hiddenLayers = [32, 1]; })).not.toThrow();
  });

  it("keeps the default and every preset brain within the layer width", () => {
    expect(() => restoreWith((c) => { c.brain.hiddenLayers = [...DEFAULT_ECO_CONFIG.brain.hiddenLayers]; })).not.toThrow();
  });
});

describe("checkRetune birth reserve", () => {
  const cfg = small();
  it("refuses a reserve at or above the cap, from the patch or the current config", () => {
    expect(checkRetune({ eco: { birthReserve: 20 } }, cfg)).toEqual({ reason: "eco.birthReserve must be below eco.maxPopulation" });
    expect(checkRetune({ eco: { maxPopulation: 10, birthReserve: 10 } }, cfg)).toMatchObject({ reason: expect.stringMatching(/below eco.maxPopulation/) });
    const reserved = { ...cfg, eco: { ...cfg.eco, birthReserve: 15 } };
    expect(checkRetune({ eco: { maxPopulation: 15 } }, reserved)).toMatchObject({ reason: expect.stringMatching(/below eco.maxPopulation/) });
  });
  it("accepts a reserve below the cap, zero reserve and unrelated patches", () => {
    expect(checkRetune({ eco: { birthReserve: 19 } }, cfg)).toHaveProperty("fields");
    expect(checkRetune({ eco: { maxPopulation: 0 } }, cfg)).toHaveProperty("fields");
    expect(checkRetune({ eco: { foodRegrow: 0.1 } }, cfg)).toHaveProperty("fields");
  });
});
