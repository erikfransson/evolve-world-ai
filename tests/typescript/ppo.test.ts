import { Brain, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { layoutConfig, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { createNodeRlPool } from "../../src/typescript/src/worker/nodePool.ts";
import { Mlp, Ppo, playRollout } from "../../src/typescript/src/sim/rl/ppo.ts";
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

  it("gives the same update whether the episodes play on this thread, one helper or several", async () => {
    const options = { episodes: 3, epochs: 1 };
    const serial = new Ppo([env], learner, sizes, options, 7);
    serial.step();
    for (const threads of [1, 2]) {
      const pool = createNodeRlPool({ envs: [env], plan: learner.plan, pool: null, library: {} }, threads);
      const ppo = new Ppo([env], learner, sizes, options, 7);
      await ppo.stepWith(pool);
      pool.close();
      expect(Array.from(ppo.theta)).toEqual(Array.from(serial.theta));
    }
  });
  it("plays every tick with the held noise the same as a plain policy at repeat 1", () => {
    const a = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, repeat: 1 }, 7);
    const b = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, repeat: 1, everyTick: true }, 7);
    expect(b.step()).toEqual(a.step());
    expect(Array.from(b.theta)).toEqual(Array.from(a.theta));
  });

  it("holds only the noise with everyTick at repeat 3, and still learns", () => {
    const a = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1 }, 7);
    const b = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, everyTick: true }, 7);
    a.step();
    b.step();
    expect(Array.from(b.theta)).not.toEqual(Array.from(a.theta));
    expect(b.theta.every(Number.isFinite)).toBe(true);
  });

  it("stops the epochs at the target KL before stepping on a far minibatch", () => {
    const one = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1 }, 7);
    one.step();
    const full = new Ppo([env], learner, sizes, { episodes: 2, epochs: 4 }, 7);
    full.step();
    expect(full.lastEpochs).toBe(4);
    const capped = new Ppo([env], learner, sizes, { episodes: 2, epochs: 4, targetKl: 1e-12 }, 7);
    capped.step();
    expect(capped.lastEpochs).toBe(2); // epoch 1 steps at KL 0, epoch 2's first minibatch is past the target
    expect(Array.from(capped.theta)).toEqual(Array.from(one.theta));
  });

  it("switches the hold with setRepeat from the next update", async () => {
    const ppo = new Ppo([env], learner, sizes, { episodes: 1, epochs: 1 }, 7);
    expect(() => ppo.setRepeat(0)).toThrow();
    ppo.setRepeat(1);
    let samples = 0;
    await ppo.stepWith({
      rollouts: async (tasks) => tasks.map((t) => {
        const r = playRollout(env, learner.plan, t, null, {});
        samples += r.logp.length;
        return r;
      }),
    });
    expect(samples).toBeGreaterThan(env.seconds * 10); // more than repeat 3 could give
  });
});
