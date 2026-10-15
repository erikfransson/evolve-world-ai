import type { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { LIVE_FIELDS, LIVE_MAX } from "../../src/typescript/src/sim/retune.ts";
import type { RetunePatch } from "../../src/typescript/src/sim/retune.ts";
import { MAX_COPIES } from "../../src/typescript/src/live/add.ts";
import { CAP_LIMITS, LIVE, MAX_POPULATION } from "./config.ts";

// The admin settings are the engine's own list (LIVE_FIELDS, LIVE_MAX) applied through Ecosystem.retune, which checks every value and
// changes all or nothing, plus the server's own settings in LIVE (`speed`, `add.*`). Keys are "section.field", e.g. "eco.foodRegrow".
export type Value = number | boolean | number[];
export interface Limit {
  min: number;
  max: number | null; // null: no upper bound beyond the kind of value
}

// Tighter than the engine's LIVE_MAX where the server needs it: the population bounds the frame size and so the viewer budget,
// and the item caps the item slots a world is built with (each alone; retune refuses a pair that needs more slots than the world has).
const SERVER_MAX: Record<string, number> = { "eco.maxPopulation": MAX_POPULATION, "eco.birthReserve": Math.min(1000, MAX_POPULATION - 1), "eco.foodMaxDensity": CAP_LIMITS.foodMaxDensity, "eco.poisonMaxDensity": CAP_LIMITS.poisonMaxDensity };
// Server settings: limits, and whole numbers only where marked.
type AddKey = keyof typeof LIVE.add;
const OWN: Record<string, Limit & { whole?: boolean }> = {
  speed: { min: 0.25, max: 4 }, // simulated seconds per real second, the server clock rather than an engine setting
  reseed: { min: 0, max: 1, whole: true },
  "add.perWindow": { min: 0, max: 1000, whole: true },
  "add.windowS": { min: 10, max: 86400 },
  "add.maxCopies": { min: 1, max: MAX_COPIES, whole: true },
  "add.aliveShare": { min: 0, max: 1 },
  "add.aliveFloor": { min: 0, max: MAX_POPULATION, whole: true },
  "add.perVisitor": { min: 0, max: 1000, whole: true },
  "add.socketEveryS": { min: 1, max: 3600 },
  "add.minSpeed": { min: 0, max: 4 },
  "add.startEnergy": { min: 10, max: 1000 },
  "add.birthHoldS": { min: 0, max: 600 },
};
const getOwn = (key: string): number => (key === "speed" || key === "reseed" ? LIVE[key] : LIVE.add[key.slice(4) as AddKey]);
const setOwn = (key: string, v: number): void => {
  if (key === "speed" || key === "reseed") LIVE[key] = v;
  else LIVE.add[key.slice(4) as AddKey] = v;
};

const KEYS = new Map<string, [string, string]>();
const LIMITS = new Map<string, Limit>(Object.entries(OWN).map(([k, { min, max }]) => [k, { min, max }]));
for (const [section, fields] of Object.entries(LIVE_FIELDS)) {
  for (const [field, kind] of Object.entries(fields)) {
    const key = `${section}.${field}`;
    KEYS.set(key, [section, field]);
    LIMITS.set(key, { min: 0, max: kind === "bool" || kind === "unit" ? 1 : (SERVER_MAX[key] ?? LIVE_MAX[key] ?? null) });
  }
}

export const tunableLimits = (): Record<string, Limit> => Object.fromEntries(LIMITS);

export function readTunables(eco: Ecosystem): Record<string, Value> {
  const config = eco.config as unknown as Record<string, Record<string, Value>>;
  const out: Record<string, Value> = {};
  for (const key of Object.keys(OWN)) out[key] = getOwn(key);
  for (const [key, [section, field]] of KEYS) {
    const v = config[section]![field]!;
    out[key] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

// Applies the changes and returns null, or changes nothing and returns the problem.
export function applyTunables(eco: Ecosystem, changes: unknown): string | null {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) return "changes must be an object";
  const patch: Record<string, Record<string, unknown>> = {};
  const own: [string, number][] = [];
  for (const [key, value] of Object.entries(changes)) {
    const lim = Object.hasOwn(OWN, key) ? OWN[key]! : null;
    if (lim) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < lim.min || value > lim.max! || (lim.whole && !Number.isInteger(value))) return `${key} must be a ${lim.whole ? "whole " : ""}number from ${lim.min} to ${lim.max}`;
      own.push([key, value]);
      continue;
    }
    const at = KEYS.get(key); // a Map, so "__proto__" and the like are plain unknown keys
    if (!at) return `${key} is not a live setting`;
    const max = SERVER_MAX[key];
    if (max !== undefined && typeof value === "number" && value > max) return `${key} must be at most ${max} on the live server`;
    (patch[at[0]] ??= {})[at[1]] = value;
  }
  // A reserve at or past the cap would leave births no room at all, and the world would die out.
  const after = (k: string, now: number): unknown => (Object.hasOwn(changes, k) ? (changes as Record<string, unknown>)[k] : now);
  const cap = after("eco.maxPopulation", eco.config.eco.maxPopulation);
  const reserve = after("eco.birthReserve", eco.config.eco.birthReserve);
  if (typeof cap === "number" && typeof reserve === "number" && reserve > 0 && reserve >= cap) return "eco.birthReserve must be below eco.maxPopulation";
  if (Object.keys(patch).length > 0) {
    const result = eco.retune(patch as RetunePatch);
    if (!result.ok) return result.reason;
  }
  for (const [key, v] of own) setOwn(key, v);
  return null;
}
