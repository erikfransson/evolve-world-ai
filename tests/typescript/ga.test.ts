import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SelectionMethod } from "../../src/typescript/src/sim/config.ts";
import { BIG_MUTATION, SELECTION_PICKERS, STAGNATION_BOOST, bigMutate, isStagnant, mutate, nextGeneration } from "../../src/typescript/src/sim/ga.ts";
import { Population } from "../../src/typescript/src/sim/population.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
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

const base = { ...DEFAULT_CONFIG.ga, eliteFraction: 0.1, parentFraction: 0.25, immigrantFraction: 0, bigMutationFraction: 0 };
const fresh = () => Float32Array.from({ length: L }, () => 100); // marker no mutation of a normal genome reaches
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe("nextGeneration", () => {
  it("keeps population length", () => {
    const { pop, fitness } = makePop();
    expect(nextGeneration(pop, fitness, base, createRng(1), fresh).size).toBe(N);
  });

  it("copies the best genomes as elites", () => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, base, createRng(1), fresh);
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]);
    for (let i = 0; i < 2; i++) {
      expect(same(out.genome(i), pop.genome(order[i]))).toBe(true);
      expect(out.genome(i).buffer).not.toBe(pop.data.buffer);
    }
  });

  it("gives non-elite children only top parents without mutation or crossover", () => {
    const { pop, fitness } = makePop();
    const ga = { ...base, selection: "truncation" as const, mutationRate: 0, crossover: false };
    const out = nextGeneration(pop, fitness, ga, createRng(1), fresh);
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]);
    const top = order.slice(0, 5).map((i) => pop.genome(i));
    for (let i = 2; i < N; i++) expect(top.some((p) => same(p, out.genome(i)))).toBe(true);
  });

  it("does not mutate inputs", () => {
    const { pop, fitness } = makePop();
    const popCopy = new Float32Array(pop.data);
    const fitCopy = new Float64Array(fitness);
    nextGeneration(pop, fitness, { ...base, mutationRate: 1 }, createRng(1), fresh);
    expect(same(pop.data, popCopy)).toBe(true);
    expect(Array.from(fitness)).toEqual(Array.from(fitCopy));
  });

  it("handles proportional selection with equal fitness", () => {
    const { pop } = makePop();
    const out = nextGeneration(pop, new Float64Array(N).fill(3), { ...base, selection: "proportional" }, createRng(1), fresh);
    expect(out.size).toBe(N);
    expect(out.data.every(Number.isFinite)).toBe(true);
  });

  it.each<SelectionMethod>(["truncation", "proportional"])("runs %s", (selection) => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, { ...base, selection }, createRng(1), fresh);
    expect(out.size).toBe(N);
    expect(out.genomeLength).toBe(L);
    expect(out.data.length).toBe(N * L);
  });

  it("returns an empty population for an empty one", () => {
    expect(nextGeneration(new Population(0, L), new Float64Array(0), base, createRng(1), fresh).size).toBe(0);
  });

  it.each<SelectionMethod>(["truncation", "proportional"])("matches the plain Rng-call breeding for %s", (selection) => {
    const { pop, fitness } = makePop();
    const ga = { ...base, selection, mutationRate: 0.3 };
    const rng = createRng(5);
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]);
    const pick = SELECTION_PICKERS[selection](fitness, order, ga, rng);
    const elites = Math.round(ga.eliteFraction * N);
    const expected = new Population(N, L);
    for (let i = 0; i < elites; i++) expected.genome(i).set(pop.genome(order[i]));
    for (let i = elites; i < N; i++) {
      const child = expected.genome(i);
      child.set(pop.genome(pick()));
      const b = pop.genome(pick());
      for (let g = 0; g < L; g++) if (rng.next() < 0.5) child[g] = b[g];
      for (let g = 0; g < L; g++) if (rng.next() < ga.mutationRate) child[g] += rng.normal() * ga.mutationStd;
    }
    const out = nextGeneration(pop, fitness, ga, createRng(5), fresh);
    expect(same(out.data, expected.data)).toBe(true);
  });
});

describe("mutate", () => {
  it.each([0, 0.3, 1])("draws the same stream as plain Rng calls (rate %s)", (mutationRate) => {
    const ga = { mutationRate, mutationStd: 0.5 };
    const parent = Float32Array.from({ length: 50 }, (_, g) => g / 10);
    const child = parent.slice();
    const rng = createRng(9);
    mutate(child, ga.mutationRate, ga.mutationStd, rng);
    const expected = parent.slice();
    const ref = createRng(9);
    for (let g = 0; g < expected.length; g++) if (ref.next() < mutationRate) expected[g] += ref.normal() * ga.mutationStd;
    expect(same(child, expected)).toBe(true);
    expect(rng.next()).toBe(ref.next());
    expect(same(child, parent)).toBe(mutationRate === 0);
  });
});

