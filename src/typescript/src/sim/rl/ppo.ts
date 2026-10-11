import { genomeLength, randomGenome } from "../brain.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { Creature } from "../creature.ts";
import { createRng, deriveSeed } from "../rng.ts";
import type { StatefulRng } from "../rng.ts";
import type { PoolEntry } from "../seedPool.ts";
import { OUTPUT_SIZE } from "../sensors.ts";
import type { Rng } from "../types.ts";
import { runEpisode } from "./env.ts";
import type { EnvSpec, Learner, Library } from "./env.ts";
import { HELD_BASE } from "./trainer.ts";

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

  forward(params: Float32Array | Float64Array, input: Float32Array | Float64Array): Float64Array {
    const { sizes, acts, active } = this;
    let n = 0;
    for (let i = 0; i < sizes[0]!; i++) {
      acts[0]![i] = input[i]!;
      if (input[i] !== 0) active[n++] = i;
    }
    this.nActive = n;
    let at = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      const nIn = sizes[l]!;
      const nOut = sizes[l + 1]!;
      const src = acts[l]!;
      const dst = acts[l + 1]!;
      const bias = at + nIn * nOut;
      const count = l + 2 < sizes.length ? nOut : this.used;
      for (let j = 0; j < count; j++) {
        let s = params[bias + j]!;
        const row = at + j * nIn;
        if (l === 0) for (let k = 0; k < n; k++) s += params[row + active[k]!]! * src[active[k]!]!;
        else for (let i = 0; i < nIn; i++) s += params[row + i]! * src[i]!;
        dst[j] = l + 2 < sizes.length ? Math.tanh(s) : s;
      }
      at = bias + nOut;
    }
    return acts[sizes.length - 1]!;
  }

  // Adds d(loss)/d(params) to grad, given d(loss)/d(outputs) of the last forward.
  backward(params: Float32Array | Float64Array, dOut: Float64Array, grad: Float64Array): void {
    const { sizes, acts, deltas, active } = this;
    const L = sizes.length - 1;
    for (let j = 0; j < sizes[L]!; j++) deltas[L]![j] = dOut[j]!;
    let end = grad.length;
    for (let l = L - 1; l >= 0; l--) {
      const nIn = sizes[l]!;
      const nOut = sizes[l + 1]!;
      const bias = end - nOut;
      const at = bias - nIn * nOut;
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
        for (let i = 0; i < nIn; i++) {
          grad[row + i] += dj * src[i]!;
          back[i] += dj * params[row + i]!;
        }
      }
      if (l > 0) for (let i = 0; i < nIn; i++) back[i] *= 1 - src[i]! * src[i]!; // tanh'
      end = at;
    }
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
  obs: Float32Array[]; // brain input, then the time left as a fraction
  z: Float64Array; // sampled pre-tanh actions, ACTIONS per sample
  logp: Float64Array;
  adv: Float64Array;
  ret: Float64Array;
  n: number;
}

export interface PpoStep {
  iter: number;
  train: number; // mean episode reward of the update's stochastic episodes
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
  private readonly policyAdam: Adam;
  private readonly stdAdam: Adam;
  private readonly criticAdam: Adam;
  private readonly rng: StatefulRng;
  private readonly env: EnvSpec;
  private readonly learner: Learner;
  private readonly pool: readonly PoolEntry[] | null;
  private readonly library: Library;

  constructor(env: EnvSpec, learner: Learner, sizes: readonly number[], options: Partial<PpoOptions>, seed: number, pool: readonly PoolEntry[] | null = null, library: Library = {}) {
    this.env = env;
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
    this.policyAdam = new Adam(this.theta.length, this.options.lr);
    this.stdAdam = new Adam(ACTIONS, this.options.lr);
    this.criticAdam = new Adam(this.critic.length, this.options.criticLr);
  }

  async step(): Promise<PpoStep> {
    const { batch, train } = this.collect();
    this.update(batch);
    this.iter++;
    return { iter: this.iter, train, std: Array.from(this.logStd, Math.exp) };
  }

