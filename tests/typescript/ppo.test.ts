import { Brain, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { layoutConfig, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { Mlp, Ppo } from "../../src/typescript/src/sim/rl/ppo.ts";
import { testRng } from "./helpers.ts";

describe("Mlp", () => {
  const sizes = [5, 4, 3, 2];
  const rng = testRng(3);
  const params = Float64Array.from(randomGenome(sizes, rng), (w) => w + 0.1 * rng.normal()); // nonzero biases too
  const x = Float64Array.from({ length: 5 }, () => rng.normal());
  const dOut = Float64Array.of(0.7, -1.3);
  const loss = (p: Float64Array): number => {
    const y = new Mlp(sizes).forward(p, x);
    return dOut[0]! * y[0]! + dOut[1]! * y[1]!;
  };

  it("matches the brain's forward pass before the output tanh", () => {
    const net = new Mlp(sizes);
    const y = net.forward(params, x);
    const out = new Float32Array(2);
    new Brain(sizes, Float32Array.from(params)).forward(Float32Array.from(x), out);
    for (let j = 0; j < 2; j++) expect(out[j]).toBeCloseTo(Math.tanh(y[j]!), 3);
  });

  it("backpropagates the finite-difference gradient", () => {
    const net = new Mlp(sizes);
    net.forward(params, x);
    const grad = new Float64Array(params.length);
    net.backward(params, dOut, grad);
    const h = 1e-6;
    for (let i = 0; i < params.length; i++) {
      const p = params.slice();
      p[i] += h;
      const up = loss(p);
      p[i] -= 2 * h;
      expect(grad[i]).toBeCloseTo((up - loss(p)) / (2 * h), 6);
    }
  });
});

describe("Ppo", () => {
  const env = { ...envById("nibble")!, seconds: 3 };
  const learner = randomLearner(env, 1);
  const sizes = layerSizes(layoutConfig(env.world), learner.plan);

  it("leaves the episode unchanged when act keeps the brain's outputs", () => {
    expect(runEpisode(env, learner, 5, null, {}, undefined, () => {})).toEqual(runEpisode(env, learner, 5));
  });

  it("updates the genome and std, the same for the same seed", async () => {
    const run = async () => {
      const ppo = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1 }, 7);
      const step = ppo.step();
      return { theta: Array.from(ppo.theta), step };
    };
    const a = await run();
    expect(a.theta).not.toEqual(Array.from(learner.genome));
    expect(a.theta.every(Number.isFinite)).toBe(true);
    expect(a.step.std.every((s) => s > 0 && Number.isFinite(s))).toBe(true);
    expect(await run()).toEqual(a);
  });
});