describe("mutate on a brain-sized genome", () => {
  it("matches plain Rng calls over many hits, including one on the last gene", () => {
    for (const seed of [1, 2, 3]) {
      const parent = Float32Array.from({ length: 4000 }, (_, g) => Math.sin(g));
      const child = parent.slice();
      const rng = createRng(seed);
      mutate(child, 0.05, 0.3, rng);
      const expected = parent.slice();
      const ref = createRng(seed);
      for (let g = 0; g < expected.length; g++) if (ref.next() < 0.05) expected[g] += ref.normal() * 0.3;
      expect(same(child, expected)).toBe(true);
      expect(rng.next()).toBe(ref.next());
    }
  });
});

describe("immigrants and big mutations", () => {
  const ga = { ...base, eliteFraction: 0.1, immigrantFraction: 0.2, bigMutationFraction: 0.25, mutationRate: 0, crossover: false };

  it("fills the immigrant share with fresh genomes after the children", () => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, ga, createRng(1), fresh);
    const isFresh = (i: number) => out.genome(i).every((v) => v === 100);
    expect(Array.from({ length: N }, (_, i) => i).filter(isFresh)).toEqual([16, 17, 18, 19]);
  });

  it("gives the big-mutation share changed children and leaves others as parents", () => {
    const { pop, fitness } = makePop();
    const out = nextGeneration(pop, fitness, ga, createRng(1), fresh);
    const parents = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a]).slice(0, 5).map((i) => pop.genome(i));
    const unchanged = (i: number) => parents.some((p) => same(p, out.genome(i)));
    const changed = Array.from({ length: 16 }, (_, i) => i).filter((i) => !unchanged(i));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((i) => i >= 2 && i < 7)).toBe(true); // 2 elites, then round(0.25 * 20) = 5 big children
  });

  it("is deterministic and does not touch the input", () => {
    const { pop, fitness } = makePop();
    const copy = new Float32Array(pop.data);
    const a = nextGeneration(pop, fitness, ga, createRng(3), fresh);
    const b = nextGeneration(pop, fitness, ga, createRng(3), fresh);
    expect(same(a.data, b.data)).toBe(true);
    expect(same(pop.data, copy)).toBe(true);
  });

  it("bigMutate flips signs and adds noise", () => {
    const child = new Float32Array(2000).fill(1);
    bigMutate(child, createRng(4));
    const flipped = child.filter((v) => v === -1).length;
    const noised = child.filter((v) => v !== 1 && v !== -1).length;
    expect(flipped / 2000).toBeCloseTo(BIG_MUTATION.rate * BIG_MUTATION.flipChance, 1);
    expect(noised / 2000).toBeCloseTo(BIG_MUTATION.rate * (1 - BIG_MUTATION.flipChance), 1);
  });
});

describe("stagnation boost", () => {
  it("detects equal and near-equal fitness only", () => {
    expect(isStagnant(new Float64Array(10).fill(5))).toBe(true);
    expect(isStagnant(new Float64Array(10).fill(0))).toBe(true);
    expect(isStagnant(Float64Array.from({ length: 10 }, (_, i) => 5 + i * 1e-4))).toBe(true);
    expect(isStagnant(Float64Array.from({ length: 10 }, (_, i) => 5 + i))).toBe(false);
    expect(isStagnant(new Float64Array(1))).toBe(false);
  });

  it("mutates harder after a stagnant generation", () => {
    const { pop } = makePop();
    const ga = { ...base, mutationRate: 1, mutationStd: 0.1, crossover: false };
    const drift = (fitness: Float64Array) => {
      const out = nextGeneration(pop, fitness, ga, createRng(2), fresh);
      let sum = 0; // distance of each child to its nearest parent
      for (let i = 2; i < N; i++) {
        let best = Infinity;
        for (let p = 0; p < N; p++) {
          let d = 0;
          for (let g = 0; g < L; g++) d += (out.genome(i)[g] - pop.data[p * L + g]) ** 2;
          best = Math.min(best, d);
        }
        sum += Math.sqrt(best);
      }
      return sum;
    };
    const ratio = drift(new Float64Array(N).fill(7)) / drift(Float64Array.from({ length: N }, (_, i) => i));
    expect(ratio).toBeGreaterThan(STAGNATION_BOOST * 0.6);
  });
});
