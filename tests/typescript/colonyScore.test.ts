import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { colonyConfig, count, runSeed, seedDefenders, seedRaiders, share } from "../../src/typescript/src/colonyScore.ts";
import type { Colony } from "../../src/typescript/src/colonyScore.ts";
import type { SeedFounder } from "../../server/src/founders.ts";

// The colony yardstick: raiders start in one cluster, defenders spread, the share is defender / living, and a run is repeatable.

const PLAN: BodyPlan = { rayCount: 3, raySpread: 1, rayLength: 60, hiddenLayers: [4], memoryShort: 0, memoryLong: 0 };
const params = { size: 3000, food: 0.5, poison: 0.01, foodRegrow: 0.002, poisonRegrow: 0.0003 };
const eco0 = new Ecosystem(colonyConfig(params, 1), null);
const genome = new Float32Array(genomeLength(layerSizes((eco0 as any).engines[0], PLAN))).fill(0.1);
const founder = (id: string): SeedFounder => ({ id, name: id, plan: PLAN, genome });
const colony: Colony = { defenders: 12, raiders: 6, defender: founder("d"), raider: founder("r") };

const lcg = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

describe("colonyScore", () => {
  it("builds a plain Live-rules world with births on, the given size and item caps", () => {
    const c = colonyConfig(params, 7);
    expect(c.seed).toBe(7);
    expect(c.world.map).toBe("");
    expect([c.world.width, c.world.height]).toEqual([3000, 3000]);
    expect([c.eco.foodMaxDensity, c.eco.poisonMaxDensity, c.eco.foodRegrow]).toEqual([0.5, 0.01, 0.002]);
    expect(c.eco.initialPopulation).toBe(0);
    expect(c.world.poisonDamage).toBe(50);
  });

  it("puts the raiders in one cluster away from the walls and the defenders over the world", () => {
    const eco = new Ecosystem(colonyConfig(params, 1), null);
    const lineage = new Map<number, "defender" | "raider">(), rng = lcg(5);
    seedDefenders(eco, colony, rng, lineage);
    const center = seedRaiders(eco, colony, rng, lineage);
    expect(eco.members.length).toBe(18);
    const at = (who: string) => eco.members.filter((m) => lineage.get(m.founderId) === who).map((m) => m.creature.state);
    const raiders = at("raider"), defenders = at("defender");
    expect(raiders.length).toBe(6);
    expect(defenders.length).toBe(12);
    expect(center.x).toBeGreaterThanOrEqual(1000);
    expect(center.x).toBeLessThanOrEqual(2000);
    for (const s of raiders) expect(Math.hypot(s.x - center.x, s.y - center.y)).toBeLessThanOrEqual(300 + 1e-6);
    expect(Math.max(...defenders.map((s) => s.x)) - Math.min(...defenders.map((s) => s.x))).toBeGreaterThan(600);
  });

  it("counts lineages by founder and computes the share", () => {
    const eco = new Ecosystem(colonyConfig(params, 1), null);
    const lineage = new Map<number, "defender" | "raider">(), rng = lcg(9);
    seedDefenders(eco, colony, rng, lineage);
    seedRaiders(eco, colony, rng, lineage);
    expect(count(eco, lineage, 0)).toEqual({ min: 0, defender: 12, raider: 6, total: 18, immigrant: 0, arrived: 0 });
    expect(share({ defender: 12, total: 18 })).toBeCloseTo(2 / 3);
    expect(share({ defender: 0, total: 0 })).toBe(0);
  });

  it("repeats: the same seed gives the same samples", () => {
    const a = runSeed(params, colony, 3, 0.5, 0.25), b = runSeed(params, colony, 3, 0.5, 0.25);
    expect(a).toEqual(b);
    expect(a.samples.map((s) => s.min)).toEqual([0, 0.25, 0.5]);
  });

  it("adds immigrants at the asked rate, repeatably, and none by default", () => {
    const a = runSeed(params, colony, 3, 1, 0.5, 0, 6), b = runSeed(params, colony, 3, 1, 0.5, 0, 6);
    expect(a).toEqual(b);
    expect(a.samples[a.samples.length - 1]!.arrived).toBe(6);
    expect(runSeed(params, colony, 3, 1, 0.5).samples.every((s) => s.arrived === 0 && s.immigrant === 0)).toBe(true);
  });
});
