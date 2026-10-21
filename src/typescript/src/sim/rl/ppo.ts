import { fastTanh, genomeLength, layerSizes, randomGenome } from "../brain.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { Creature } from "../creature.ts";
import { createRng, deriveSeed } from "../rng.ts";
import type { StatefulRng } from "../rng.ts";
import type { PoolEntry } from "../seedPool.ts";
import { OUTPUT_SIZE } from "../sensors.ts";
import type { Rng } from "../types.ts";
import { layoutConfig, runEpisode } from "./env.ts";
import type { EnvSpec, Learner, Library } from "./env.ts";
import { HELD_BASE, scoreGenomes } from "./trainer.ts";
import type { RlTrainer, Score, Scorer, StepResult } from "./trainer.ts";

// Backprop RL: PPO (Schulman et al. 2017) on the creature's own brain. The policy samples the pre-tanh turn and thrust of the brain's
// output layer from a Gaussian with a learned, state-free log-std; the mean action (the brain as it is) is what plays held-out and in the
// Ecosystem. Memory units are observed but not trained: their targets come from the same weights, with no backprop through time.
// A separate critic sees the brain input plus the time left, and GAE gives the advantages.

export interface PpoOptions {
  episodes: number; // per update
  epochs: number;
  minibatch: number; // samples
  lr: number; // policy Adam step
  criticLr: number;
  clip: number;
  gamma: number; // per tick
  lambda: number;
  logStd: number; // initial
  entropy: number; // bonus per unit of log-std
  criticHidden: number;
  repeat: number; // ticks one sampled action is held
}

export const PPO_DEFAULTS: PpoOptions = { episodes: 16, epochs: 2, minibatch: 256, lr: 3e-3, criticLr: 3e-3, clip: 0.2, gamma: 0.995, lambda: 0.95, logStd: -0.5, entropy: 0, criticHidden: 32, repeat: 3 };

const ACTIONS = OUTPUT_SIZE; // turn, thrust
const LOG_2PI = Math.log(2 * Math.PI);
const LOG_STD_RANGE = [-3, 1] as const;
const MAX_GRAD_NORM = 0.5;
const DT = DEFAULT_CONFIG.dt; // the env worlds keep the default tick

// An MLP in the brain's genome layout (per layer weights [out][in], then biases), tanh on hidden layers, linear outputs.
// acts[l] holds layer l's values from the last forward (acts[0] the input, the last the pre-activation outputs).
export class Mlp {
  readonly sizes: readonly number[];
  readonly acts: Float64Array[];
  private readonly deltas: Float64Array[];
  private readonly active: Int32Array; // nonzero inputs of the last forward (mostly one-hot ray flags), the first layer skips the rest
  private nActive = 0;
  private readonly used: number; // outputs computed; the policy needs only turn and thrust, not the memory targets

  constructor(sizes: readonly number[], used = sizes[sizes.length - 1]!) {
    this.sizes = sizes.slice();
    this.used = used;
    this.acts = sizes.map((n) => new Float64Array(n));
    this.deltas = sizes.map((n) => new Float64Array(n));
    this.active = new Int32Array(sizes[0]!);
  }

  // The input is read from input[offset ...], so samples can sit side by side in one array.
  forward(params: Float32Array | Float64Array, input: Float32Array | Float64Array, offset = 0): Float64Array {
    this.load(input, offset);
    let at = 0;
    for (let l = 0; l + 1 < this.sizes.length; l++) at = this.layer(l, at, params);
    return this.acts[this.sizes.length - 1]!;
  }

