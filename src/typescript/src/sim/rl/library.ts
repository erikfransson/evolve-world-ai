import type { BodyPlan } from "../sensors.ts";
import type { Learner, Library } from "./env.ts";

// The RL library (public/rl/library.json): creatures trained in each env, by env id, in the env world's input layout.
// Later envs draw rivals from it ("library:<env id>"), so trained hunters train prey and trained prey train hunters.

export const LIBRARY_VERSION = 1;
const DECIMALS = 1000;

export interface StoredLearner {
  plan: BodyPlan;
  genome: number[];
}

export const serialiseLearner = (l: Learner): StoredLearner => ({
  plan: { ...l.plan, hiddenLayers: l.plan.hiddenLayers.slice() },
  genome: Array.from(l.genome, (v) => Math.round(v * DECIMALS) / DECIMALS),
});

// The learners of a library file; entries that are not a plan with a numeric genome are skipped.
export function parseLibrary(data: unknown): Library {
  const out: Library = {};
  if (typeof data !== "object" || data === null) return out;
  const d = data as { version?: unknown; envs?: Record<string, unknown> };
  if (d.version !== LIBRARY_VERSION || typeof d.envs !== "object" || d.envs === null) return out;
  for (const [id, list] of Object.entries(d.envs)) {
    if (!Array.isArray(list)) continue;
    out[id] = list
      .filter((e): e is StoredLearner => typeof e?.plan === "object" && Array.isArray(e?.genome) && e.genome.every((v: unknown) => typeof v === "number" && Number.isFinite(v)))
      .map((e) => ({ plan: { ...e.plan, hiddenLayers: e.plan.hiddenLayers.slice() }, genome: Float32Array.from(e.genome) }));
  }
  return out;
}
