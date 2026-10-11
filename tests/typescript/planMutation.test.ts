import { Brain, genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { driftBirth, driftPlan, mutateStructure, randomBirth, randomPlan, remapWeights } from "../../src/typescript/src/sim/planMutation.ts";
import type { UnitMaps } from "../../src/typescript/src/sim/planMutation.ts";
import { OUTPUT_SIZE, inputLayout, planOf } from "../../src/typescript/src/sim/sensors.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import type { Rng } from "../../src/typescript/src/sim/types.ts";
import { testRng } from "./helpers.ts";

const cfg = DEFAULT_ECO_CONFIG;
const eco = cfg.eco;

// Random weights and biases, so a dropped or misplaced bias shows.
function genomeFor(sizes: readonly number[], seed: number): Float32Array {
  const rng = testRng(seed);
  return randomGenome(sizes, rng).map(() => rng.normal());
}

// Outputs of the old and the remapped network on the same inputs, as seen through the maps.
function compare(oldSizes: readonly number[], old: Float32Array, maps: UnitMaps, seed: number): { before: number[]; after: number[] } {
  const newSizes = maps.map((m) => m.length);
  const remapped = new Float32Array(genomeLength(newSizes));
  remapWeights(oldSizes, old, maps, remapped, testRng(seed));
  const rng = testRng(seed + 1);
  const inNew = Float32Array.from({ length: newSizes[0]! }, () => rng.range(-1, 1));
  const inOld = new Float32Array(oldSizes[0]!);
  maps[0]!.forEach((o, j) => { if (o >= 0) inOld[o] = inNew[j]!; });
  const outOld = new Float32Array(oldSizes.at(-1)!);
  const outNew = new Float32Array(newSizes.at(-1)!);
  new Brain(oldSizes, old).forward(inOld, outOld);
  new Brain(newSizes, remapped).forward(inNew, outNew);
  const last = maps.at(-1)!;
  const kept = [...last.keys()].filter((j) => last[j]! >= 0);
  return { before: kept.map((j) => outOld[last[j]!]!), after: kept.map((j) => outNew[j]!) };
}

describe("remapWeights", () => {
  it("an added hidden neuron with zero outgoing weights leaves the outputs unchanged", () => {
    const sizes = [10, 6, 4];
    const maps = [Int32Array.from({ length: 10 }, (_, i) => i), Int32Array.of(0, 1, 2, -1, 3, 4, 5), Int32Array.of(0, 1, 2, 3)];
    const { before, after } = compare(sizes, genomeFor(sizes, 1), maps, 2);
    expect(after).toEqual(before);
  });

  it("keeps every surviving weight and bias when a unit is removed", () => {
    const sizes = [5, 4, 3];
    const old = genomeFor(sizes, 3);
    const maps = [Int32Array.of(0, 1, 2, 3, 4), Int32Array.of(0, 2, 3), Int32Array.of(0, 1, 2)];
    const out = new Float32Array(genomeLength([5, 3, 3]));
    remapWeights(sizes, old, maps, out, testRng(1));
    const a = new Brain(sizes, old);
    const b = new Brain([5, 3, 3], out);
    expect(Array.from(b.weights[0]!.subarray(5, 10))).toEqual(Array.from(a.weights[0]!.subarray(10, 15))); // new neuron 1 is old 2
    expect(Array.from(b.biases[0]!)).toEqual([0, 2, 3].map((k) => a.biases[0]![k]));
    expect(Array.from(b.weights[1]!.subarray(0, 3))).toEqual([0, 2, 3].map((k) => a.weights[1]![k]));
  });
});

describe("mutateStructure", () => {
  it("changes one ray, hidden neuron or memory unit within the ranges, and growth keeps the outputs", () => {
    const rng = testRng(7);
    const plan: BodyPlan = { ...planOf(cfg), hiddenLayers: [6, 5] };
    let sizes = layerSizes(cfg, plan);
    let genome = genomeFor(sizes, 11);
    const kinds = new Set<string>();
    for (let step = 0; step < 300; step++) {
      const before = { ...plan, hiddenLayers: plan.hiddenLayers.slice() };
      const maps = mutateStructure(plan, inputLayout(cfg, before), sizes, eco, rng);
      if (!maps) continue;
      const next = layerSizes(cfg, plan);
      expect(maps.map((m) => m.length)).toEqual(next);
      const delta = plan.rayCount - before.rayCount + plan.memoryShort - before.memoryShort + plan.memoryLong - before.memoryLong + plan.hiddenLayers.reduce((s, n, l) => s + n - before.hiddenLayers[l]!, 0);
      expect(Math.abs(delta)).toBe(1);
      // A kept unit stays what it was: ray input, extra, short or long memory; turn, thrust, short or long target.
      const [was, now] = [inputLayout(cfg, before), inputLayout(cfg, plan)];
      const inRole = (l: typeof was, i: number) => (i < l.rays * l.rayFeatures ? "ray" : i < l.memoryAt ? "extra" : i < l.memoryAt + l.memoryShort ? "short" : "long");
      const outRole = (l: typeof was, j: number) => (j < OUTPUT_SIZE ? `out${j}` : j < OUTPUT_SIZE + l.memoryShort ? "short" : "long");
      maps[0]!.forEach((o, j) => { if (o >= 0) expect([step, "in", inRole(now, j)]).toEqual([step, "in", inRole(was, o)]); });
      maps.at(-1)!.forEach((o, j) => { if (o >= 0) expect([step, "out", outRole(now, j)]).toEqual([step, "out", outRole(was, o)]); });
      kinds.add(plan.rayCount !== before.rayCount ? "ray" : plan.hiddenLayers.some((n, l) => n !== before.hiddenLayers[l]) ? "hidden" : "memory");
      expect(plan.rayCount).toBeGreaterThanOrEqual(eco.rayCountRange[0]!);
      expect(plan.rayCount).toBeLessThanOrEqual(eco.rayCountRange[1]!);
      expect(Math.min(plan.memoryShort, plan.memoryLong)).toBeGreaterThanOrEqual(eco.memoryRange[0]!);
      if (delta > 0) {
        const { before: a, after: b } = compare(sizes, genome, maps, step);
        expect(b).toEqual(a);
      }
      const remapped = new Float32Array(genomeLength(next));
      remapWeights(sizes, genome, maps, remapped, rng);
      sizes = next;
      genome = remapped;
    }
    expect([...kinds].sort()).toEqual(["hidden", "memory", "ray"]);
  });

  it("random founder plans and drift stay within the ranges", () => {
    const rng = testRng(5);
    const plan = planOf(cfg);
    for (let i = 0; i < 200; i++) {
      randomPlan(eco, rng, plan);
      driftPlan(plan, 0.5, eco, rng);
      expect(plan.raySpread).toBeGreaterThanOrEqual(eco.raySpreadRange[0]!);
      expect(plan.raySpread).toBeLessThanOrEqual(eco.raySpreadRange[1]!);
      expect(plan.rayLength).toBeGreaterThanOrEqual(eco.rayLengthRange[0]!);
      expect(plan.rayLength).toBeLessThanOrEqual(eco.rayLengthRange[1]!);
      expect(plan.hiddenLayers[0]).toBeGreaterThanOrEqual(eco.hiddenRange[0]!);
      expect(plan.hiddenLayers[0]).toBeLessThanOrEqual(eco.hiddenRange[1]!);
      expect(plan.memoryLong).toBeLessThanOrEqual(eco.memoryRange[1]!);
    }
  });
});

// An Rng that plays back the given integers and floats, to steer mutateStructure's choices.
function scripted(ints: number[], floats: number[]): Rng {
  return { next: () => floats.shift()!, range: (a) => a, int: () => ints.shift()!, normal: () => 0 };
}

describe("mutateStructure choices", () => {
  const pinned = { ...eco, hiddenRange: [4, 4], memoryRange: [1, 1] };

  it("removes exactly the hidden neuron it drew", () => {
    const plan: BodyPlan = { ...planOf(cfg), hiddenLayers: [5] };
    const sizes = layerSizes(cfg, plan);
    const maps = mutateStructure(plan, inputLayout(cfg, plan), sizes, { ...pinned, hiddenRange: [2, 8] }, scripted([1, 0, 2], [0.9]))!; // kind hidden, layer 0, shrink, neuron 2
    expect(Array.from(maps[1]!)).toEqual([0, 1, 3, 4]);
    expect(plan.hiddenLayers).toEqual([4]);
  });

  it("turns a grow into a shrink at the top of the range, so the change is not lost", () => {
    const plan: BodyPlan = { ...planOf(cfg), rayCount: eco.rayCountRange[1]!, hiddenLayers: [4], memoryShort: 1, memoryLong: 1 };
    const maps = mutateStructure(plan, inputLayout(cfg, plan), layerSizes(cfg, plan), pinned, scripted([0, 0], [0.1])); // kind ray, grow
    expect(maps).not.toBeNull();
    expect(plan.rayCount).toBe(eco.rayCountRange[1]! - 1);
  });
});

describe("plan drift and founders", () => {
  it("a small drift moves the plan a little and a huge one still lands inside the ranges", () => {
    const rng = testRng(9);
    const plan = planOf(cfg);
    const [spread, length] = [plan.raySpread, plan.rayLength];
    driftPlan(plan, 0.01, eco, rng);
    expect(Math.abs(plan.raySpread / spread - 1)).toBeLessThan(0.1);
    expect(Math.abs(plan.rayLength / length - 1)).toBeLessThan(0.1);
    for (let i = 0; i < 100; i++) {
      driftPlan(plan, 5, eco, rng);
      expect(plan.rayLength).toBeGreaterThanOrEqual(eco.rayLengthRange[0]!);
      expect(plan.rayLength).toBeLessThanOrEqual(eco.rayLengthRange[1]!);
    }
  });

  it("founders reach both ends of the integer ranges and draw short and long memory independently", () => {
    const rng = testRng(4);
    const plan: BodyPlan = { ...planOf(cfg), hiddenLayers: [8] };
    const rays = new Set<number>();
    const hidden = new Set<number>();
    let differ = 0;
    for (let i = 0; i < 400; i++) {
      randomPlan(eco, rng, plan);
      rays.add(plan.rayCount);
      hidden.add(plan.hiddenLayers[0]!);
      if (plan.memoryShort !== plan.memoryLong) differ++;
    }
    expect([Math.min(...rays), Math.max(...rays)]).toEqual(eco.rayCountRange);
    expect([Math.min(...hidden), Math.max(...hidden)]).toEqual(eco.hiddenRange);
    expect(differ).toBeGreaterThan(0);
  });

  it("birth traits drift inside their own ranges", () => {
    const rng = testRng(2);
    const ranges = { birthEnergyRange: [100, 200], birthCostRange: [1, 2], birthCooldownRange: [0, 5] };
    const t = { energy: 0, cost: 0, cooldown: 0 };
    randomBirth(ranges, rng, t);
    for (let i = 0; i < 100; i++) {
      driftBirth(t, 3, ranges, rng);
      expect(t.energy).toBeGreaterThanOrEqual(100);
      expect(t.energy).toBeLessThanOrEqual(200);
      expect(t.cost).toBeGreaterThanOrEqual(1);
      expect(t.cost).toBeLessThanOrEqual(2);
      expect(t.cooldown).toBeGreaterThanOrEqual(0);
      expect(t.cooldown).toBeLessThanOrEqual(5);
    }
  });

  it("a new neuron's incoming weights are small, at the initial 1/sqrt(fan-in) scale", () => {
    const sizes = [400, 3, 2];
    const maps = [Int32Array.from({ length: 400 }, (_, i) => i), Int32Array.of(0, 1, 2, -1), Int32Array.of(0, 1)];
    const out = new Float32Array(genomeLength([400, 4, 2]));
    remapWeights(sizes, genomeFor(sizes, 1), maps, out, testRng(3));
    const incoming = Array.from(out.subarray(3 * 400, 4 * 400));
    expect(Math.max(...incoming.map(Math.abs))).toBeLessThan(0.2); // N(0, 0.05^2); scale 1 would reach 3
    expect(Math.max(...incoming.map(Math.abs))).toBeGreaterThan(0);
  });
});
