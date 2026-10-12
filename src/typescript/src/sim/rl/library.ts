import { envById } from "./envs.ts";
import { genomeLengthIn, layoutConfig } from "./env.ts";
import type { EnvWorld, Learner, Library } from "./env.ts";
import { upgradeGenome } from "../brain.ts";
import type { BodyPlan } from "../sensors.ts";
import { checkGenome, checkPlan } from "./validate.ts";

// The RL library (public/rl/library.json): creatures trained in each env, by env id, in the env world's input layout.
// Later envs draw rivals from it ("library:<env id>"), so trained hunters train prey and trained prey train hunters.

export const LIBRARY_VERSION = 1;
const DECIMALS = 1000;
const MAX_PER_ENV = 64;

export interface StoredLearner {
  plan: BodyPlan;
  genome: number[];
}

export const serialiseLearner = (l: Learner): StoredLearner => ({
  plan: { ...l.plan, hiddenLayers: l.plan.hiddenLayers.slice() },
  genome: Array.from(l.genome, (v) => Math.round(v * DECIMALS) / DECIMALS || 0), // no -0, which JSON cannot keep
});

// The weights of a plan in this world's layout, checked like checkGenome. A genome made before the terrain input (#34) is upgraded first
// (a zero weight column), so old files and library entries load; one that fits neither layout is rejected.
export function checkGenomeIn(g: unknown, world: EnvWorld, plan: BodyPlan): number[] | string {
  const length = genomeLengthIn(world, plan);
  if (Array.isArray(g) && g.length !== length && g.every((v) => typeof v === "number")) {
    const upgraded = upgradeGenome(Float32Array.from(g as number[]), layoutConfig(world), plan);
    if (upgraded) return checkGenome(Array.from(upgraded), length);
  }
  return checkGenome(g, length);
}

// One stored learner checked like a creature file (plan limits, exact genome length for the world, bounded weights), or a reason.
export function checkLearner(e: unknown, world: EnvWorld): Learner | string {
  const plan = checkPlan((e as { plan?: unknown } | null)?.plan);
  if (typeof plan === "string") return plan;
  const genome = checkGenomeIn((e as { genome?: unknown }).genome, world, plan);
  return typeof genome === "string" ? genome : { plan, genome: Float32Array.from(genome) };
}

// The valid learners of a library file, by the id of a built-in env (whose world fixes their layout); everything else is skipped.
export function parseLibrary(data: unknown): Library {
  const out: Library = Object.create(null);
  if (typeof data !== "object" || data === null) return out;
  const d = data as { version?: unknown; envs?: unknown };
  if (d.version !== LIBRARY_VERSION || typeof d.envs !== "object" || d.envs === null) return out;
  for (const [id, list] of Object.entries(d.envs)) {
    const env = envById(id);
    if (!env || !Array.isArray(list)) continue;
    out[id] = list.slice(0, MAX_PER_ENV).map((e) => checkLearner(e, env.world)).filter((l): l is Learner => typeof l !== "string");
  }
  return out;
}