  // Forward of two samples through the same params: the dense layers read each weight once for both. Each Mlp ends as after its own forward.
  static forward2(a: Mlp, b: Mlp, params: Float32Array | Float64Array, input: Float32Array | Float64Array, offA: number, offB: number): void {
    a.load(input, offA);
    b.load(input, offB);
    const sizes = a.sizes;
    let at = a.layer(0, 0, params);
    b.layer(0, 0, params);
    for (let l = 1; l + 1 < sizes.length; l++) {
      const nIn = sizes[l]!;
      const nOut = sizes[l + 1]!;
      const sa = a.acts[l]!;
      const sb = b.acts[l]!;
      const da = a.acts[l + 1]!;
      const db = b.acts[l + 1]!;
      const bias = at + nIn * nOut;
      const hidden = l + 2 < sizes.length;
      const count = hidden ? nOut : a.used;
      let j = 0;
      for (; j + 2 <= count; j += 2) {
        let a0 = params[bias + j]!;
        let a1 = params[bias + j + 1]!;
        let b0 = a0;
        let b1 = a1;
        const r0 = at + j * nIn;
        const r1 = r0 + nIn;
        for (let i = 0; i < nIn; i++) {
          const p0 = params[r0 + i]!;
          const p1 = params[r1 + i]!;
          const x = sa[i]!;
          const y = sb[i]!;
          a0 += p0 * x;
          a1 += p1 * x;
          b0 += p0 * y;
          b1 += p1 * y;
        }
        if (hidden) {
          da[j] = fastTanh(a0);
          da[j + 1] = fastTanh(a1);
          db[j] = fastTanh(b0);
          db[j + 1] = fastTanh(b1);
        } else {
          da[j] = a0;
          da[j + 1] = a1;
          db[j] = b0;
          db[j + 1] = b1;
        }
      }
      for (; j < count; j++) {
        let x = params[bias + j]!;
        let y = x;
        const row = at + j * nIn;
        for (let i = 0; i < nIn; i++) {
          const p = params[row + i]!;
          x += p * sa[i]!;
          y += p * sb[i]!;
        }
        da[j] = hidden ? fastTanh(x) : x;
        db[j] = hidden ? fastTanh(y) : y;
      }
      at = bias + nOut;
    }
  }

  private load(input: Float32Array | Float64Array, offset: number): void {
    const { sizes, acts, active } = this;
    let n = 0;
    for (let i = 0; i < sizes[0]!; i++) {
      const v = input[offset + i]!;
      acts[0]![i] = v;
      if (v !== 0) active[n++] = i;
    }
    this.nActive = n;
  }

  // Layer l of the forward, the weights starting at `at`; returns where the next layer's start.
  private layer(l: number, at: number, params: Float32Array | Float64Array): number {
    const { sizes, acts, active } = this;
    const n = this.nActive;
    const nIn = sizes[l]!;
    const nOut = sizes[l + 1]!;
    const src = acts[l]!;
    const dst = acts[l + 1]!;
    const bias = at + nIn * nOut;
    const hidden = l + 2 < sizes.length;
    const count = hidden ? nOut : this.used;
    // Four outputs at a time keep the running sums in registers; each sum still adds in input order, so results are unchanged.
    let j = 0;
    for (; j + 4 <= count; j += 4) {
      let s0 = params[bias + j]!;
      let s1 = params[bias + j + 1]!;
      let s2 = params[bias + j + 2]!;
      let s3 = params[bias + j + 3]!;
      const r0 = at + j * nIn;
      const r1 = r0 + nIn;
      const r2 = r1 + nIn;
      const r3 = r2 + nIn;
      if (l === 0) {
        for (let k = 0; k < n; k++) {
          const i = active[k]!;
          const v = src[i]!;
          s0 += params[r0 + i]! * v;
          s1 += params[r1 + i]! * v;
          s2 += params[r2 + i]! * v;
          s3 += params[r3 + i]! * v;
        }
      } else {
        for (let i = 0; i < nIn; i++) {
          const v = src[i]!;
          s0 += params[r0 + i]! * v;
          s1 += params[r1 + i]! * v;
          s2 += params[r2 + i]! * v;
          s3 += params[r3 + i]! * v;
        }
      }
      if (hidden) {
        dst[j] = fastTanh(s0);
        dst[j + 1] = fastTanh(s1);
        dst[j + 2] = fastTanh(s2);
        dst[j + 3] = fastTanh(s3);
      } else {
        dst[j] = s0;
        dst[j + 1] = s1;
        dst[j + 2] = s2;
        dst[j + 3] = s3;
      }
    }
    for (; j < count; j++) {
      let s = params[bias + j]!;
      const row = at + j * nIn;
      if (l === 0) for (let k = 0; k < n; k++) s += params[row + active[k]!]! * src[active[k]!]!;
      else for (let i = 0; i < nIn; i++) s += params[row + i]! * src[i]!;
      dst[j] = hidden ? fastTanh(s) : s;
    }
    return bias + nOut;
  }

