import type { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { LIVE_FIELDS, LIVE_MAX } from "../../src/typescript/src/sim/retune.ts";
import type { RetunePatch } from "../../src/typescript/src/sim/retune.ts";
import { LIVE, MAX_POPULATION } from "./config.ts";

// The admin settings are the engine's own list (LIVE_FIELDS, LIVE_MAX) applied through Ecosystem.retune, which checks every value and
// changes all or nothing, plus the server-only `speed`. Keys are "section.field", e.g. "eco.foodRegrow".
export type Value = number | boolean | number[];
export interface Limit {
  min: number;
  max: number | null; // null: no upper bound beyond the kind of value
}

// Tighter than the engine's LIVE_MAX where the server needs it: the population bounds the frame size and so the viewer budget.
const SERVER_MAX: Record<string, number> = { "eco.maxPopulation": MAX_POPULATION };
const SPEED: Limit = { min: 0.25, max: 4 }; // simulated seconds per real second, the server clock rather than an engine setting

const KEYS = new Map<string, [string, string]>();
const LIMITS = new Map<string, Limit>([["speed", SPEED]]);
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
  const out: Record<string, Value> = { speed: LIVE.speed };
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
  let speed: number | null = null;
  for (const [key, value] of Object.entries(changes)) {
    if (key === "speed") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < SPEED.min || value > SPEED.max!) return `speed must be a number from ${SPEED.min} to ${SPEED.max}`;
      speed = value;
      continue;
    }
    const at = KEYS.get(key); // a Map, so "__proto__" and the like are plain unknown keys
    if (!at) return `${key} is not a live setting`;
    const max = SERVER_MAX[key];
    if (max !== undefined && typeof value === "number" && value > max) return `${key} must be at most ${max} on the live server`;
    (patch[at[0]] ??= {})[at[1]] = value;
  }
  if (Object.keys(patch).length > 0) {
    const result = eco.retune(patch as RetunePatch);
    if (!result.ok) return result.reason;
  }
  if (speed !== null) LIVE.speed = speed;
  return null;
}
