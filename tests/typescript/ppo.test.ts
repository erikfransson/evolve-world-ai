import { Brain, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { BLANK_ENV, layoutConfig, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { createNodeRlPool } from "../../src/typescript/src/worker/nodePool.ts";
import { Mlp, PPO_DEFAULTS, Ppo, playRollout } from "../../src/typescript/src/sim/rl/ppo.ts";
import type { RolloutTask } from "../../src/typescript/src/sim/rl/ppo.ts";
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

describe("Mlp pair pass with fewer used outputs than the last layer", () => {
  const sizes = [5, 6, 5, 4];
  const used = 2;
  const rng = testRng(11);
  const params = Float64Array.from(randomGenome(sizes, rng), (w) => w + 0.1 * rng.normal());
  const input = Float64Array.from({ length: 10 }, (_, i) => (i < 5 ? rng.normal() : 0)); // sample b has all inputs zero
  const dA = Float64Array.of(0.7, -1.3, 0, 0);
  const dB = Float64Array.of(-0.4, 0.9, 0, 0);
  const pairLoss = (p: Float64Array): number => {
    const a = new Mlp(sizes, used);
    const b = new Mlp(sizes, used);
    Mlp.forward2(a, b, p, input, 0, 5);
    const ya = a.acts[3]!;
    const yb = b.acts[3]!;
    return dA[0]! * ya[0]! + dA[1]! * ya[1]! + dB[0]! * yb[0]! + dB[1]! * yb[1]!;
  };

  it("forward2 and backward2 equal two single passes", () => {
    const a = new Mlp(sizes, used);
    const b = new Mlp(sizes, used);
    Mlp.forward2(a, b, params, input, 0, 5);
    const sa = new Mlp(sizes, used);
    const sb = new Mlp(sizes, used);
    for (let j = 0; j < used; j++) {
      expect(a.acts[3]![j]).toBeCloseTo(sa.forward(params, input, 0)[j]!, 12);
      expect(b.acts[3]![j]).toBeCloseTo(sb.forward(params, input, 5)[j]!, 12);
    }
    const pair = new Float64Array(params.length);
    Mlp.backward2(a, b, params, dA, dB, pair);
    const single = new Float64Array(params.length);
    sa.backward(params, dA, single);
    sb.backward(params, dB, single);
    for (let i = 0; i < params.length; i++) expect(pair[i]).toBeCloseTo(single[i]!, 12);
  });

  it("backward2 matches the finite-difference gradient", () => {
    const a = new Mlp(sizes, used);
    const b = new Mlp(sizes, used);
    Mlp.forward2(a, b, params, input, 0, 5);
    const grad = new Float64Array(params.length);
    Mlp.backward2(a, b, params, dA, dB, grad);
    const h = 1e-6;
    for (let i = 0; i < params.length; i++) {
      const p = params.slice();
      p[i] += h;
      const up = pairLoss(p);
      p[i] -= 2 * h;
      expect(grad[i]).toBeCloseTo((up - pairLoss(p)) / (2 * h), 5); // not 6: hidden units run fastTanh (error ~1e-4) but backprop uses the exact slope 1 - a^2
    }
  });
});

describe("Ppo policyLoss gradient", () => {
  const env = { ...envById("nibble")!, seconds: 3 };
  const learner = randomLearner(env, 1);
  const sizes = layerSizes(layoutConfig(env.world), learner.plan);
  const clip = PPO_DEFAULTS.clip;
  const z = [0.3, -0.5];
  const u0 = [0.1, -0.2];
  const ls0 = [-0.5, -0.3];
  // Independent copy of the loss -min(r A, clip(r) A) as a function of the net outputs u and log-stds.
  const loss = (u: number[], ls: number[], logp0: number, A: number): number => {
    let lp = 0;
    for (let a = 0; a < 2; a++) lp += -0.5 * ((z[a]! - u[a]!) / Math.exp(ls[a]!)) ** 2 - ls[a]! - 0.5 * Math.log(2 * Math.PI);
    const r = Math.exp(lp - logp0);
    return -Math.min(r * A, Math.min(Math.max(r, 1 - clip), 1 + clip) * A);
  };
  const lpAt = (u: number[], ls: number[]): number => {
    let lp = 0;
    for (let a = 0; a < 2; a++) lp += -0.5 * ((z[a]! - u[a]!) / Math.exp(ls[a]!)) ** 2 - ls[a]! - 0.5 * Math.log(2 * Math.PI);
    return lp;
  };
  // [advantage, log-ratio offset (logp0 = lp - offset)]: inside the clip range, clipped above (A > 0), unclipped below (A > 0), clipped below (A < 0), unclipped above (A < 0)
  it.each([[1.5, 0.05], [1.5, 0.5], [1.5, -0.5], [-1.2, -0.5], [-1.2, 0.5]])("matches central differences for A %f and log-ratio %f", (A, offset) => {
    const ppo = new Ppo([env], learner, sizes, {}, 7, null, null) as unknown as { policyNet: Mlp; logStd: Float64Array; policyLoss(b: unknown, i: number, net: Mlp, dOut: Float64Array, gStd: Float64Array): boolean };
    ppo.logStd.set(ls0);
    const net = ppo.policyNet;
    const last = net.acts[net.sizes.length - 1]!;
    last.set(u0);
    const logp0 = lpAt(u0, ls0) - offset;
    const batch = { z: Float64Array.from(z), logp: Float64Array.of(logp0), adv: Float64Array.of(A) };
    const dOut = new Float64Array(last.length);
    const gStd = new Float64Array(2);
    const hit = ppo.policyLoss(batch, 0, net, dOut, gStd);
    const clipped = (A > 0 && offset > Math.log(1 + clip)) || (A < 0 && offset < Math.log(1 - clip));
    expect(hit).toBe(!clipped);
    const h = 1e-6;
    for (let a = 0; a < 2; a++) {
      const up = u0.slice();
      up[a]! += h;
      const dn = u0.slice();
      dn[a]! -= h;
      expect(dOut[a]).toBeCloseTo((loss(up, ls0, logp0, A) - loss(dn, ls0, logp0, A)) / (2 * h), 6);
      const lu = ls0.slice();
      lu[a]! += h;
      const ld = ls0.slice();
      ld[a]! -= h;
      expect(gStd[a]).toBeCloseTo((loss(u0, lu, logp0, A) - loss(u0, ld, logp0, A)) / (2 * h), 6);
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
      const ppo = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1 }, 7, null, null);
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
    const serial = new Ppo([env], learner, sizes, options, 7, null, null);
    serial.step();
    for (const threads of [1, 2]) {
      const pool = createNodeRlPool({ envs: [env], plan: learner.plan, pool: null, library: {} }, threads);
      const ppo = new Ppo([env], learner, sizes, options, 7, null, null);
      await ppo.stepWith(pool);
      pool.close();
      expect(Array.from(ppo.theta)).toEqual(Array.from(serial.theta));
    }
  });
  it("trains every env when there are more envs than episodes per update", async () => {
    const envs = Array.from({ length: 7 }, () => env);
    const ppo = new Ppo(envs, learner, sizes, { episodes: 3, epochs: 1 }, 7, null, null);
    const played: number[] = [];
    const player = { rollouts: async (tasks: readonly RolloutTask[]) => tasks.map((t) => (played.push(t.env), playRollout(envs[t.env]!, learner.plan, t, null, {}))) };
    for (let k = 0; k < 3; k++) await ppo.stepWith(player);
    expect(played).toEqual([0, 1, 2, 3, 4, 5, 6, 0, 1]);
  });

  it("plays every tick with the held noise the same as a plain policy at repeat 1", () => {
    const a = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, repeat: 1 }, 7, null, null);
    const b = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, repeat: 1, everyTick: true }, 7, null, null);
    expect(b.step()).toEqual(a.step());
    expect(Array.from(b.theta)).toEqual(Array.from(a.theta));
  });

  it("holds only the noise with everyTick at repeat 3, and still learns", () => {
    const a = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1 }, 7, null, null);
    const b = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, everyTick: true }, 7, null, null);
    a.step();
    b.step();
    expect(Array.from(b.theta)).not.toEqual(Array.from(a.theta));
    expect(b.theta.every(Number.isFinite)).toBe(true);
  });

  it("plays the same rollouts as before, with and without everyTick", async () => {
    const hash = async (everyTick: boolean): Promise<number> => {
      let h = 2166136261;
      const ppo = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, everyTick }, 7, null, null);
      await ppo.stepWith({
        rollouts: async (tasks) => tasks.map((t) => {
          const r = playRollout(env, learner.plan, t, null, {});
          for (const a of [Float64Array.from(r.obs), r.z, r.logp, r.adv, r.ret, Float64Array.of(r.reward)]) {
            for (const b of new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) h = Math.imul(h ^ b, 16777619) >>> 0;
          }
          return r;
        }),
      });
      return h;
    };
    expect([await hash(false), await hash(true)]).toEqual([1300386985, 943064064]);
  });

  it("stops the epochs at the target KL before stepping on a far minibatch", () => {
    const one = new Ppo([env], learner, sizes, { episodes: 2, epochs: 1 }, 7, null, null);
    one.step();
    const full = new Ppo([env], learner, sizes, { episodes: 2, epochs: 4 }, 7, null, null);
    full.step();
    expect(full.lastEpochs).toBe(4);
    const capped = new Ppo([env], learner, sizes, { episodes: 2, epochs: 4, targetKl: 1e-12 }, 7, null, null);
    capped.step();
    expect(capped.lastEpochs).toBe(2); // epoch 1 steps at KL 0, epoch 2's first minibatch is past the target
    expect(Array.from(capped.theta)).toEqual(Array.from(one.theta));
  });

  it("switches the hold with setRepeat from the next update", async () => {
    const ppo = new Ppo([env], learner, sizes, { episodes: 1, epochs: 1 }, 7, null, null);
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

  it("averages the diagnostic KL over every minibatch it summed, including the one that stopped the update", () => {
    const ppo = new Ppo([env], learner, sizes, { episodes: 2, epochs: 2, minibatch: 64, lr: 0.1, targetKl: 1e-9, diag: true }, 7, null, null);
    ppo.step();
    const d = ppo.lastDiag!;
    expect(d.klMax).toBeGreaterThan(0);
    expect(d.kl).toBeLessThanOrEqual(d.klMax / 2 + 1e-12); // the first minibatch has KL 0, the second stopped
  });

  it("raises the initial log-std to a floor above it", () => {
    const ppo = new Ppo([env], learner, sizes, { logStd: -2, logStdMin: -1 }, 7, null, null);
    expect(Array.from(ppo.logStd)).toEqual([-1, -1]);
  });

  it("records diagnostics only when asked, and trains the same either way", () => {
    const off = new Ppo([env], learner, sizes, { episodes: 2 }, 7, null, null);
    const on = new Ppo([env], learner, sizes, { episodes: 2, diag: true }, 7, null, null);
    off.step();
    on.step();
    expect(off.lastDiag).toBeNull();
    expect(Array.from(on.theta)).toEqual(Array.from(off.theta));
    const d = on.lastDiag!;
    expect(d.layerNorm).toHaveLength(sizes.length - 1);
    expect(d.gradNorm).toBeGreaterThan(0);
    expect(d.clipActive).toBeGreaterThanOrEqual(0);
    expect(d.clipActive).toBeLessThanOrEqual(1);
    for (const f of d.saturated) expect(f).toBeGreaterThanOrEqual(0);
    expect(d.logStd).toHaveLength(2);
    expect(d.advStd).toBeGreaterThan(0);
  });
});

