import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { overrideConfig } from "../../src/typescript/src/sim/config.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { MAP_DENSITY_MAX, MAX_PIECES, terrainOf } from "../../src/typescript/src/sim/terrain.ts";

const small = (): EcoConfig => {
  const c = structuredClone(DEFAULT_ECO_CONFIG);
  c.world = { ...c.world, width: 1200, height: 900 };
  c.eco = { ...c.eco, wasm: false, initialPopulation: 10 };
  return c;
};
const saved = (): EcoState => JSON.parse(JSON.stringify(saveState(new Ecosystem(small())))) as EcoState;

describe("map densities from outside", () => {
  it("a save with a density above the form maximum or below zero is refused, quickly", () => {
    for (const [key, bad] of [["slowDensity", 1e9], ["stoneDensity", 1e9], ["fastDensity", MAP_DENSITY_MAX.fastDensity * 1.01], ["ridgeDensity", -0.1]] as const) {
      const state = saved();
      (state.config.world as unknown as Record<string, number>)[key] = bad;
      const t = performance.now();
      expect(() => restoreState(state)).toThrow(new RegExp(key));
      expect(performance.now() - t).toBeLessThan(500);
    }
  });

  it("a save with an item radius outside the form range is refused", () => {
    for (const bad of [0, 1.9, 10.1, 1e9]) {
      const state = saved();
      state.config.world.itemRadius = bad;
      expect(() => restoreState(state)).toThrow(/itemRadius/);
    }
  });

  it("a save whose creatures are too big to place among rock is refused, and a build at the largest body size finishes", () => {
    const state = saved();
    state.creatures.count = 0;
    state.config.world.stoneDensity = 0.2;
    state.config.creature.radius = 440; // the repro of a founder placement loop that never ended
    const t = performance.now();
    expect(() => restoreState(state)).toThrow(/radius/);
    expect(performance.now() - t).toBeLessThan(500);
    const c = small();
    Object.assign(c.world, { stoneDensity: 0.2, ridgeDensity: 0.15 });
    c.creature.radius = 40;
    const t2 = performance.now();
    expect(new Ecosystem({ ...c, eco: { ...c.eco, initialPopulation: 30 } }).population).toBe(30);
    expect(performance.now() - t2).toBeLessThan(5000);
  });

  it("the form maxima themselves are accepted", () => {
    const state = saved();
    Object.assign(state.config.world, MAP_DENSITY_MAX);
    expect(() => restoreState(state)).not.toThrow();
  });

  it("pasted or scripted settings are held to the same range", () => {
    expect(() => overrideConfig(DEFAULT_ECO_CONFIG, { world: { slowDensity: 5 } })).toThrow(/slowDensity/);
    expect(overrideConfig(DEFAULT_ECO_CONFIG, { world: { slowDensity: 0.3 } }).world.slowDensity).toBe(0.3);
  });

  it("an absurd density that gets past the checks builds at most the piece cap, in bounded time", () => {
    const t = performance.now();
    const map = terrainOf({ seed: 77, world: { width: 50_000, height: 50_000, stoneDensity: 1e9, ridgeDensity: 1e9, slowDensity: 1e9, fastDensity: 1e9 } });
    expect(performance.now() - t).toBeLessThan(20_000);
    expect(map.patchX.length).toBeLessThanOrEqual(2 * MAX_PIECES * 6);
    expect(map.rockCount).toBeLessThanOrEqual(2 * MAX_PIECES * 80);
  });
});
