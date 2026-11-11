// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIRTH_WEIGHT_CAP, LIMITS, MAX_LIVE_WEIGHTS, MAX_POPULATION, WEIGHT_RESERVE, liveConfig, mostCopies } from "../../server/src/config.ts";
import { Saves, openWorld } from "../../server/src/saves.ts";
import { SEED_FILE, StateStore } from "../../server/src/state.ts";
import { MAX_ADD_GENOME, MAX_COPIES } from "../../src/typescript/src/live/add.ts";
import { PLAN_LIMITS } from "../../src/typescript/src/sim/rl/validate.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { packSave } from "../../server/src/saveParse.ts";
import { MAX_GENOME_FLOATS } from "../../src/typescript/src/sim/ecoState.ts";

import { smallConfig } from "./liveHelpers.ts";

// The brain-weight rail (MAX_LIVE_WEIGHTS): the most weights alive at once, the 5000 largest brains the memory and save limits are sized for.
const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const L = PLAN_LIMITS;
const BIG = { rayCount: L.rayCount[1], raySpread: 2, rayLength: 150, hiddenLayers: Array<number>(L.layers[1]).fill(L.neurons[1]), memoryShort: L.memory[1], memoryLong: L.memory[1] };
const fresh = (): LiveWorld => {
  const c = smallConfig();
  c.eco.initialPopulation = 0;
  return new LiveWorld(c, null);
};
const ORACLE = FOUNDERS.reduce((a, b) => (b.genome.length > a.genome.length ? b : a));
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

  // Red without the gate in Ecosystem.birthRoom: births went on past the rail, so 12000 large brains could come to exist.
  it("make births wait at the rail, and not below it", () => {
    const run = (weights: number | null): number => {
      const live = fresh();
      live.seedFounders(FOUNDERS, Math.random, 30);
      for (const m of live.eco.members) m.creature.state.energy = 1000; // every one ready to breed
      if (weights !== null) live.eco.weights = weights; // as if the world were full of the largest brains
      for (let i = 0; i < 50; i++) live.eco.step();
      return live.eco.births;
    };
    expect(fresh().eco.birthWeightCap).toBe(BIRTH_WEIGHT_CAP);
    expect(run(null)).toBeGreaterThan(0);
    expect(run(BIRTH_WEIGHT_CAP - 100 * MAX_ADD_GENOME)).toBeGreaterThan(0);
    expect(run(BIRTH_WEIGHT_CAP + 1)).toBe(0);
  });

  // Red without the check in addCreatures: an add of the largest brains went in past the rail.
  it("refuse an add past the rail with the reason, and take one that fits", () => {
    const live = fresh();
    live.seedFounders(FOUNDERS, Math.random, 2);
    live.eco.weights = MAX_LIVE_WEIGHTS - MAX_COPIES * MAX_ADD_GENOME + 1; // one weight short of a full add of the largest brains
    const pop = live.eco.population;
    expect(add(live, MAX_COPIES)).toMatchObject({ reason: expect.stringMatching(/brain weights it can save/) });
    expect(live.eco.population).toBe(pop);
    expect(add(live, MAX_COPIES - 1, "Lighter")).toHaveProperty("ids");
    expect(live.eco.weights).toBeLessThanOrEqual(MAX_LIVE_WEIGHTS);
  });

  // Births stop at BIRTH_WEIGHT_CAP plus one child and adds at MAX_LIVE_WEIGHTS (both above), so at most MAX_LIVE_WEIGHTS / MAX_ADD_GENOME
  // creatures of the largest brain are ever alive: 5000, not the 12000 the population cap allows, and inside the restore check.
  it("hold the largest brains to 5000, while founder-sized brains fill the population cap", () => {
    expect(MAX_POPULATION).toBe(12000);
    expect(MAX_POPULATION * MAX_ADD_GENOME).toBeGreaterThan(MAX_LIVE_WEIGHTS); // the case the rail is for: 90 M weights
    expect(Math.floor(MAX_LIVE_WEIGHTS / MAX_ADD_GENOME)).toBe(5000);
    expect(BIRTH_WEIGHT_CAP + MAX_ADD_GENOME + WEIGHT_RESERVE).toBe(MAX_LIVE_WEIGHTS);
    expect(MAX_LIVE_WEIGHTS).toBeLessThanOrEqual(MAX_GENOME_FLOATS); // every world under the rail restores
    // The shipped founders, as many as a fresh 12000 world seeds (one founder per group, as one per home on the Six Realms), and 12000
    // creatures of their mean brain sit well below where births wait.
    const live = fresh();
    expect(live.freshEco.maxPopulation).toBe(MAX_POPULATION);
    const mean = FOUNDERS.reduce((a, f) => a + f.genome.length, 0) / FOUNDERS.length;
    expect(live.seedWeights(FOUNDERS, mostCopies(live.seedGroups(FOUNDERS.length), live.freshEco))).toBeLessThan(0.8 * BIRTH_WEIGHT_CAP);
    expect(MAX_POPULATION * mean).toBeLessThan(0.8 * BIRTH_WEIGHT_CAP);
  });

  // Red without the checks: a reset to more copies of big brains than the rail holds was written, and the next start failed every time.
  it("refuse a seed or reset that would start past the rail, and cut the seed file's count at a fresh start", async () => {
    const copies = Math.floor(BIRTH_WEIGHT_CAP / ORACLE.genome.length) + 1; // about 8200, below the room of 11900 a fresh world has
    const big = fresh();
    expect(() => big.seedFounders([ORACLE], Math.random, copies)).toThrow(/brain weights/);
    const dir = mkdtempSync(join(tmpdir(), "evolve-weights-"));
    const running = fresh();
    const saves = new Saves(running, new StateStore(dir));
    await openWorld(saves, running, dir, [ORACLE], () => {});
    await expect(saves.reset(copies, 1)).rejects.toThrow(/brain weights/);
    expect(new StateStore(dir).list().length).toBeGreaterThan(0); // nothing moved

    const dir2 = mkdtempSync(join(tmpdir(), "evolve-weights-"));
    writeFileSync(join(dir2, SEED_FILE), `${copies}\n`);
    const cut = fresh();
    const lines: string[] = [];
    const store = new StateStore(dir2);
    const spy = vi.spyOn(cut, "seedFounders").mockImplementation((_f, _r, n) => n ?? 0); // only the count matters here, not 8000 spots on a small map
    await openWorld(new Saves(cut, store), cut, dir2, [ORACLE], (l) => lines.push(l));
    expect(spy.mock.calls[0]![2]).toBe(Math.floor(BIRTH_WEIGHT_CAP / ORACLE.genome.length));
    expect(lines.some((l) => l.startsWith("SEED CUT"))).toBe(true);
    expect(Number(readFileSync(join(dir2, SEED_FILE), "utf8"))).toBe(cut.seedCopies);
  }, 60_000);

  // The bound that protects memory: a world at the weight rail with every brain at the largest an add allows still packs under
  // LIMITS.maxSaveJsonBytes. Measured on 200 such creatures and scaled, so it goes red when MAX_LIVE_WEIGHTS or PLAN_LIMITS grow past it.
  it("keep the largest world's save under the save limit", async () => {
    expect(liveConfig.eco.maxPopulation).toBe(MAX_POPULATION);
    const most = Math.floor(MAX_LIVE_WEIGHTS / MAX_ADD_GENOME); // the most creatures of the largest brain the rail lets live
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
    expect(a + perCreature * (most - 100) + 10e6).toBeLessThan(LIMITS.maxSaveJsonBytes); // 10 MB: the items at the admin's largest caps
  }, 120_000);
});