  // Adds d(loss)/d(params) to grad, given d(loss)/d(outputs) of the last forward.
  backward(params: Float32Array | Float64Array, dOut: Float64Array, grad: Float64Array): void {
    const { sizes, deltas } = this;
    const L = sizes.length - 1;
    for (let j = 0; j < sizes[L]!; j++) deltas[L]![j] = dOut[j]!;
    let end = grad.length;
    for (let l = L - 1; l >= 0; l--) {
      const bias = end - sizes[l + 1]!;
      end = bias - sizes[l]! * sizes[l + 1]!;
      this.backLayer(l, end, bias, params, grad);
    }
  }

  // Backward of two samples (a's gradient first, then b's, so every grad entry adds in the order of two separate backwards).
  static backward2(a: Mlp, b: Mlp, params: Float32Array | Float64Array, dOutA: Float64Array, dOutB: Float64Array, grad: Float64Array): void {
    const sizes = a.sizes;
    const L = sizes.length - 1;
    for (let j = 0; j < sizes[L]!; j++) {
      a.deltas[L]![j] = dOutA[j]!;
      b.deltas[L]![j] = dOutB[j]!;
    }
    let end = grad.length;
    for (let l = L - 1; l >= 0; l--) {
      const nIn = sizes[l]!;
      const nOut = sizes[l + 1]!;
      const bias = end - nOut;
      const at = bias - nIn * nOut;
      end = at;
      if (l === 0) {
        a.backLayer(0, at, bias, params, grad);
        b.backLayer(0, at, bias, params, grad);
        continue;
      }
      const da = a.deltas[l + 1]!;
      const db = b.deltas[l + 1]!;
      const sa = a.acts[l]!;
      const sb = b.acts[l]!;
      const ba = a.deltas[l]!;
      const bb = b.deltas[l]!;
      ba.fill(0);
      bb.fill(0);
      // Two rows of weights at a time. A zero delta adds +-0, which changes no sum that starts at +0, so no row is skipped.
      let j = 0;
      for (; j + 4 <= nOut; j += 4) {
        const a0 = da[j]!;
        const a1 = da[j + 1]!;
        const a2 = da[j + 2]!;
        const a3 = da[j + 3]!;
        const b0 = db[j]!;
        const b1 = db[j + 1]!;
        const b2 = db[j + 2]!;
        const b3 = db[j + 3]!;
        grad[bias + j] += a0;
        grad[bias + j] += b0;
        grad[bias + j + 1] += a1;
        grad[bias + j + 1] += b1;
        grad[bias + j + 2] += a2;
        grad[bias + j + 2] += b2;
        grad[bias + j + 3] += a3;
        grad[bias + j + 3] += b3;
        const r0 = at + j * nIn;
        const r1 = r0 + nIn;
        const r2 = r1 + nIn;
        const r3 = r2 + nIn;
        for (let i = 0; i < nIn; i++) {
          const x = sa[i]!;
          const y = sb[i]!;
          const p0 = params[r0 + i]!;
          const p1 = params[r1 + i]!;
          const p2 = params[r2 + i]!;
          const p3 = params[r3 + i]!;
          grad[r0 + i] = grad[r0 + i]! + a0 * x + b0 * y;
          grad[r1 + i] = grad[r1 + i]! + a1 * x + b1 * y;
          grad[r2 + i] = grad[r2 + i]! + a2 * x + b2 * y;
          grad[r3 + i] = grad[r3 + i]! + a3 * x + b3 * y;
          ba[i] = ba[i]! + a0 * p0 + a1 * p1 + a2 * p2 + a3 * p3;
          bb[i] = bb[i]! + b0 * p0 + b1 * p1 + b2 * p2 + b3 * p3;
        }
      }
      for (; j + 2 <= nOut; j += 2) {
        const a0 = da[j]!;
        const a1 = da[j + 1]!;
        const b0 = db[j]!;
        const b1 = db[j + 1]!;
        grad[bias + j] += a0;
        grad[bias + j] += b0;
        grad[bias + j + 1] += a1;
        grad[bias + j + 1] += b1;
        const r0 = at + j * nIn;
        const r1 = r0 + nIn;
        for (let i = 0; i < nIn; i++) {
          const x = sa[i]!;
          const y = sb[i]!;
          const p0 = params[r0 + i]!;
          const p1 = params[r1 + i]!;
          grad[r0 + i] = grad[r0 + i]! + a0 * x + b0 * y;
          grad[r1 + i] = grad[r1 + i]! + a1 * x + b1 * y;
          ba[i] = ba[i]! + a0 * p0 + a1 * p1;
          bb[i] = bb[i]! + b0 * p0 + b1 * p1;
        }
      }
      for (; j < nOut; j++) {
        const a0 = da[j]!;
        const b0 = db[j]!;
        grad[bias + j] += a0;
        grad[bias + j] += b0;
        const r0 = at + j * nIn;
        for (let i = 0; i < nIn; i++) {
          const p0 = params[r0 + i]!;
          grad[r0 + i] = grad[r0 + i]! + a0 * sa[i]! + b0 * sb[i]!;
          ba[i] = ba[i]! + a0 * p0;
          bb[i] = bb[i]! + b0 * p0;
        }
      }
      for (let i = 0; i < nIn; i++) {
        ba[i] *= 1 - sa[i]! * sa[i]!; // tanh'
        bb[i] *= 1 - sb[i]! * sb[i]!;
      }
    }
  }

