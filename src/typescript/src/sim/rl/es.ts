import type { Rng } from "../types.ts";

// Evolution strategies (Salimans et al. 2017): antithetic Gaussian perturbations of the weights, standardised (or centred-rank) fitness
// shaping, and an Adam step along the estimated reward gradient. Small steps from a trained creature, so it is nudged, not replaced.

export interface EsOptions {
  pairs: number; // antithetic pairs per step, 2 x pairs episodes batches
  sigma: number; // perturbation std per weight
  lr: number; // Adam step size
  decay: number; // L2 pull on the weights per step, x lr
  shaping: "rank" | "zscore"; // fitness shaping: centred ranks (outlier proof) or standardised rewards (optimises the mean)
}

export const ES_DEFAULTS: EsOptions = { pairs: 16, sigma: 0.08, lr: 0.02, decay: 0.005, shaping: "zscore" };

const BETA1 = 0.9;
const BETA2 = 0.999;
const EPS = 1e-8;

export class Es {
  readonly theta: Float32Array;
  readonly options: EsOptions;
  step = 0;
  private readonly m: Float32Array;
  private readonly v: Float32Array;
  private noise: Float32Array[] = [];

  constructor(theta: Float32Array, options: Partial<EsOptions> = {}) {
    this.theta = Float32Array.from(theta);
    this.options = { ...ES_DEFAULTS, ...options };
    this.m = new Float32Array(theta.length);
    this.v = new Float32Array(theta.length);
  }

  // The genomes to score this step: theta + sigma e_k, then theta - sigma e_k, for each pair k.
  ask(rng: Rng): Float32Array[] {
    const { pairs, sigma } = this.options;
    const n = this.theta.length;
    this.noise = Array.from({ length: pairs }, () => {
      const e = new Float32Array(n);
      for (let i = 0; i < n; i++) e[i] = rng.normal();
      return e;
    });
    const out: Float32Array[] = [];
    for (const e of this.noise) {
      const plus = new Float32Array(n);
      const minus = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        plus[i] = this.theta[i]! + sigma * e[i]!;
        minus[i] = this.theta[i]! - sigma * e[i]!;
      }
      out.push(plus, minus);
    }
    return out;
  }

  // Rewards in ask's order; moves theta.
  tell(rewards: readonly number[]): void {
    const { pairs, sigma, lr, decay } = this.options;
    if (rewards.length !== 2 * pairs) throw new Error(`expected ${2 * pairs} rewards, got ${rewards.length}`);
    const shaped = this.options.shaping === "zscore" ? standardise(rewards) : centredRanks(rewards);
    const n = this.theta.length;
    const g = new Float32Array(n);
    for (let k = 0; k < pairs; k++) {
      const w = shaped[2 * k]! - shaped[2 * k + 1]!;
      if (w === 0) continue;
      const e = this.noise[k]!;
      for (let i = 0; i < n; i++) g[i] += w * e[i]!;
    }
    this.step++;
    const b1 = 1 - BETA1 ** this.step;
    const b2 = 1 - BETA2 ** this.step;
    for (let i = 0; i < n; i++) {
      const grad = g[i]! / (2 * pairs * sigma) - decay * this.theta[i]!; // ascent direction
      this.m[i] = BETA1 * this.m[i]! + (1 - BETA1) * grad;
      this.v[i] = BETA2 * this.v[i]! + (1 - BETA2) * grad * grad;
      this.theta[i] += (lr * (this.m[i]! / b1)) / (Math.sqrt(this.v[i]! / b2) + EPS);
    }
  }
}

// Ranks mapped to [-0.5, 0.5], ties sharing their mean rank, so the step ignores the reward scale and outliers.
export function centredRanks(x: readonly number[]): number[] {
  const n = x.length;
  if (n < 2) return x.map(() => 0);
  const order = x.map((_, i) => i).sort((a, b) => x[a]! - x[b]!);
  const ranks = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && x[order[j + 1]!] === x[order[i]!]) j++;
    const r = (i + j) / 2;
    for (let k = i; k <= j; k++) ranks[order[k]!] = r;
    i = j + 1;
  }
  return ranks.map((r) => r / (n - 1) - 0.5);
}

// Mean 0, std 1 (all zeros when the rewards do not differ).
export function standardise(x: readonly number[]): number[] {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / x.length);
  return x.map((v) => (sd > 0 ? (v - mean) / sd : 0));
}
