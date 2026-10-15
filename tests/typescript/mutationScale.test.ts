import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { MUTATION_SCALE_RANGE } from "../../src/typescript/src/sim/ecoInsert.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { InsertSpec } from "../../src/typescript/src/sim/ecosystem.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";

// A small rich world where creatures breed as fast as they can and a child's genome differs from its parent's only by mutation.
function cfg(wasm = false): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d, seed: 4,
    world: { ...d.world, width: 1500, height: 1500, foodDensity: 3 },
    eco: { ...d.eco, wasm, initialPopulation: 10, maxPopulation: 200, foodRegrow: 2, foodMaxDensity: 3, structuralRate: 0, planDrift: 0,
      birthEnergyRange: [21, 21], birthCostRange: [10, 10], birthCooldownRange: [0.5, 0.5] },
  };
}
const PLAN: BodyPlan = { rayCount: 3, raySpread: 1, rayLength: 60, hiddenLayers: [4], memoryShort: 0, memoryLong: 0 };
const genomeOf = (config: EcoConfig): Float32Array => randomGenome(layerSizes(config, PLAN), createRng(2));
const spec = (config: EcoConfig, over: Partial<InsertSpec> = {}): InsertSpec => ({ genome: genomeOf(config), plan: PLAN, x: 750, y: 750, hue: 5, name: "v", ...over });
const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// Inserts one creature with this scale and runs until it has descendants.
function bred(scale: number | undefined, ticks = 600): { eco: Ecosystem; id: number } {
  const config = cfg();
  const eco = new Ecosystem(config);
  const r = eco.insertCreature(spec(config, { mutationScale: scale }));
  if (!r.ok) throw new Error(r.reason);
  for (let t = 0; t < ticks; t++) eco.step();
  return { eco, id: r.id };
}

describe("mutationScale", () => {
  it("is inherited exactly over several generations, and founders have 1", () => {
    const { eco, id } = bred(3.5, 900);
    const family = eco.members.filter((m) => m.founderId === id);
    expect(Math.max(...family.map((m) => m.depth))).toBeGreaterThanOrEqual(3);
    for (const m of family) expect(m.mutationScale).toBe(3.5);
    const others = eco.members.filter((m) => m.founderId !== id);
    expect(others.length).toBeGreaterThan(0);
    for (const m of others) expect(m.mutationScale).toBe(1);
  });

  it("multiplies the mutation std: the children of a scale 4 creature differ from their parent four times as much", () => {
    const rms = (scale: number): number => {
      const config = cfg();
      const eco = new Ecosystem(config);
      const r = eco.insertCreature(spec(config, { mutationScale: scale }));
      if (!r.ok) throw new Error(r.reason);
      const parent = genomeOf(config);
      const seen = new Set<number>();
      let sum = 0;
      let genes = 0;
      for (let t = 0; t < 600; t++) {
        eco.step();
        for (const m of eco.members) {
          if (m.parentId !== r.id || seen.has(m.id)) continue; // the parent's children are caught the tick they are born
          seen.add(m.id);
          const g = m.creature.brain.genome;
          for (let i = 0; i < g.length; i++) sum += (g[i]! - parent[i]!) ** 2;
          genes += g.length;
        }
      }
      expect(genes).toBeGreaterThan(300);
      return Math.sqrt(sum / genes);
    };
    expect(rms(4) / rms(1)).toBeGreaterThan(3.3);
    expect(rms(4) / rms(1)).toBeLessThan(4.7);
  });

  it("changes nothing at 1: an insert with scale 1 runs exactly as one without", () => {
    expect(bred(1).eco.fingerprint()).toBe(bred(undefined).eco.fingerprint());
    expect(bred(2).eco.fingerprint()).not.toBe(bred(undefined).eco.fingerprint());
  });

  it("is refused out of range or not a finite number, and the edges are allowed", () => {
    const config = cfg();
    const eco = new Ecosystem(config);
    const before = eco.population;
    for (const bad of [0, 0.2, 4.1, -1, NaN, Infinity, "2" as unknown as number]) {
      const r = eco.insertCreature(spec(config, { mutationScale: bad }));
      expect(r, String(bad)).toEqual({ ok: false, reason: expect.stringContaining("mutationScale") });
    }
    expect(eco.population).toBe(before);
    for (const edge of MUTATION_SCALE_RANGE) expect(eco.insertCreature(spec(config, { mutationScale: edge })).ok).toBe(true);
    expect(MUTATION_SCALE_RANGE).toEqual([0.25, 4]);
  });
});

describe("mutationScale in a save", () => {
  it("round trips and continues bit-identically, written only for creatures that differ from 1", () => {
    const config = cfg();
    const eco = new Ecosystem(config);
    for (let t = 0; t < 50; t++) eco.step();
    const plain = saveState(eco);
    expect(plain.creatures).not.toHaveProperty("mutationScales");
    const a = eco.insertCreature(spec(config, { mutationScale: 2.5 }));
    eco.insertCreature(spec(config, { mutationScale: 1, x: 300 }));
    for (let t = 0; t < 200; t++) eco.step();
    const saved = json(saveState(eco));
    const scales = saved.creatures.mutationScales!;
    expect(scales.length).toBeGreaterThan(0);
    expect(scales.every(([, v]) => v === 2.5)).toBe(true);
    const copy = restoreState(saved);
    expect(copy.get(a.ok ? a.id : -1)!.mutationScale).toBe(2.5);
    expect(copy.members.map((m) => m.mutationScale)).toEqual(eco.members.map((m) => m.mutationScale));
    for (let t = 0; t < 200; t++) {
      eco.step();
      copy.step();
    }
    expect(copy.fingerprint()).toBe(eco.fingerprint());
    expect(json(saveState(copy))).toEqual(json(saveState(eco)));
  });

  it("restores a save without the field as all 1", () => {
    const { eco } = bred(1, 100);
    const saved = json(saveState(eco));
    expect(saved.creatures).not.toHaveProperty("mutationScales");
    expect(restoreState(saved).members.every((m) => m.mutationScale === 1)).toBe(true);
  });

  it("refuses a scale that is out of range, not a number or at a position that is no creature", () => {
    const { eco } = bred(2, 100);
    const good = json(saveState(eco));
    const n = good.creatures.count;
    const bad: unknown[] = [[[0, 5]], [[0, 0]], [[0, null]], [[0, "2"]], [[n, 2]], [[-1, 2]], [[0.5, 2]], [[0]], "x", [[0, 2], [1, 2], ...new Array<unknown>(n).fill([0, 2])]];
    for (const scales of bad) {
      const state: EcoState = { ...good, creatures: { ...good.creatures, mutationScales: scales as [number, number][] } };
      expect(() => restoreState(json(state)), JSON.stringify(scales)).toThrow(/invalid/);
    }
  });
});