  // Layer l of the backward: its weights start at `at`, its biases at `bias`; fills deltas[l] for the layer below.
  private backLayer(l: number, at: number, bias: number, params: Float32Array | Float64Array, grad: Float64Array): void {
    const { sizes, acts, deltas, active } = this;
    const nIn = sizes[l]!;
    const nOut = sizes[l + 1]!;
    const d = deltas[l + 1]!;
    const src = acts[l]!;
    const back = deltas[l]!;
    if (l > 0) back.fill(0);
    for (let j = 0; j < nOut; j++) {
      const dj = d[j]!;
      if (dj === 0) continue;
      grad[bias + j] += dj;
      const row = at + j * nIn;
      if (l === 0) {
        for (let k = 0; k < this.nActive; k++) grad[row + active[k]!] += dj * src[active[k]!]!;
        continue;
      }
      // Two rows at a time halve the passes over back; each back[i] still adds in row order.
      const dn = j + 1 < nOut ? d[j + 1]! : 0;
      if (dn !== 0) {
        grad[bias + j + 1] += dn;
        const row2 = row + nIn;
        for (let i = 0; i < nIn; i++) {
          const v = src[i]!;
          grad[row + i] += dj * v;
          grad[row2 + i] += dn * v;
          back[i] = back[i]! + dj * params[row + i]! + dn * params[row2 + i]!;
        }
        j++;
        continue;
      }
      for (let i = 0; i < nIn; i++) {
        grad[row + i] += dj * src[i]!;
        back[i] += dj * params[row + i]!;
      }
    }
    if (l > 0) for (let i = 0; i < nIn; i++) back[i] *= 1 - src[i]! * src[i]!; // tanh'
  }
}

export class Adam {
  private readonly m: Float64Array;
  private readonly v: Float64Array;
  private t = 0;
  private readonly lr: number;

  constructor(n: number, lr: number) {
    this.lr = lr;
    this.m = new Float64Array(n);
    this.v = new Float64Array(n);
  }

  // Descends along grad.
  step(params: Float32Array | Float64Array, grad: Float64Array): void {
    this.t++;
    const b1 = 1 - 0.9 ** this.t;
    const b2 = 1 - 0.999 ** this.t;
    for (let i = 0; i < params.length; i++) {
      this.m[i] = 0.9 * this.m[i]! + 0.1 * grad[i]!;
      this.v[i] = 0.999 * this.v[i]! + 0.001 * grad[i]! * grad[i]!;
      params[i] -= (this.lr * this.m[i]! / b1) / (Math.sqrt(this.v[i]! / b2) + 1e-8);
    }
  }
}

