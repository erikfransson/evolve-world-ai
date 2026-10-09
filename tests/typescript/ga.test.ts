import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SelectionMethod } from "../../src/typescript/src/sim/config.ts";
import { nextGeneration } from "../../src/typescript/src/sim/ga.ts";
import { Population } from "../../src/typescript/src/sim/population.ts";
import { testRng } from "./helpers.ts";

const N = 20;
const L = 6;

function makePop() {
  const rng = testRng(7);
  const pop = new Population(N, L);
  for (let i = 0; i < N; i++) pop.genome(i).set(Float32Array.from({ length: L }, () => rng.normal()));
  const fitness = Float64Array.from({ length: N }, (_, i) => (i * 7) % N); // distinct values
  return { pop, fitness };
}

const base = { ...DEFAULT_CONFIG.ga, eliteFraction: 0.1, parentFraction: 0.25 };
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe("nextGeneration", () => {
  it("keeps population length", () => {
    const { pop, fitness } = makePop();
    expect(nextGeneration(pop, fitness, base, testRng()).size).toBe(N);
  });

  it("copies the best genomes as elites", () => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, base, testRng());
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]);
    for (let i = 0; i < 2; i++) {
      expect(same(out.genome(i), pop.genome(order[i]))).toBe(true);
      expect(out.genome(i).buffer).not.toBe(pop.data.buffer);
    }
  });

  it("gives non-elite children only top parents without mutation or crossover", () => {
    const { pop, fitness } = makePop();
    const ga = { ...base, selection: "truncation" as const, mutationRate: 0, crossover: false };
    const out = nextGeneration(pop, fitness, ga, testRng());
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]);
    const top = order.slice(0, 5).map((i) => pop.genome(i));
    for (let i = 2; i < N; i++) expect(top.some((p) => same(p, out.genome(i)))).toBe(true);
  });

  it("does not mutate inputs", () => {
    const { pop, fitness } = makePop();
    const popCopy = new Float32Array(pop.data);
    const fitCopy = new Float64Array(fitness);
    nextGeneration(pop, fitness, { ...base, mutationRate: 1 }, testRng());
    expect(same(pop.data, popCopy)).toBe(true);
    expect(Array.from(fitness)).toEqual(Array.from(fitCopy));
  });

  it("handles proportional selection with equal fitness", () => {
    const { pop } = makePop();
    const out = nextGeneration(pop, new Float64Array(N).fill(3), { ...base, selection: "proportional" }, testRng());
    expect(out.size).toBe(N);
    expect(out.data.every(Number.isFinite)).toBe(true);
  });

  it.each<SelectionMethod>(["truncation", "proportional"])("runs %s", (selection) => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, { ...base, selection }, testRng());
    expect(out.size).toBe(N);
    expect(out.genomeLength).toBe(L);
    expect(out.data.length).toBe(N * L);
  });

  it("returns an empty population for an empty one", () => {
    expect(nextGeneration(new Population(0, L), new Float64Array(0), base, testRng()).size).toBe(0);
  });
});
