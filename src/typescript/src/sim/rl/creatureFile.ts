import type { BodyPlan } from "../sensors.ts";
import { genomeLengthIn } from "./env.ts";
import { checkGenome, checkPlan, num, plainText } from "./validate.ts";
import { serialiseLearner } from "./library.ts";
export { PLAN_LIMITS, checkPlan } from "./validate.ts";
import type { EnvWorld, Learner } from "./env.ts";
import { PREDATOR, PREY } from "./env.ts";

// A saved creature (Arena "Save", later founder import and the Live upload). Plain JSON data, never code: parseCreatureFile
// is the one gate a file passes, and it rebuilds every value it keeps from checked numbers and short strings, so nothing
// from the file is evaluated, used as a key path or put into the page as HTML.

export const CREATURE_FORMAT = "evolve-world-creature";
export const CREATURE_VERSION = 1;
export const MAX_FILE_BYTES = 2_000_000;
const MAX_TEXT = 80;

export type CreatureKind = "forager" | "prey" | "predator";

// What each kind runs as: its input layout (world) and species.
export const KINDS: Record<CreatureKind, { world: EnvWorld; role: number; label: string }> = {
  forager: { world: "ecosystem", role: PREY, label: "Forager (Ecosystem)" },
  prey: { world: "hunt", role: PREY, label: "Prey (The Great Hunt)" },
  predator: { world: "hunt", role: PREDATOR, label: "Predator (The Great Hunt)" },
};

export interface CreatureFile {
  format: typeof CREATURE_FORMAT;
  version: typeof CREATURE_VERSION;
  kind: CreatureKind;
  name: string;
  plan: BodyPlan;
  genome: number[]; // in the kind's input layout
  training: { envs: string[]; iterations: number; from: string; heldStart: number | null; heldEnd: number | null; date: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string => plainText(v, max);

// The genome length a creature of this kind and plan needs.
export const genomeLengthFor = (kind: CreatureKind, plan: BodyPlan): number => genomeLengthIn(KINDS[kind].world, plan);

// A parsed creature file, or a readable reason it was rejected. Accepts the text of a file or its parsed JSON.
export function parseCreatureFile(input: unknown): CreatureFile | string {
  let data = input;
  if (typeof input === "string") {
    if (input.length > MAX_FILE_BYTES) return "file too large";
    try {
      data = JSON.parse(input);
    } catch {
      return "not a JSON file";
    }
  }
  if (!isObj(data) || data.format !== CREATURE_FORMAT) return "not an Evolve World creature file";
  if (data.version !== CREATURE_VERSION) return `creature file version ${String(data.version)}, expected ${CREATURE_VERSION}`;
  if (typeof data.kind !== "string" || !Object.hasOwn(KINDS, data.kind)) return "kind must be forager, prey or predator";
  const kind = data.kind as CreatureKind;
  const plan = checkPlan(data.plan);
  if (typeof plan === "string") return plan;
  const genome = checkGenome(data.genome, genomeLengthFor(kind, plan));
  if (typeof genome === "string") return genome;
  const t = isObj(data.training) ? data.training : {};
  const envs = Array.isArray(t.envs) ? t.envs.slice(0, 32).map((e) => text(e, 40)).filter(Boolean) : [];
  const score = (v: unknown): number | null => (num(v, [-1e6, 1e6]) ? v : null);
  return {
    format: CREATURE_FORMAT,
    version: CREATURE_VERSION,
    kind,
    name: text(data.name) || "Unnamed creature",
    plan,
    genome,
    training: { envs, iterations: Number.isInteger(t.iterations) && num(t.iterations, [0, 1e7]) ? t.iterations : 0, from: text(t.from), heldStart: score(t.heldStart), heldEnd: score(t.heldEnd), date: text(t.date, 30) },
  };
}

export function creatureFile(kind: CreatureKind, name: string, learner: Learner, training: CreatureFile["training"]): CreatureFile {
  return {
    format: CREATURE_FORMAT,
    version: CREATURE_VERSION,
    kind,
    name: text(name) || "Unnamed creature",
    ...serialiseLearner(learner),
    training,
  };
}

export const fileLearner = (f: CreatureFile): Learner => ({ plan: f.plan, genome: Float32Array.from(f.genome) });