// With a zero critic, gamma 1 and lambda 0 the advantage of a step is its own reward, so the tests read the per-step rewards.
const stepRewards = (env: Parameters<typeof playRollout>[0], plan: Parameters<typeof playRollout>[1], task: Parameters<typeof playRollout>[2], poisonPenalty: number): Float64Array =>
  playRollout(env, plan, { ...task, critic: new Float32Array(task.critic.length), gamma: 1, lambda: 0, poisonPenalty }, null, {}).adv;

describe("poison penalty", () => {
  it("lowers the return of an episode that eats poison, and nothing else", () => {
    const env = { ...BLANK_ENV, id: "t-poison", size: [200, 200] as [number, number], food: 0, poison: 40, seconds: 10, poisonDamage: 10 }; // the random learner bites poison here
    const learner = randomLearner(env, 1);
    const sizes = layerSizes(layoutConfig(env.world), learner.plan);
    const ppo = new Ppo([env], learner, sizes, {}, 3, null, null);
    ppo.setEnvs([env]);
    const task = (ppo as unknown as { tasks(): Parameters<typeof playRollout>[2][] }).tasks()[0]!;
    const plain = playRollout(env, learner.plan, { ...task, poisonPenalty: 0 }, null, {});
    const pen = playRollout(env, learner.plan, { ...task, poisonPenalty: 2 }, null, {});
    expect(pen.reward).toBe(plain.reward);
    // The penalty is 2 per bite, so the steps lose 2 x bites in total; the learner must really bite for this to hold.
    const lost = stepRewards(env, learner.plan, task, 0).reduce((s, v) => s + v, 0) - stepRewards(env, learner.plan, task, 2).reduce((s, v) => s + v, 0);
    expect(lost).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(Math.abs(lost / 2 - Math.round(lost / 2))).toBeLessThan(1e-9);
    expect(pen.ret[0]!).toBeLessThan(plain.ret[0]! - 0.1);
  });
});

