// @vitest-environment node
import { LIMITS, MAX_POPULATION, liveConfig } from "../../server/src/config.ts";
import { MAX_ADD_GENOME, MAX_COPIES } from "../../src/typescript/src/live/add.ts";
import { PLAN_LIMITS } from "../../src/typescript/src/sim/rl/validate.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { packSave } from "../../server/src/saveParse.ts";
import { MAX_GENOME_FLOATS } from "../../src/typescript/src/sim/ecoState.ts";

import { smallConfig } from "./liveHelpers.ts";

// Brain weights are not capped: the creature cap bounds them at MAX_POPULATION x MAX_ADD_GENOME, and the save limits are set for that.
const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const L = PLAN_LIMITS;
const BIG = { rayCount: L.rayCount[1], raySpread: 2, rayLength: 150, hiddenLayers: Array<number>(L.layers[1]).fill(L.neurons[1]), memoryShort: L.memory[1], memoryLong: L.memory[1] };
const fresh = (): LiveWorld => {
  const c = smallConfig();
  c.eco.initialPopulation = 0;
  return new LiveWorld(c, null);
};
const sum = (live: LiveWorld): number => live.eco.members.reduce((s, m) => s + m.creature.brain.genome.length, 0);
const add = (live: LiveWorld, copies: number, name = "Heavy") =>
  live.addCreatures({ plan: BIG, genome: new Float32Array(MAX_ADD_GENOME).fill(0.5), birth: { energy: 150, cost: 75, cooldown: 10 }, name, hue: 0, copies });

describe("brain weights of the live world", () => {
  it("are counted through births, deaths and a restore", () => {
    const live = fresh();
    live.seedFounders(FOUNDERS, Math.random, 20);
    for (let i = 0; i < 300; i++) live.eco.step();
    expect(live.eco.births + live.eco.deaths).toBeGreaterThan(0);
    expect(live.eco.weights).toBe(sum(live));
    const back = fresh();
    back.restoreState(JSON.parse(JSON.stringify(live.saveState())));
    expect(back.eco.weights).toBe(sum(back));
  });

  // Red with the old weight cap (7 M): births waited there, so mixed worlds stopped near 3000 creatures.
  it("do not hold births back, however many there are", () => {
    const live = fresh();
    live.seedFounders(FOUNDERS, Math.random, 30);
    for (const m of live.eco.members) m.creature.state.energy = 1000; // every one ready to breed
    live.eco.weights = 1e9; // as if the world were full of the largest brains
    for (let i = 0; i < 50; i++) live.eco.step();
    expect(live.eco.births).toBeGreaterThan(0);
  });

  // Red with the old weight cap: an add of the largest brains into a world of big brains was refused.
  it("never refuse an add for its brain size, only for the creature cap", () => {
    const live = fresh();
    live.seedFounders(FOUNDERS, Math.random, 2);
    live.eco.weights = 1e9;
    expect(add(live, MAX_COPIES)).toHaveProperty("ids");
    const cap = live.eco.config.eco.maxPopulation;
    live.eco.retune({ eco: { maxPopulation: live.eco.population + MAX_COPIES - 1, birthReserve: 0 } });
    expect(add(live, MAX_COPIES, "Heavier")).toMatchObject({ reason: expect.stringMatching(/full/) });
    expect(live.eco.population).toBeLessThan(cap);
    expect(add(live, MAX_COPIES - 1, "Heaviest")).toHaveProperty("ids");
    expect(live.eco.population).toBe(live.eco.config.eco.maxPopulation);
  });

  // The bound that now protects memory: a world at the creature cap with every brain at the largest an add allows still packs under
  // LIMITS.maxSaveJsonBytes. Measured on 200 such creatures and scaled, so it goes red when MAX_POPULATION or PLAN_LIMITS grow past it.
  it("keep the largest world's save under the save limit", async () => {
    expect(liveConfig.eco.maxPopulation).toBe(MAX_POPULATION);
    expect(MAX_POPULATION * MAX_ADD_GENOME).toBeLessThanOrEqual(MAX_GENOME_FLOATS); // red at the old 30 M: such a save failed its own check
    const json = async (n: number): Promise<number> => {
      const live = fresh();
      live.eco.retune({ eco: { maxPopulation: 1000, birthReserve: 0 } });
      for (let i = 0; i * MAX_COPIES < n; i++) {
        const r = live.addCreatures({ plan: BIG, genome: Float32Array.from({ length: MAX_ADD_GENOME }, () => Math.fround(Math.random() * 2 - 1)), birth: { energy: 150, cost: 75, cooldown: 10 }, name: `B${i}`, hue: 0, copies: MAX_COPIES });
        expect(r).toHaveProperty("ids");
      }
      return (await packSave(live.saveSnapshot(), LIMITS.maxSaveJsonBytes)).bytes;
    };
    const [a, b] = [await json(100), await json(200)];
    const perCreature = (b - a) / 100;
    expect(perCreature).toBeGreaterThan(MAX_ADD_GENOME * 4 * 4 / 3); // base64 of the float32 genome, at least
    expect(a + perCreature * (MAX_POPULATION - 100) + 10e6).toBeLessThan(LIMITS.maxSaveJsonBytes); // 10 MB: the items at the admin's largest caps
  }, 120_000);
});
