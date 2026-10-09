import { Brain, genomeLength, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { testRng } from "./helpers.ts";

describe("brain", () => {
  test("genomeLength counts weights and biases", () => {
    expect(genomeLength([3, 2, 1])).toBe(11);
  });

  test("all-zero genome gives all-zero outputs", () => {
    const sizes = [3, 4, 2];
    const brain = new Brain(sizes, new Float32Array(genomeLength(sizes)));
    const out = new Float32Array(2);
    brain.forward(new Float32Array([0.5, -1, 0.25]), out);
    expect(Array.from(out)).toEqual([0, 0]);
  });

  test("hand-picked network matches hand computation", () => {
    // Layer 1: 2 inputs -> 1 hidden. w = [0.5, -1], b = 0.25.
    // Layer 2: 1 hidden -> 2 outputs. w = [2, -0.5], b = [0, 0.1].
    const genome = new Float32Array([0.5, -1, 0.25, 2, -0.5, 0, 0.1]);
    const brain = new Brain([2, 1, 2], genome);
    const input = new Float32Array([1, 0.5]);
    const out = new Float32Array(2);
    brain.forward(input, out);

    const h = Math.tanh(0.5 * 1 + -1 * 0.5 + 0.25);
    expect(out[0]).toBeCloseTo(Math.tanh(2 * h), 6);
    expect(out[1]).toBeCloseTo(Math.tanh(-0.5 * h + 0.1), 6);
  });

  test("wrong genome length throws", () => {
    expect(() => new Brain([3, 2, 1], new Float32Array(10))).toThrow();
    expect(() => new Brain([3, 2, 1], new Float32Array(12))).toThrow();
  });

  test("random genomes give outputs within [-1, 1]", () => {
    const rng = testRng(7);
    const sizes = [9, 16, 2];
    const out = new Float32Array(2);
    const input = new Float32Array(9);
    for (let g = 0; g < 20; g++) {
      const brain = new Brain(sizes, randomGenome(sizes, rng));
      for (let t = 0; t < 20; t++) {
        for (let i = 0; i < input.length; i++) input[i] = rng.range(-1, 1);
        brain.forward(input, out);
        for (const v of out) {
          expect(v).toBeGreaterThanOrEqual(-1);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("brain activations", () => {
  test("layerActivations after forward matches input, hidden and output", () => {
    const genome = new Float32Array([0.5, -1, 0.25, 2, -0.5, 0, 0.1]);
    const brain = new Brain([2, 1, 2], genome);
    expect(brain.sizes).toEqual([2, 1, 2]);
    const input = new Float32Array([1, 0.5]);
    const out = new Float32Array(2);
    brain.forward(input, out);
    const acts = brain.layerActivations();
    expect(acts.length).toBe(3);
    expect(acts[0]).toBe(input);
    expect(acts[2]).toBe(out);
    expect(acts[1][0]).toBeCloseTo(Math.tanh(0.25), 6);
    expect(brain.layerActivations()).toBe(acts); // no per-call allocation
  });
});
