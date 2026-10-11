import { genomeLength, layerSizes } from "./brain.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { remapWeights } from "./planMutation.ts";
import { checkPlan } from "./rl/validate.ts";
import { FEAT_CREATURE, RAY_FEATURES, rayFeatureCount } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import type { Genome, Rng } from "./types.ts";

// Seed pool (#11): creatures trained headless in Trials by src/buildPool.ts, shipped as public/pool.json, used as Ecosystem founders.

export const POOL_VERSION = 1;

export interface PoolEntry {
  plan: BodyPlan;
  genome: Genome; // Trials input layout (rays without creature features), sized by plan
  fitness: number; // mean Trials survival in seconds on held-out layouts
  world: { food: number; poison: number }; // Trials densities it was trained in
}

const sees = (seesCreatures: boolean): EngineConfig => ({ ...DEFAULT_CONFIG, creature: { ...DEFAULT_CONFIG.creature, seesCreatures } });
const TRIALS = sees(false);
const ECO = sees(true);

export const trialsSizes = (plan: PlanView): number[] => layerSizes(TRIALS, plan);
export const ecoSizes = (plan: PlanView): number[] => layerSizes(ECO, plan);

// remapWeights draws only for new hidden or output units, which a ray-feature remap never adds.
const NO_RNG: Rng = {
  next: () => { throw new Error("unexpected draw"); },
  range: () => { throw new Error("unexpected draw"); },
  int: () => { throw new Error("unexpected draw"); },
  normal: () => { throw new Error("unexpected draw"); },
};

// The Ecosystem genome of a Trials creature: zero weights from each ray's creature (or species) flags and seen energy, all
// else kept, so the creature acts exactly as in Trials until evolution makes use of the new inputs. target: the config
// whose input layout to map to (the Ecosystem's one creature flag by default, or one flag per species).
export function trialsToEcoGenome(plan: PlanView, genome: Genome, target: EngineConfig = ECO): Float32Array {
  const from = trialsSizes(plan);
  const to = layerSizes(target, plan);
  if (genome.length !== genomeLength(from)) throw new Error(`genome length ${genome.length} does not match the Trials plan (${genomeLength(from)})`);
  const F = rayFeatureCount(target);
  const rayInputs = plan.rayCount * F;
  const inputs = Int32Array.from({ length: to[0]! }, (_, i) => {
    if (i >= rayInputs) return i - plan.rayCount * (F - RAY_FEATURES);
    const f = i % F;
    return f >= FEAT_CREATURE ? -1 : Math.floor(i / F) * RAY_FEATURES + f;
  });
  const maps = [inputs, ...to.slice(1).map((n) => Int32Array.from({ length: n }, (_, j) => j))];
  const out = new Float32Array(genomeLength(to));
  remapWeights(from, genome, maps, out, NO_RNG);
  return out;
}

const isNum = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// One JSON entry as a PoolEntry, or a reason it is malformed.
function parseEntry(e: unknown): PoolEntry | string {
  if (!isObj(e) || !isObj(e.plan) || !isObj(e.world)) return "not an object with plan and world";
  const plan = checkPlan(e.plan);
  if (typeof plan === "string") return plan;
  if (!isNum(e.fitness, 0, Infinity) || !isNum(e.world.food, 0, 100) || !isNum(e.world.poison, 0, 100)) return "bad fitness or world";
  const g = e.genome;
  if (!Array.isArray(g) || g.length !== genomeLength(trialsSizes(plan)) || !g.every((v) => isNum(v, -1e6, 1e6))) return "genome missing, of the wrong length or not finite";
  return { plan, genome: Float32Array.from(g as number[]), fitness: e.fitness, world: { food: e.world.food, poison: e.world.poison } };
}

// The valid entries of a pool file, and a reason per rejected one. Throws when the file itself is not a pool.
export function parsePool(data: unknown): { entries: PoolEntry[]; rejected: string[] } {
  if (!isObj(data) || !Array.isArray(data.entries)) throw new Error("not a pool file (no entries array)");
  if (data.version !== POOL_VERSION) throw new Error(`pool version ${String(data.version)}, expected ${POOL_VERSION}`);
  const entries: PoolEntry[] = [];
  const rejected: string[] = [];
  data.entries.forEach((e, i) => {
    const r = parseEntry(e);
    if (typeof r === "string") rejected.push(`entry ${i}: ${r}`);
    else entries.push(r);
  });
  return { entries, rejected };
}

// Fetches and parses a pool; on any failure warns and returns null, so the caller falls back to random founders.
export async function loadPool(url: string, fetchFn: typeof fetch = fetch): Promise<PoolEntry[] | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { entries, rejected } = parsePool(await res.json());
    if (rejected.length) console.warn(`seed pool: ${rejected.length} malformed entries skipped (${rejected[0]})`);
    if (!entries.length) throw new Error("no valid entries");
    return entries;
  } catch (error) {
    console.warn(`seed pool ${url} not loaded, founders are all random: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
