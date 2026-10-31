import { runEpisode, variantFor } from "./env.ts";
import type { EnvSpec, Learner, Library } from "./env.ts";
import { ENVS, envById } from "./envs.ts";
import { HELD_BASE } from "./trainer.ts";
import type { PoolEntry } from "../seedPool.ts";

// Transfer battery: scores a creature on held-out, Live-like and small forager episodes by what matters for living in Live
// (surviving, eating, avoiding poison), not by training reward. Everything here is deterministic per (genome, env, seed).

export const TRANSFER_BASE = HELD_BASE + 50000; // clear of training seeds (below HELD_BASE) and the existing held-out seeds (HELD_BASE + k, k < 50000)
export const transferSeeds = (count: number): number[] => Array.from({ length: count }, (_, k) => TRANSFER_BASE + k);

export const GROUPS = ["bigger", "small", "long"] as const;
export type Group = (typeof GROUPS)[number];
export interface BatteryEnv {
  env: EnvSpec;
  group: Group;
}

const SMALL = ["minefield", "stings", "patch", "far-food", "islands"];
const BIGGER = ["live-patch", "live-famine", "live-poison", "live-now", "live-commons"];
export const LONG_SECONDS = 240; // Live survival is long-horizon: four minutes of Live's current rules

export function batteryEnvs(): BatteryEnv[] {
  const get = (id: string): EnvSpec => envById(id) ?? ENVS[0]!;
  const longEnv: EnvSpec = { ...get("live-now"), id: "live-long", name: "Live long", seconds: LONG_SECONDS };
  return [
    ...BIGGER.map((id) => ({ env: get(id), group: "bigger" as const })),
    ...SMALL.map((id) => ({ env: get(id), group: "small" as const })),
    { env: longEnv, group: "long" as const },
  ];
}

export const METRICS = ["survival", "died", "foodPerMin", "firstFood", "clearTime", "poisonPerMin", "poisonEnergy", "energy"] as const;
export type Metric = (typeof METRICS)[number];
export const MIN_ALIVE_SECONDS = 5; // floor under the per-minute rates, so a creature dead at once does not divide by ~0

// One episode as the metrics: survival is the share of the episode lived, rates are per minute alive, firstFood is seconds to the first bite and clearTime seconds to eating every item (the episode length when none; survival counts a cleared episode as lived).
export function transferEpisode(env: EnvSpec, learner: Learner, seed: number, pool: readonly PoolEntry[] | null, library: Library): Record<Metric, number> {
  const r = runEpisode(env, learner, seed, pool, library);
  const total = variantFor(env, seed).seconds;
  const minutes = Math.max(r.elapsed, MIN_ALIVE_SECONDS) / 60; // really played, not the cleared episode's full length
  return { survival: r.seconds / total, died: r.died, foodPerMin: r.food / minutes, poisonPerMin: r.poison / minutes, poisonEnergy: r.poisonEnergy, firstFood: r.firstFood < 0 ? total : r.firstFood, clearTime: r.clearTime < 0 ? total : r.clearTime, energy: r.energy };
}

export type PerSeed = Record<Metric, number[]>; // one env, seeds in order
export interface GenomeResult {
  name: string;
  source: string;
  envs: Record<string, PerSeed>;
}

export const mean = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);
export function median(...v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

// Two-sided 95% t quantile (Cornish-Fisher expansion about the normal one; error below 1e-3 for df >= 8).
export function t975(df: number): number {
  const z = 1.959964;
  const z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

export interface Ci {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}
// Paired t interval of the mean of per-seed differences.
export function tInterval(diffs: readonly number[]): Ci {
  const n = diffs.length;
  const m = mean(diffs);
  if (n < 2) return { mean: m, lo: m, hi: m, n };
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (n - 1));
  const h = (t975(n - 1) * sd) / Math.sqrt(n);
  return { mean: m, lo: m - h, hi: m + h, n };
}

const seedCount = (g: GenomeResult): number => Object.values(g.envs)[0]?.survival.length ?? 0;

// Per metric, the mean over the given envs of each seed's value (envs weighted equally).
function overEnvs(g: GenomeResult, ids: readonly string[], metric: Metric): number[] {
  return Array.from({ length: seedCount(g) }, (_, s) => mean(ids.map((id) => g.envs[id]![metric][s]!)));
}

export interface Summary {
  all: Record<Metric, number>;
  byGroup: Record<string, Record<Metric, number>>;
  byEnv: Record<string, Record<Metric, number>>;
}
const means = (g: GenomeResult, ids: readonly string[]): Record<Metric, number> => Object.fromEntries(METRICS.map((m) => [m, mean(overEnvs(g, ids, m))])) as Record<Metric, number>;

export function summarise(g: GenomeResult, groups: Record<string, string>): Summary {
  const ids = Object.keys(g.envs);
  const byGroup: Summary["byGroup"] = {};
  for (const grp of GROUPS) {
    const of = ids.filter((id) => groups[id] === grp);
    if (of.length) byGroup[grp] = means(g, of);
  }
  return { all: means(g, ids), byGroup, byEnv: Object.fromEntries(ids.map((id) => [id, means(g, [id])])) };
}

export interface Paired {
  all: Record<Metric, Ci>; // mean over envs, paired over seeds
  byGroup: Record<string, Record<Metric, Ci>>;
  byEnv: Record<string, Record<Metric, Ci>>;
}
// a minus b on the envs and seeds both hold (same seed index means same seed value; callers check the seed base).
export function pairedDifference(a: GenomeResult, b: GenomeResult, groups: Record<string, string>): Paired {
  const ids = Object.keys(a.envs).filter((id) => b.envs[id]);
  const n = Math.min(seedCount(a), seedCount(b));
  const diff = (of: readonly string[], metric: Metric): Ci => {
    const x = overEnvs(a, of, metric), y = overEnvs(b, of, metric);
    return tInterval(Array.from({ length: n }, (_, s) => x[s]! - y[s]!));
  };
  const all = (of: readonly string[]): Record<Metric, Ci> => Object.fromEntries(METRICS.map((m) => [m, diff(of, m)])) as Record<Metric, Ci>;
  const byGroup: Paired["byGroup"] = {};
  for (const grp of GROUPS) {
    const of = ids.filter((id) => groups[id] === grp);
    if (of.length) byGroup[grp] = all(of);
  }
  return { all: all(ids), byGroup, byEnv: Object.fromEntries(ids.map((id) => [id, all([id])])) };
}