// One update's samples: a decision every `repeat` ticks.
interface Batch {
  obs: Float32Array; // n samples of `stride` values: the brain input, then the time left as a fraction
  stride: number;
  z: Float64Array; // sampled pre-tanh actions, ACTIONS per sample
  logp: Float64Array;
  adv: Float64Array;
  ret: Float64Array;
  n: number;
}

// One stochastic episode to play: everything it needs is in the task, so it runs on any thread and gives the same samples.
export interface RolloutTask {
  env: number; // index into the run's envs
  seed: number; // the episode's world
  noiseSeed: number; // the policy's exploration noise
  theta: Float32Array;
  critic: Float32Array;
  logStd: Float64Array;
  repeat: number;
  gamma: number;
  lambda: number;
  criticHidden: number;
}

// The episode's samples (n = logp.length) with GAE advantages, not yet normalised, and the episode reward.
export interface Rollout {
  obs: Float32Array;
  z: Float64Array;
  logp: Float64Array;
  adv: Float64Array;
  ret: Float64Array;
  reward: number;
}

// Plays one episode with the stochastic policy and turns it into samples with GAE advantages.
export function playRollout(env: EnvSpec, plan: Learner["plan"], task: RolloutTask, pool: readonly PoolEntry[] | null, library: Library): Rollout {
  const { theta, critic, logStd, repeat } = task;
  const sizes = layerSizes(layoutConfig(env.world), plan);
  const d = sizes[0]!;
  const stride = d + 1;
  const policyNet = new Mlp(sizes, ACTIONS);
  const criticNet = new Mlp([stride, task.criticHidden, 1]);
  const rng = createRng(task.noiseSeed);
  const ticks = Math.round(env.seconds / DT);
  const cap = Math.ceil(ticks / repeat);
  const obs = new Float32Array(cap * stride);
  const z = new Float64Array(cap * ACTIONS);
  const logp = new Float64Array(cap);
  const rewards = new Float64Array(cap);
  const held = new Float64Array(ACTIONS);
  const std = Float64Array.from(logStd, Math.exp);
  let n = 0;
  let t = 0;
  let eaten = 0;
  let kills = 0;
  const act = (c: Creature): void => {
    const out = c.outputs;
    if (t % repeat === 0) {
      const input = c.brain.layerActivations()[0]!;
      const at = n * stride;
      obs.set(input, at);
      obs[at + d] = 1 - t / ticks;
      const u = policyNet.forward(theta, input);
      let lp = 0;
      for (let a = 0; a < ACTIONS; a++) {
        const eps = rng.normal();
        held[a] = u[a]! + std[a]! * eps;
        lp += -0.5 * eps * eps - logStd[a]! - 0.5 * LOG_2PI;
        z[n * ACTIONS + a] = held[a]!;
      }
      logp[n++] = lp;
    }
    for (let a = 0; a < ACTIONS; a++) out[a] = Math.tanh(held[a]!);
    t++;
  };
  const w = env.reward;
  const result = runEpisode(env, { plan, genome: theta }, task.seed, pool, library, (eco) => {
    const me = eco.get(0);
    if (!me) return;
    rewards[n - 1]! += ((w.food ?? 0) + (w.early ?? 0) * (1 - t / ticks)) * (me.eaten - eaten) + (w.kill ?? 0) * (me.kills - kills) + (w.survive ?? 0) * DT;
    eaten = me.eaten;
    kills = me.kills;
  }, act);
  // The rest of the reward (food on the dying tick, end energy, time left, rams) comes at the end, so the steps sum to the episode's.
  let sum = 0;
  for (let k = 0; k < n; k++) sum += rewards[k]!;
  rewards[n - 1]! += result.reward - sum;
  // GAE, the episode ending at its last sample (time is in the critic's input, so the horizon is part of the state).
  const values = new Float64Array(n);
  for (let k = 0; k < n; k++) values[k] = criticNet.forward(critic, obs, k * stride)[0]!;
  const g = task.gamma ** repeat;
  const adv = new Float64Array(n);
  const ret = new Float64Array(n);
  let next = 0;
  let gae = 0;
  for (let k = n - 1; k >= 0; k--) {
    gae = rewards[k]! + g * next - values[k]! + g * task.lambda * gae;
    next = values[k]!;
    adv[k] = gae;
    ret[k] = gae + values[k]!;
  }
  // Exact-size copies, so a helper hands over buffers with no slack.
  return { obs: obs.slice(0, n * stride), z: z.slice(0, n * ACTIONS), logp: logp.slice(0, n), adv, ret, reward: result.reward };
}

