// T1 probe: PPO with diagnostics. Held-out deterministic (mean action, as the Arena), held-out stochastic (the training policy with
// noise on the same seeds), train mean, critic explained variance against Monte Carlo returns, approx KL and clip fraction per update.
// Run from src/typescript: node ../../docs/rl-notes/probes/ppoProbe.ts --env nibble --from founder:grazer --seconds 60
// --from random:N | pool:N | founder:<id>.  --check runs the act-path checks only.

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { layerSizes } from "../../../src/typescript/src/sim/brain.ts";
import { layoutConfig, poolLearner, randomLearner, runEpisode, scoreLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import type { Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { Mlp, Ppo, playRollout } from "../../../src/typescript/src/sim/rl/ppo.ts";
import type { Rollout, RolloutTask } from "../../../src/typescript/src/sim/rl/ppo.ts";
import { heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { parseFounders } from "../../../src/typescript/src/live/founders.ts";

const { values } = parseArgs({
  options: {
    env: { type: "string", default: "nibble" },
    from: { type: "string", default: "random:1" },
    seconds: { type: "string", default: "60" },
    episodes: { type: "string", default: "16" },
    epochs: { type: "string", default: "2" },
    lr: { type: "string", default: "0.003" },
    criticLr: { type: "string", default: "0.003" },
    logstd: { type: "string", default: "-0.5" },
    entropy: { type: "string", default: "0" },
    repeat: { type: "string", default: "3" },
    eval: { type: "string", default: "32" },
    every: { type: "string", default: "10" },
    seed: { type: "string", default: "1" },
    check: { type: "boolean", default: false },
    desat: { type: "string", default: "1" }, // divides the turn and thrust rows of the output layer (weights and bias) by this
  },
});
const num = (k: keyof typeof values): number => Number(values[k]);
const env = envById(values.env!)!;
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const [kind, arg] = values.from!.split(/:(.*)/);
let learner: Learner;
if (kind === "founder") {
  const f = parseFounders(JSON.parse(readFileSync("public/live-founders.json", "utf8"))).find((x) => x.id === arg)!;
  learner = { plan: f.plan, genome: f.genome };
} else if (kind === "pool") learner = poolLearner(env, pool![Number(arg)]!);
else learner = randomLearner(env, Number(arg));
const sizes = layerSizes(layoutConfig(env.world), learner.plan);
if (num("desat") !== 1) {
  const g = Float32Array.from(learner.genome);
  const nIn = sizes[sizes.length - 2]!, nOut = sizes[sizes.length - 1]!;
  const at = g.length - nIn * nOut - nOut;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < nIn; i++) g[at + j * nIn + i] /= num("desat");
    g[at + nIn * nOut + j] /= num("desat");
  }
  learner = { plan: learner.plan, genome: g };
}
const seeds = heldSeeds(num("eval"));
const ACT = 2;

// Act-path checks: the act path (no-op act) gives the same rewards as the plain path; the policy net's mean matches the brain's outputs;
// how saturated the pre-tanh outputs are.
function checks(): void {
  const net = new Mlp(sizes, ACT);
  let plain = 0, viaAct = 0, maxDiff = 0, n = 0, sat = 0;
  const absU = [0, 0];
  for (const s of seeds) {
    plain += runEpisode(env, learner, s, pool).reward / seeds.length;
    viaAct += runEpisode(env, learner, s, pool, {}, undefined, (c) => {
      const u = net.forward(learner.genome, c.brain.layerActivations()[0]!);
      for (let a = 0; a < ACT; a++) {
        maxDiff = Math.max(maxDiff, Math.abs(Math.tanh(u[a]!) - c.outputs[a]!));
        absU[a] += Math.abs(u[a]!);
        if (Math.abs(u[a]!) > 2) sat++;
      }
      n++;
    }).reward / seeds.length;
  }
  console.log(JSON.stringify({ check: true, env: env.id, from: values.from, sizes, plain, viaAct, maxDiffTanhUvsBrain: maxDiff, meanAbsU: absU.map((x) => x / n), fracAbsUAbove2: sat / (n * ACT) }));
}
if (values.check) {
  checks();
  process.exit(0);
}

const ppo = new Ppo([env], learner, sizes, { episodes: num("episodes"), epochs: num("epochs"), lr: num("lr"), criticLr: num("criticLr"), logStd: num("logstd"), entropy: num("entropy"), repeat: num("repeat") }, num("seed"), pool);
const opts = ppo.options;

// Plays with lambda 1 (MC returns) to read the critic, then rebuilds the GAE(lambda) advantages the trainer would have used.
let diag = { ev: NaN, mcMean: NaN, vMean: NaN };
let last: Rollout[] = [];
async function rollouts(tasks: readonly RolloutTask[]): Promise<Rollout[]> {
  const out: Rollout[] = [];
  let sMc = 0, sMc2 = 0, sErr = 0, sErr2 = 0, sV = 0, cnt = 0;
  for (const t of tasks) {
    const r = playRollout(env, learner.plan, { ...t, lambda: 1 }, pool, {});
    const n = r.logp.length;
    const g = t.gamma ** t.repeat;
    const v = r.ret.map((x, k) => x - r.adv[k]!);
    const rew = r.ret.map((x, k) => x - (k + 1 < n ? g * r.ret[k + 1]! : 0));
    for (let k = 0; k < n; k++) {
      sMc += r.ret[k]!; sMc2 += r.ret[k]! ** 2; sErr += r.adv[k]!; sErr2 += r.adv[k]! ** 2; sV += v[k]!; cnt++;
    }
    const adv = new Float64Array(n), ret = new Float64Array(n);
    let gae = 0, next = 0;
    for (let k = n - 1; k >= 0; k--) {
      gae = rew[k]! + g * next - v[k]! + g * t.lambda * gae;
      next = v[k]!;
      adv[k] = gae;
      ret[k] = gae + v[k]!;
    }
    out.push({ ...r, adv, ret });
  }
  const varMc = sMc2 / cnt - (sMc / cnt) ** 2;
  const varErr = sErr2 / cnt - (sErr / cnt) ** 2;
  diag = { ev: 1 - varErr / varMc, mcMean: sMc / cnt, vMean: sV / cnt };
  last = out;
  return out;
}

// Approx KL (old to new) and clip fraction of the last update, on its own samples.
function klClip(): { kl: number; clip: number } {
  const net = new Mlp(sizes, ACT);
  const stride = sizes[0]! + 1;
  let kl = 0, clip = 0, n = 0;
  for (const r of last) {
    for (let k = 0; k < r.logp.length; k++) {
      const u = net.forward(ppo.theta, r.obs, k * stride);
      let lp = 0;
      for (let a = 0; a < ACT; a++) {
        const eps = (r.z[k * ACT + a]! - u[a]!) / Math.exp(ppo.logStd[a]!);
        lp += -0.5 * eps * eps - ppo.logStd[a]! - 0.5 * Math.log(2 * Math.PI);
      }
      const d = lp - r.logp[k]!;
      kl += Math.exp(d) - 1 - d; // k3 estimator
      if (Math.abs(Math.exp(d) - 1) > opts.clip) clip++;
      n++;
    }
  }
  return { kl: kl / n, clip: clip / n };
}

// The training policy (with its noise) on the held-out seeds, fixed noise seeds.
function heldStoch(): number {
  let s = 0;
  for (const [k, seed] of seeds.entries()) {
    const task: RolloutTask = { env: 0, seed, noiseSeed: 777 + k, theta: ppo.theta, critic: (ppo as unknown as { critic: Float32Array }).critic, logStd: ppo.logStd, repeat: opts.repeat, gamma: opts.gamma, lambda: opts.lambda, criticHidden: opts.criticHidden };
    s += playRollout(env, learner.plan, task, pool, {}).reward / seeds.length;
  }
  return s;
}
const heldDet = (): number => scoreLearner(env, { plan: learner.plan, genome: ppo.theta }, seeds, pool).reward;

const h0 = heldDet();
const hs0 = heldStoch();
console.log(JSON.stringify({ env: env.id, from: values.from, sizes, opts: { ...opts }, seed: num("seed"), heldDet: h0, heldStoch: hs0 }));
let busy = 0;
let trainAvg = 0, trainN = 0;
while (busy < num("seconds") * 1000) {
  const t0 = performance.now();
  const s = await ppo.stepWith({ rollouts });
  busy += performance.now() - t0;
  trainAvg += s.train; trainN++;
  if (s.iter % num("every") === 0) {
    const { kl, clip } = klClip();
    console.log(JSON.stringify({ iter: s.iter, ep: ppo.episodesPlayed, sec: +(busy / 1000).toFixed(1), train: +(trainAvg / trainN).toFixed(3), heldDet: +heldDet().toFixed(3), heldStoch: +heldStoch().toFixed(3), ev: +diag.ev.toFixed(3), mc: +diag.mcMean.toFixed(3), v: +diag.vMean.toFixed(3), kl: +kl.toFixed(4), clip: +clip.toFixed(3), std: s.std.map((x) => +x.toFixed(3)) }));
    trainAvg = 0; trainN = 0;
  }
}
console.log(JSON.stringify({ end: true, iter: ppo.iter, ep: ppo.episodesPlayed, heldDet: heldDet(), heldStoch: heldStoch(), start: h0, rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
