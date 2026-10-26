// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIRTH_WEIGHT_CAP, MAX_LIVE_WEIGHTS, SEED_COPIES, mostCopies } from "../../server/src/config.ts";
import { MAX_ADD_GENOME, MAX_COPIES } from "../../src/typescript/src/live/add.ts";
import { PLAN_LIMITS } from "../../src/typescript/src/sim/rl/validate.ts";
import { SEED_FILE } from "../../server/src/state.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld, seedWeights } from "../../server/src/liveWorld.ts";
import { Saves, openWorld } from "../../server/src/saves.ts";
import { StateStore } from "../../server/src/state.ts";
import { liveConfig } from "../../server/src/config.ts";
import { applyTunables } from "../../server/src/tunables.ts";

import { smallConfig } from "./liveHelpers.ts";

// The brain-weight budget: every save of the live world stays small enough to write and read back inside the unit's memory cap.
const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const ORACLE = FOUNDERS.reduce((a, b) => (b.genome.length > a.genome.length ? b : a));
const fresh = (): LiveWorld => {
  const c = smallConfig();
  c.eco.initialPopulation = 0;
  return new LiveWorld(c, null);
};
const sum = (live: LiveWorld): number => live.eco.members.reduce((s, m) => s + m.creature.brain.genome.length, 0);

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

  // Red without the gate: births went on past the cap, and a world of big brains grew saves that could not be read back.
  it("make births wait at the cap", () => {
    const run = (cap: number): number => {
      const live = fresh();
      live.seedFounders(FOUNDERS, Math.random, 30);
      for (const m of live.eco.members) m.creature.state.energy = 1000; // every one ready to breed
      live.eco.birthWeightCap = cap;
      for (let i = 0; i < 50; i++) live.eco.step();
      return live.eco.births;
    };
    expect(run(Infinity)).toBeGreaterThan(0);
    expect(run(0)).toBe(0);
  });

  it("refuse an add past the budget, and a seed or reset that would start past it", async () => {
    const live = fresh();
    live.seedFounders(FOUNDERS, Math.random, 2);
    live.eco.weights = MAX_LIVE_WEIGHTS - 10; // as if the world were full of big brains
    const f = FOUNDERS[0]!;
    const r = live.addCreatures({ plan: f.plan, genome: f.genome, birth: { energy: 150, cost: 75, cooldown: 10 }, name: "Heavy", hue: 0, copies: 1 });
    expect(r).toMatchObject({ reason: expect.stringMatching(/brain weights it can save/) });
    const copies = Math.ceil(MAX_LIVE_WEIGHTS / ORACLE.genome.length) + 1;
    expect(() => fresh().seedFounders([ORACLE], Math.random, copies)).toThrow(/brain weights/);

    const dir = mkdtempSync(join(tmpdir(), "evolve-weights-"));
    const running = fresh();
    const saves = new Saves(running, new StateStore(dir));
    await openWorld(saves, running, dir, [ORACLE], () => {});
    await expect(saves.reset(copies, 1)).rejects.toThrow(/brain weights/);
    expect(new StateStore(dir).list().length).toBeGreaterThan(0); // nothing moved
  });

  // The budget binds before the population for big brains: the four founders fill it near 3300 creatures (a reset past it is refused,
  // above), while a world of the Juggernaut alone, Live's usual lineage, fits the whole room below the birth reserve.
  it("leave the founders room at the start count, a Juggernaut world the whole room, and the live world its cap", () => {
    expect(seedWeights(FOUNDERS, SEED_COPIES)).toBeLessThanOrEqual(BIRTH_WEIGHT_CAP);
    const jug = FOUNDERS.find((f) => f.name === "Juggernaut")!;
    expect(seedWeights([jug], mostCopies(1, liveConfig.eco))).toBeLessThanOrEqual(BIRTH_WEIGHT_CAP);
    expect(new LiveWorld(structuredClone(liveConfig), null).eco.birthWeightCap).toBe(BIRTH_WEIGHT_CAP);
  });

  it("keep the admin's alive-add limit within the reserve, and a seed below the birth cap", () => {
    const live = fresh();
    expect(applyTunables(live.eco, { "add.aliveMax": 101 })).toMatch(/add.aliveMax/);
    expect(applyTunables(live.eco, { "add.aliveMax": 100 })).toBeNull();
    applyTunables(live.eco, { "add.aliveMax": 50 });
    expect(() => fresh().seedFounders([ORACLE], Math.random, Math.floor(BIRTH_WEIGHT_CAP / ORACLE.genome.length) + 1)).toThrow(/births stop at/);
  });

  // Red with no reserve: births held the world one brain short of the budget, and every add was refused.
  it("keep room for a full add of the largest brains when births have filled the world to their cap", () => {
    const live = fresh();
    live.seedFounders(FOUNDERS, Math.random, 2);
    live.eco.weights = BIRTH_WEIGHT_CAP + MAX_ADD_GENOME; // births wait here: the most a last birth can bring it to
    const L = PLAN_LIMITS;
    const plan = { rayCount: L.rayCount[1], raySpread: 2, rayLength: 150, hiddenLayers: Array<number>(L.layers[1]).fill(L.neurons[1]), memoryShort: L.memory[1], memoryLong: L.memory[1] };
    const r = live.addCreatures({ plan, genome: new Float32Array(MAX_ADD_GENOME), birth: { energy: 150, cost: 75, cooldown: 10 }, name: "Heavy", hue: 0, copies: MAX_COPIES });
    expect(r).toHaveProperty("ids");
  });

  // Red without the cut: a founders file with bigger brains than the seed file's count was chosen for failed every start.
  it("seed fewer copies at a fresh start when the seed file's count would pass the budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evolve-weights-"));
    const copies = Math.floor(BIRTH_WEIGHT_CAP / ORACLE.genome.length) + 50;
    writeFileSync(join(dir, SEED_FILE), `${copies}\n`);
    const live = new LiveWorld(structuredClone(liveConfig), null); // the live world's room: the small one has no place for 1500 creatures
    const lines: string[] = [];
    await openWorld(new Saves(live, new StateStore(dir)), live, dir, [ORACLE], (l) => lines.push(l));
    expect(live.eco.population).toBe(Math.floor(BIRTH_WEIGHT_CAP / ORACLE.genome.length));
    expect([live.seedCopies, Number(readFileSync(join(dir, SEED_FILE), "utf8"))]).toEqual([live.eco.population, live.eco.population]); // what the hello shows and the seed file keeps
    expect(lines.some((l) => l.startsWith("SEED CUT"))).toBe(true);
  }, 60_000);
});