export interface PpoStep {
  iter: number;
  train: number; // mean episode reward of the update's stochastic episodes
  best: number; // the best of those episodes
  std: number[]; // policy std per action
}

export class Ppo {
  readonly theta: Float32Array; // the brain's genome
  readonly logStd: Float64Array;
  readonly options: PpoOptions;
  iter = 0;
  episodesPlayed = 0;
  private readonly critic: Float32Array; // Float32 like the genome, so the Mlp loops see one array type
  private readonly policyNet: Mlp;
  private readonly criticNet: Mlp;
  private readonly policyNet2: Mlp; // second nets for the pairs of samples
  private readonly criticNet2: Mlp;
  private readonly policyAdam: Adam;
  private readonly stdAdam: Adam;
  private readonly criticAdam: Adam;
  private readonly rng: StatefulRng;
  private envs: readonly EnvSpec[];
  private readonly learner: Learner;
  private readonly pool: readonly PoolEntry[] | null;
  private readonly library: Library;

  // Episode k of an update plays envs[k % envs.length].
  constructor(envs: readonly EnvSpec[], learner: Learner, sizes: readonly number[], options: Partial<PpoOptions>, seed: number, pool: readonly PoolEntry[] | null = null, library: Library = {}) {
    this.envs = envs;
    this.learner = learner;
    this.pool = pool;
    this.library = library;
    this.options = { ...PPO_DEFAULTS, ...options };
    this.theta = Float32Array.from(learner.genome);
    if (this.theta.length !== genomeLength(sizes)) throw new Error("genome does not fit the brain sizes");
    this.logStd = new Float64Array(ACTIONS).fill(this.options.logStd);
    this.rng = createRng(deriveSeed(seed, 0x9905));
    const criticSizes = [sizes[0]! + 1, this.options.criticHidden, 1];
    this.critic = randomGenome(criticSizes, this.rng);
    this.policyNet = new Mlp(sizes, ACTIONS);
    this.criticNet = new Mlp(criticSizes);
    this.policyNet2 = new Mlp(sizes, ACTIONS);
    this.criticNet2 = new Mlp(criticSizes);
    this.policyAdam = new Adam(this.theta.length, this.options.lr);
    this.stdAdam = new Adam(ACTIONS, this.options.lr);
    this.criticAdam = new Adam(this.critic.length, this.options.criticLr);
  }

  // Trains on other envs from the next update on (of the same world); the weights carry on.
  setEnvs(envs: readonly EnvSpec[]): void {
    this.envs = envs;
  }

  // One update with the episodes played on this thread.
  step(): PpoStep {
    return this.finish(this.tasks().map((task) => this.play(task)));
  }

  // One update with the episodes played by the scorer's helpers when it has any (the results do not depend on how many).
  async stepWith(player: Pick<Scorer, "rollouts">): Promise<PpoStep> {
    const tasks = this.tasks();
    return this.finish(player.rollouts ? await player.rollouts(tasks) : tasks.map((task) => this.play(task)));
  }

  private play(task: RolloutTask): Rollout {
    return playRollout(this.envs[task.env]!, this.learner.plan, task, this.pool, this.library);
  }

  private tasks(): RolloutTask[] {
    const o = this.options;
    return Array.from({ length: o.episodes }, (_, e) => ({
      env: e % this.envs.length,
      seed: this.rng.int(HELD_BASE),
      noiseSeed: this.rng.int(HELD_BASE),
      theta: this.theta,
      critic: this.critic,
      logStd: this.logStd,
      repeat: o.repeat,
      gamma: o.gamma,
      lambda: o.lambda,
      criticHidden: o.criticHidden,
    }));
  }

