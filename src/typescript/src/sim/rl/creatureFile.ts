import { genomeLength, layerSizes } from "../brain.ts";
import type { BodyPlan } from "../sensors.ts";
import { BLANK_ENV, envConfig } from "./env.ts";
import type { EnvWorld, Learner } from "./env.ts";
import { PREDATOR, PREY } from "./env.ts";

// A saved creature (Arena "Save", later founder import and the Live upload). Plain JSON data, never code: parseCreatureFile
// is the one gate a file passes, and it rebuilds every value it keeps from checked numbers and short strings, so nothing
// from the file is evaluated, used as a key path or put into the page as HTML.

export const CREATURE_FORMAT = "evolve-world-creature";
export const CREATURE_VERSION = 1;
export const MAX_FILE_BYTES = 2_000_000;
const MAX_WEIGHT = 1000;
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

// Plan limits: the Ecosystem's mutation ranges, which every page can run.
export const PLAN_LIMITS = { rayCount: [1, 16], raySpread: [0, 2 * Math.PI], rayLength: [10, 400], layers: [1, 4], neurons: [1, 32], memory: [0, 8] } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, [lo, hi]: readonly [number, number]): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const num = (v: unknown, [lo, hi]: readonly [number, number]): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const text = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.slice(0, max).replace(/[\u0000-\u001f\u007f]/g, "") : "");

// A plan within PLAN_LIMITS, rebuilt from its checked fields, or a reason it is not one.
export function checkPlan(p: unknown): BodyPlan | string {
  if (!isObj(p)) return "plan missing";
  const L = PLAN_LIMITS;
  if (!int(p.rayCount, L.rayCount)) return `rayCount must be ${L.rayCount[0]} to ${L.rayCount[1]}`;
  if (!num(p.raySpread, [0, 2 * Math.PI + 1e-6])) return "raySpread must be 0 to 2 pi";
  if (!num(p.rayLength, L.rayLength)) return `rayLength must be ${L.rayLength[0]} to ${L.rayLength[1]}`;
  if (!Array.isArray(p.hiddenLayers) || !int(p.hiddenLayers.length, L.layers) || !p.hiddenLayers.every((n) => int(n, L.neurons))) return `hiddenLayers must be 1 to 4 layers of 1 to 32`;
  if (!int(p.memoryShort, L.memory) || !int(p.memoryLong, L.memory)) return "memory must be 0 to 8 units each";
  return { rayCount: p.rayCount, raySpread: Math.min(2 * Math.PI, p.raySpread), rayLength: p.rayLength, hiddenLayers: (p.hiddenLayers as number[]).slice(), memoryShort: p.memoryShort, memoryLong: p.memoryLong };
}

// The genome length a creature of this kind and plan needs.
export const genomeLengthFor = (kind: CreatureKind, plan: BodyPlan): number => genomeLength(layerSizes(envConfig({ ...BLANK_ENV, world: KINDS[kind].world }, 1), plan));

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
  const g = data.genome;
  const want = genomeLengthFor(kind, plan);
  if (!Array.isArray(g) || g.length !== want) return `genome must have ${want} weights for this plan`;
  if (!g.every((v) => num(v, [-MAX_WEIGHT, MAX_WEIGHT]))) return "genome weights must be finite numbers";
  const t = isObj(data.training) ? data.training : {};
  const envs = Array.isArray(t.envs) ? t.envs.slice(0, 32).map((e) => text(e, 40)).filter(Boolean) : [];
  const score = (v: unknown): number | null => (num(v, [-1e6, 1e6]) ? v : null);
  return {
    format: CREATURE_FORMAT,
    version: CREATURE_VERSION,
    kind,
    name: text(data.name) || "Unnamed creature",
    plan,
    genome: (g as number[]).slice(),
    training: { envs, iterations: int(t.iterations, [0, 1e7]) ? t.iterations : 0, from: text(t.from), heldStart: score(t.heldStart), heldEnd: score(t.heldEnd), date: text(t.date, 30) },
  };
}

export function creatureFile(kind: CreatureKind, name: string, learner: Learner, training: CreatureFile["training"]): CreatureFile {
  return {
    format: CREATURE_FORMAT,
    version: CREATURE_VERSION,
    kind,
    name: text(name) || "Unnamed creature",
    plan: { ...learner.plan, hiddenLayers: learner.plan.hiddenLayers.slice() },
    genome: Array.from(learner.genome, (v) => Math.round(v * 1000) / 1000 || 0), // no -0, which JSON cannot keep
    training,
  };
}

export const fileLearner = (f: CreatureFile): Learner => ({ plan: f.plan, genome: Float32Array.from(f.genome) });
