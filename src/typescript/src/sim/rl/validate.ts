import type { BodyPlan } from "../sensors.ts";

// Checks shared by every gate for outside data: creature files, library entries and custom envs (see docs/modes-plan.md).

const MAX_WEIGHT = 1000;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g; // control and bidi-override characters

// A short plain string: control and bidi characters removed, at most max long; "" for anything that is not a string.
export const plainText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(UNSAFE_CHARS, "").slice(0, max).trim() : "");

// Plan limits: the Ecosystem's mutation ranges, which every page can run.
export const PLAN_LIMITS = { rayCount: [1, 16], raySpread: [0, 2 * Math.PI], rayLength: [10, 400], layers: [1, 4], neurons: [1, 32], memory: [0, 8] } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, [lo, hi]: readonly [number, number]): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
export const num = (v: unknown, [lo, hi]: readonly [number, number]): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

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

// The weights as a new array when there are exactly `length` finite ones within bounds, or a reason.
export function checkGenome(g: unknown, length: number): number[] | string {
  if (!Array.isArray(g) || g.length !== length) return `genome must have ${length} weights for this plan`;
  if (!g.every((v) => num(v, [-MAX_WEIGHT, MAX_WEIGHT]))) return "genome weights must be finite numbers";
  return (g as number[]).slice();
}