  // Joins the episodes into one batch with normalised advantages, then updates.
  private finish(rollouts: readonly Rollout[]): PpoStep {
    let train = 0;
    let best = -Infinity;
    let n = 0;
    for (const r of rollouts) {
      train += r.reward / rollouts.length;
      best = Math.max(best, r.reward);
      n += r.logp.length;
    }
    const stride = this.policyNet.sizes[0]! + 1;
    const batch: Batch = { obs: new Float32Array(n * stride), stride, z: new Float64Array(n * ACTIONS), logp: new Float64Array(n), adv: new Float64Array(n), ret: new Float64Array(n), n };
    let at = 0;
    for (const r of rollouts) {
      batch.obs.set(r.obs, at * stride);
      batch.z.set(r.z, at * ACTIONS);
      batch.logp.set(r.logp, at);
      batch.adv.set(r.adv, at);
      batch.ret.set(r.ret, at);
      at += r.logp.length;
    }
    this.episodesPlayed += rollouts.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += batch.adv[i]!;
    mean /= n;
    let sq = 0;
    for (let i = 0; i < n; i++) sq += (batch.adv[i]! - mean) ** 2;
    const sd = Math.sqrt(sq / n) || 1;
    for (let i = 0; i < n; i++) batch.adv[i] = (batch.adv[i]! - mean) / sd;
    this.update(batch);
    this.iter++;
    return { iter: this.iter, train, best, std: Array.from(this.logStd, Math.exp) };
  }

  // Policy loss of sample i after a forward of `net`: writes d(loss)/d(outputs) to dOut, adds the std gradient; false when the sample is clipped (no gradient).
  private policyLoss(b: Batch, i: number, net: Mlp, dOut: Float64Array, gStd: Float64Array): boolean {
    const o = this.options;
    const u = net.acts[net.sizes.length - 1]!;
    let lp = 0;
    for (let a = 0; a < ACTIONS; a++) {
      const eps = (b.z[i * ACTIONS + a]! - u[a]!) / Math.exp(this.logStd[a]!);
      lp += -0.5 * eps * eps - this.logStd[a]! - 0.5 * LOG_2PI;
    }
    const ratio = Math.exp(lp - b.logp[i]!);
    const A = b.adv[i]!;
    const clipped = (A > 0 && ratio > 1 + o.clip) || (A < 0 && ratio < 1 - o.clip);
    const dLp = clipped ? 0 : -ratio * A; // d(loss)/d(log prob), loss = -min(r A, clip(r) A)
    dOut.fill(0);
    for (let a = 0; a < ACTIONS; a++) {
      const sd = Math.exp(this.logStd[a]!);
      const eps = (b.z[i * ACTIONS + a]! - u[a]!) / sd;
      dOut[a] = (dLp * eps) / sd;
      gStd[a] += dLp * (eps * eps - 1) - o.entropy;
    }
    return dLp !== 0;
  }

