// T2 probe: how much of ES's "best candidate" is luck, how noisy is the gradient, and what does selection by training score buy.
// Runs the real Trainer with a scorer that records every candidate's training rewards, and every `check` iterations scores all
// candidates and theta on fixed held-out seeds (set A) and theta on a disjoint set B.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/es-luck.ts --env nibble --from pool:0 --seed 1 [--iters 40] [--pairs 50]
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { poolLearner, randomLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { HELD_BASE, Trainer, heldSeeds, scoreGenomes } from "../../../src/typescript/src/sim/rl/trainer.ts";
import type { RlTask, Scorer } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    env: { type: "string", default: "nibble" },
    from: { type: "string", default: "pool:0" },
    seed: { type: "string", default: "1" },
    iters: { type: "string", default: "40" },
    pairs: { type: "string", default: "50" }, // Arena default population 100
    sigma: { type: "string", default: "0.08" },
    lr: { type: "string", default: "0.02" },
    episodes: { type: "string", default: "1" }, // Arena default
    held: { type: "string", default: "32" },
    check: { type: "string", default: "10" },
    threads: { type: "string", default: "2" },
    ema: { type: "string", default: "0.9" }, // theta averaged over the last ~1 / (1 - ema) iterations, scored at the end
  },
});
const N = (k: keyof typeof values) => Number(values[k]);

const env = envById(values.env!)!;
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const [kind, arg] = values.from!.split(":");
const learner = kind === "pool" ? poolLearner(env, pool![Number(arg)]!) : randomLearner(env, Number(arg));
const helpers = createNodeRlPool({ envs: [env], plan: learner.plan, pool, library: {} }, N("threads"));
let last: { tasks: readonly RlTask[]; rewards: number[] } | null = null;
const recorder: Scorer = {
  rewards: async (tasks) => {
    const rewards = await helpers.rewards(tasks);
    last = { tasks, rewards };
    return rewards;
  },
  setLeague: (g) => helpers.setLeague(g),
};
const trainer = new Trainer(Float32Array.from(learner.genome), { pairs: N("pairs"), sigma: N("sigma"), lr: N("lr") }, recorder, 1, N("episodes"), N("seed"));
const setA = heldSeeds(N("held"));
const setB = Array.from({ length: N("held") }, (_, k) => HELD_BASE + 10000 + k);

const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a: readonly number[]) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
const rank = (a: readonly number[]) => {
  const o = a.map((_, i) => i).sort((i, j) => a[i]! - a[j]!);
  const r = new Array<number>(a.length);
  o.forEach((i, k) => (r[i] = k));
  return r;
};
const corr = (x: readonly number[], y: readonly number[]) => {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
};
const cos = (a: Float64Array, b: Float64Array) => {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return ab / Math.sqrt(aa * bb);
};
// Per-episode rewards of each genome on each seed (rows genomes, columns seeds).
async function matrix(genomes: Float32Array[], seeds: number[]): Promise<number[][]> {
  const r = await helpers.rewards(genomes.flatMap((genome) => seeds.map((seed) => ({ env: 0, genome, seed }))));
  return genomes.map((_, g) => r.slice(g * seeds.length, (g + 1) * seeds.length));
}

