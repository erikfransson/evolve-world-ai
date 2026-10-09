import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SelectionMethod } from "../../src/typescript/src/sim/config.ts";
import { nextGeneration } from "../../src/typescript/src/sim/ga.ts";
import { testRng } from "./helpers.ts";

const N = 20;
const L = 6;

function makePop() {
  const rng = testRng(7);
  const pop = Array.from({ length: N }, () => Float32Array.from({ length: L }, () => rng.normal()));
  const fitness = Float64Array.from({ length: N }, (_, i) => (i * 7) % N); // distinct values
  return { pop, fitness };
}

const base = { ...DEFAULT_CONFIG.ga, eliteFraction: 0.1, parentFraction: 0.25 };
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe("nextGeneration", () => {
  it("keeps population length", () => {
    const { pop, fitness } = makePop();
    expect(nextGeneration(pop, fitness, base, testRng()).length).toBe(N);
  });

  it("copies the best genomes as elites", () => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, base, testRng());
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]);
    for (let i = 0; i < 2; i++) {
      expect(same(out[i], pop[order[i]])).toBe(true);
      expect(out[i]).not.toBe(pop[order[i]]);
    }
  });

  it("gives non-elite children only top parents without mutation or crossover", () => {
    const { pop, fitness } = makePop();
    const ga = { ...base, selection: "truncation" as const, mutationRate: 0, crossover: false };
    const out = nextGeneration(pop, fitness, ga, testRng());
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]);
    const top = order.slice(0, 5).map((i) => pop[i]);
    for (const child of out.slice(2)) expect(top.some((p) => same(p, child))).toBe(true);
  });

  it("does not mutate inputs", () => {
    const { pop, fitness } = makePop();
    const popCopy = pop.map((g) => new Float32Array(g));
    const fitCopy = new Float64Array(fitness);
    nextGeneration(pop, fitness, { ...base, mutationRate: 1 }, testRng());
    pop.forEach((g, i) => expect(same(g, popCopy[i])).toBe(true));
    expect(Array.from(fitness)).toEqual(Array.from(fitCopy));
  });

  it("handles proportional selection with equal fitness", () => {
    const { pop } = makePop();
    const out = nextGeneration(pop, new Float64Array(N).fill(3), { ...base, selection: "proportional" }, testRng());
    expect(out.length).toBe(N);
    expect(out.every((g) => g.every(Number.isFinite))).toBe(true);
  });

  it.each<SelectionMethod>(["truncation", "proportional"])("runs %s", (selection) => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, { ...base, selection }, testRng());
    expect(out.length).toBe(N);
    expect(out.every((g) => g instanceof Float32Array && g.length === L)).toBe(true);
  });
});