  private update(b: Batch): void {
    const o = this.options;
    const gPol = new Float64Array(this.theta.length);
    const gStd = new Float64Array(ACTIONS);
    const gCrit = new Float64Array(this.critic.length);
    const dOut = new Float64Array(this.policyNet.sizes[this.policyNet.sizes.length - 1]!);
    const dOut2 = new Float64Array(dOut.length);
    const dV = new Float64Array(1);
    const dV2 = new Float64Array(1);
    const order = Array.from({ length: b.n }, (_, i) => i);
    for (let epoch = 0; epoch < o.epochs; epoch++) {
      shuffle(order, this.rng);
      for (let start = 0; start < b.n; start += o.minibatch) {
        const end = Math.min(b.n, start + o.minibatch);
        gPol.fill(0);
        gStd.fill(0);
        gCrit.fill(0);
        // Samples go through the nets in pairs; the gradient still adds in sample order.
        for (let s = start; s < end; s += 2) {
          const pair = s + 1 < end;
          const i0 = order[s]!;
          const i1 = pair ? order[s + 1]! : i0;
          if (pair) Mlp.forward2(this.policyNet, this.policyNet2, this.theta, b.obs, i0 * b.stride, i1 * b.stride);
          else this.policyNet.forward(this.theta, b.obs, i0 * b.stride);
          const hit0 = this.policyLoss(b, i0, this.policyNet, dOut, gStd);
          const hit1 = pair && this.policyLoss(b, i1, this.policyNet2, dOut2, gStd);
          if (hit0 && hit1) Mlp.backward2(this.policyNet, this.policyNet2, this.theta, dOut, dOut2, gPol);
          else if (hit0) this.policyNet.backward(this.theta, dOut, gPol);
          else if (hit1) this.policyNet2.backward(this.theta, dOut2, gPol);
          if (pair) {
            Mlp.forward2(this.criticNet, this.criticNet2, this.critic, b.obs, i0 * b.stride, i1 * b.stride);
            dV[0] = this.criticNet.acts[2]![0]! - b.ret[i0]!;
            dV2[0] = this.criticNet2.acts[2]![0]! - b.ret[i1]!;
            Mlp.backward2(this.criticNet, this.criticNet2, this.critic, dV, dV2, gCrit);
          } else {
            dV[0] = this.criticNet.forward(this.critic, b.obs, i0 * b.stride)[0]! - b.ret[i0]!;
            this.criticNet.backward(this.critic, dV, gCrit);
          }
        }
        const m = end - start;
        // A non-finite gradient (a numeric blow-up) would poison the weights for good through Adam, so that minibatch is skipped.
        if (!clipNorm(gPol, m) || !clipNorm(gStd, m) || !clipNorm(gCrit, m)) continue;
        this.policyAdam.step(this.theta, gPol);
        this.stdAdam.step(this.logStd, gStd);
        this.criticAdam.step(this.critic, gCrit);
        for (let a = 0; a < ACTIONS; a++) this.logStd[a] = Math.min(LOG_STD_RANGE[1], Math.max(LOG_STD_RANGE[0], this.logStd[a]!));
      }
    }
  }
}

// PPO behind the Trainer interface, for the Arena: updates run on this thread, the episodes and held-out checks on the scorer's helpers.
// A step is one update; its "best" is the update's best episode and its genome the current policy.
export class BackpropTrainer implements RlTrainer {
  readonly ppo: Ppo;
  private scorer: Scorer;
  private envs: number;

  constructor(learner: Learner, envs: readonly EnvSpec[], options: Partial<PpoOptions>, scorer: Scorer, seed: number, pool: readonly PoolEntry[] | null = null, library: Library = {}) {
    this.ppo = new Ppo(envs, learner, layerSizes(layoutConfig(envs[0]!.world), learner.plan), options, seed, pool, library);
    this.scorer = scorer;
    this.envs = envs.length;
  }

  get iter(): number {
    return this.ppo.iter;
  }

  get theta(): Float32Array {
    return this.ppo.theta;
  }

  setEnvs(scorer: Scorer, envs: readonly EnvSpec[]): void {
    this.scorer = scorer;
    this.envs = envs.length;
    this.ppo.setEnvs(envs);
  }

  async step(): Promise<StepResult> {
    const s = await this.ppo.stepWith(this.scorer);
    return { iter: s.iter, train: s.train, best: s.best, bestGenome: Float32Array.from(this.ppo.theta) };
  }

  // Self-play rivals are the current policy, as in the updates' episodes (a mirror of the learner).
  async held(seeds: readonly number[]): Promise<Score> {
    this.scorer.setLeague?.([this.ppo.theta]);
    return (await scoreGenomes(this.scorer, this.envs, [this.ppo.theta], seeds))[0]!;
  }
}

// Averages the summed gradient over m samples and caps its norm; false when it is not finite.
function clipNorm(g: Float64Array, m: number): boolean {
  let sq = 0;
  for (let i = 0; i < g.length; i++) sq += (g[i]! / m) ** 2;
  if (!Number.isFinite(sq)) return false;
  const scale = Math.min(1, MAX_GRAD_NORM / (Math.sqrt(sq) + 1e-12)) / m;
  for (let i = 0; i < g.length; i++) g[i] *= scale;
  return true;
}

function shuffle(a: number[], rng: Rng): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
}