describe("env reward.poison in PPO", () => {
  it("charges each bite on its step and keeps the steps summing to the episode reward", () => {
    const base = { ...BLANK_ENV, id: "t-poison", size: [200, 200] as [number, number], food: 0, poison: 40, seconds: 10, poisonDamage: 10 };
    const env = { ...base, reward: { poison: 2 } };
    const learner = randomLearner(env, 1);
    const sizes = layerSizes(layoutConfig(env.world), learner.plan);
    const ppo = new Ppo([env], learner, sizes, {}, 3, null, null);
    ppo.setEnvs([env]);
    const task = (ppo as unknown as { tasks(): Parameters<typeof playRollout>[2][] }).tasks()[0]!;
    const plainEnv = playRollout(base, learner.plan, task, null, {});
    const costly = playRollout(env, learner.plan, task, null, {});
    expect(plainEnv.reward).toBe(0);
    expect(costly.reward).toBeLessThan(0);
    expect(costly.ret[0]!).toBeLessThan(plainEnv.ret[0]!);
    // Each bite is charged on its own step: negative steps before the last one, in whole bite costs.
    const steps = stepRewards(env, learner.plan, task, 0);
    const early = Array.from(steps.slice(0, -1)).filter((v) => v < 0);
    expect(early.length).toBeGreaterThan(0);
    for (const v of early) expect(Math.abs(v / 2 - Math.round(v / 2))).toBeLessThan(1e-9);
  });
});

describe("poison penalty with env reward.poison", () => {
  it("is not charged on top of the env's own poison cost", () => {
    const env = { ...BLANK_ENV, id: "t-poison", size: [200, 200] as [number, number], food: 0, poison: 40, seconds: 10, poisonDamage: 10, reward: { poison: 2 } };
    const learner = randomLearner(env, 1);
    const sizes = layerSizes(layoutConfig(env.world), learner.plan);
    const ppo = new Ppo([env], learner, sizes, {}, 3, null, null);
    ppo.setEnvs([env]);
    const task = (ppo as unknown as { tasks(): Parameters<typeof playRollout>[2][] }).tasks()[0]!;
    const total = (pen: number): number => stepRewards(env, learner.plan, task, pen).reduce((s, v) => s + v, 0);
    expect(playRollout(env, learner.plan, task, null, {}).reward).toBeLessThan(0); // the learner must bite
    expect(total(5)).toBe(total(0));
  });
});

describe("PPO defaults", () => {
  it("keep exploring and charge poison in training only", () => {
    expect(PPO_DEFAULTS.logStdMin).toBe(-1);
    expect(PPO_DEFAULTS.poisonPenalty).toBe(1);
    expect(PPO_DEFAULTS.logStd).toBe(-0.5);
  });
});