  // Plays the update's episodes with the stochastic policy and turns them into samples with GAE advantages.
  private collect(): { batch: Batch; train: number } {
    const o = this.options;
    const obs: Float32Array[] = [];
    const z: number[] = [];
    const logp: number[] = [];
    const adv: number[] = [];
    const ret: number[] = [];
    const ticks = Math.round(this.env.seconds / DT);
    const learner = { plan: this.learner.plan, genome: this.theta };
    const g = o.gamma ** o.repeat;
    let train = 0;
    for (let e = 0; e < o.episodes; e++) {
      const first = obs.length;
      const rewards: number[] = [];
      let t = 0;
      let eaten = 0;
      let kills = 0;
      const held = new Float64Array(ACTIONS);
      const act = (c: Creature): void => {
        const out = c.outputs;
        if (t % o.repeat === 0) {
          const input = c.brain.layerActivations()[0]!;
          const x = new Float32Array(input.length + 1);
          x.set(input);
          x[input.length] = 1 - t / ticks;
          const u = this.policyNet.forward(this.theta, input);
          let lp = 0;
          for (let a = 0; a < ACTIONS; a++) {
            const eps = this.rng.normal();
            held[a] = u[a]! + Math.exp(this.logStd[a]!) * eps;
            lp += -0.5 * eps * eps - this.logStd[a]! - 0.5 * LOG_2PI;
            z.push(held[a]!);
          }
          obs.push(x);
          logp.push(lp);
          rewards.push(0);
        }
        for (let a = 0; a < ACTIONS; a++) out[a] = Math.tanh(held[a]!);
        t++;
      };
      const w = this.env.reward;
      const result = runEpisode(this.env, learner, this.rng.int(HELD_BASE), this.pool, this.library, (eco) => {
        const me = eco.get(0);
        if (!me) return;
        rewards[rewards.length - 1]! += (w.food ?? 0) * (me.eaten - eaten) + (w.kill ?? 0) * (me.kills - kills) + (w.survive ?? 0) * DT;
        eaten = me.eaten;
        kills = me.kills;
      }, act);
      // The rest of the reward (food on the dying tick, end energy, time left, rams) comes at the end, so the steps sum to the episode's.
      const sum = rewards.reduce((a, b) => a + b, 0);
      rewards[rewards.length - 1]! += result.reward - sum;
      train += result.reward / o.episodes;
      // GAE, the episode ending at its last sample (time is in the critic's input, so the horizon is part of the state).
      const values = obs.slice(first).map((x) => this.criticNet.forward(this.critic, x)[0]!);
      let next = 0;
      let gae = 0;
      const a0 = adv.length;
      for (let k = values.length - 1; k >= 0; k--) {
        gae = rewards[k]! + g * next - values[k]! + g * o.lambda * gae;
        next = values[k]!;
        adv[a0 + k] = gae;
        ret[a0 + k] = gae + values[k]!;
      }
    }
    this.episodesPlayed += o.episodes;
    const n = obs.length;
    const mean = adv.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(adv.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
    return { batch: { obs, z: Float64Array.from(z), logp: Float64Array.from(logp), adv: Float64Array.from(adv, (a) => (a - mean) / sd), ret: Float64Array.from(ret), n }, train };
  }

  private update(b: Batch): void {
    const o = this.options;
    const gPol = new Float64Array(this.theta.length);
    const gStd = new Float64Array(ACTIONS);
    const gCrit = new Float64Array(this.critic.length);
    const dOut = new Float64Array(this.policyNet.sizes[this.policyNet.sizes.length - 1]!);
    const dV = new Float64Array(1);
    const order = Array.from({ length: b.n }, (_, i) => i);
    for (let epoch = 0; epoch < o.epochs; epoch++) {
      shuffle(order, this.rng);
      for (let start = 0; start < b.n; start += o.minibatch) {
        const end = Math.min(b.n, start + o.minibatch);
        gPol.fill(0);
        gStd.fill(0);
        gCrit.fill(0);
        for (let s = start; s < end; s++) {
          const i = order[s]!;
          const x = b.obs[i]!;
          const u = this.policyNet.forward(this.theta, x);
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
          if (dLp !== 0) this.policyNet.backward(this.theta, dOut, gPol);
          dV[0] = this.criticNet.forward(this.critic, x)[0]! - b.ret[i]!;
          this.criticNet.backward(this.critic, dV, gCrit);
        }
        const m = end - start;
        clipNorm(gPol, m);
        clipNorm(gStd, m);
        clipNorm(gCrit, m);
        this.policyAdam.step(this.theta, gPol);
        this.stdAdam.step(this.logStd, gStd);
        this.criticAdam.step(this.critic, gCrit);
        for (let a = 0; a < ACTIONS; a++) this.logStd[a] = Math.min(LOG_STD_RANGE[1], Math.max(LOG_STD_RANGE[0], this.logStd[a]!));
      }
    }
  }
}

// Averages the summed gradient over m samples and caps its norm.
function clipNorm(g: Float64Array, m: number): void {
  let sq = 0;
  for (let i = 0; i < g.length; i++) sq += (g[i]! / m) ** 2;
  const scale = Math.min(1, MAX_GRAD_NORM / (Math.sqrt(sq) + 1e-12)) / m;
  for (let i = 0; i < g.length; i++) g[i] *= scale;
}

function shuffle(a: number[], rng: Rng): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
}