const t0 = performance.now();
const startA = (await scoreGenomes(helpers, 1, [trainer.theta], setA))[0]!.mean;
console.log(`env ${env.id} from ${values.from} seed ${values.seed}: ${learner.genome.length} weights, pairs ${N("pairs")}, sigma ${N("sigma")}, lr ${N("lr")}, episodes ${N("episodes")}; theta held A ${startA.toFixed(3)}`);
const P = N("pairs");
let overallBest = { train: -Infinity, genome: new Float32Array(0), iter: 0 };
const cosHalves: number[] = [];
const cosSteps: number[] = [];
let prevDelta: Float64Array | null = null;
const ema = Float32Array.from(trainer.theta);
while (trainer.iter < N("iters")) {
  const before = Float32Array.from(trainer.theta);
  const step = await trainer.step();
  const { tasks, rewards } = last!;
  const E = N("episodes");
  const cand = Array.from({ length: 2 * P }, (_, g) => mean(rewards.slice(g * E, (g + 1) * E)));
  const genomes = Array.from({ length: 2 * P }, (_, g) => tasks[g * E]!.genome);
  // Gradient SNR: the estimate from pairs 0..P/2 against the one from P/2..P (both with the trainer's zscore over all candidates).
  const z = cand.map((v) => (sd(cand) > 0 ? (v - mean(cand)) / sd(cand) : 0));
  const n = before.length;
  const half = [new Float64Array(n), new Float64Array(n)];
  for (let k = 0; k < P; k++) {
    const w = z[2 * k]! - z[2 * k + 1]!;
    const h = half[k < P / 2 ? 0 : 1]!;
    for (let i = 0; i < n; i++) h[i] += w * (genomes[2 * k]![i]! - genomes[2 * k + 1]![i]!);
  }
  cosHalves.push(cos(half[0]!, half[1]!));
  for (let i = 0; i < ema.length; i++) ema[i] = N("ema") * ema[i]! + (1 - N("ema")) * trainer.theta[i]!;
  const delta = Float64Array.from(trainer.theta, (v, i) => v - before[i]!);
  if (prevDelta) cosSteps.push(cos(delta, prevDelta));
  prevDelta = delta;
  if (step.best > overallBest.train) overallBest = { train: step.best, genome: Float32Array.from(step.bestGenome), iter: step.iter };
  const pairDiff = Array.from({ length: P }, (_, k) => Math.abs(cand[2 * k]! - cand[2 * k + 1]!));
  let line = `iter ${step.iter}: train mean ${step.train.toFixed(3)} sd ${sd(cand).toFixed(3)} best ${step.best.toFixed(3)} (z ${((step.best - mean(cand)) / sd(cand)).toFixed(2)}), zero-diff pairs ${pairDiff.filter((d) => d === 0).length}/${P}, cos halves ${cosHalves.at(-1)!.toFixed(3)}, cos steps ${cosSteps.at(-1)?.toFixed(3) ?? "-"}`;
  if (step.iter % N("check") === 0) {
    // Every candidate of this step on held-out set A: does its training score predict it?
    const m = await matrix([...genomes, Float32Array.from(trainer.theta)], setA);
    const heldC = m.slice(0, 2 * P).map(mean);
    const thetaA = mean(m[2 * P]!);
    const thetaB = (await scoreGenomes(helpers, 1, [trainer.theta], setB))[0]!.mean;
    const bi = cand.indexOf(step.best);
    // Two-way split of the candidate x seed matrix: seed difficulty, candidate quality, interaction (noise).
    const S = setA.length, G = 2 * P;
    const grand = mean(heldC);
    const seedMeans = setA.map((_, s) => mean(m.slice(0, G).map((r) => r[s]!)));
    let ss = 0, sg = 0, se = 0;
    for (let g = 0; g < G; g++)
      for (let s = 0; s < S; s++) {
        const v = m[g]![s]!;
        se += (v - heldC[g]! - seedMeans[s]! + grand) ** 2;
      }
    for (const v of seedMeans) ss += (v - grand) ** 2;
    for (const v of heldC) sg += (v - grand) ** 2;
    const varE = se / ((G - 1) * (S - 1));
    const varSeed = ss / (S - 1) - varE / G;
    const varCand = sg / (G - 1) - varE / S;
    line += `\n  held A: theta ${thetaA.toFixed(3)} (B ${thetaB.toFixed(3)}), cand mean ${grand.toFixed(3)}, train-best cand ${heldC[bi]!.toFixed(3)} (train ${step.best.toFixed(3)}), held-best cand ${Math.max(...heldC).toFixed(3)}; corr(train, held) pearson ${corr(cand, heldC).toFixed(3)} spearman ${corr(rank(cand), rank(heldC)).toFixed(3)}; var seed ${varSeed.toFixed(3)} cand ${varCand.toFixed(4)} noise ${varE.toFixed(3)}; ${((performance.now() - t0) / 1000).toFixed(0)} s`;
  }
  console.log(line);
}
const [endA, obA, emaA] = (await scoreGenomes(helpers, 1, [trainer.theta, overallBest.genome, ema], setA)).map((s) => s.mean);
const [endB, obB, emaB] = (await scoreGenomes(helpers, 1, [trainer.theta, overallBest.genome, ema], setB)).map((s) => s.mean);
console.log(`end: theta averaged (ema ${N("ema")}) held A ${emaA!.toFixed(3)} B ${emaB!.toFixed(3)}`);
console.log(`end: theta held A ${startA.toFixed(3)} -> ${endA!.toFixed(3)} (B ${endB!.toFixed(3)}); best-ever train candidate (iter ${overallBest.iter}, train ${overallBest.train.toFixed(3)}) held A ${obA!.toFixed(3)} B ${obB!.toFixed(3)}`);
console.log(`mean cos halves ${mean(cosHalves.filter((c) => !Number.isNaN(c))).toFixed(3)}, mean cos successive steps ${mean(cosSteps).toFixed(3)}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
helpers.close();
