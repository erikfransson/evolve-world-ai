import { parseCreatureFile } from "../sim/rl/creatureFile.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import { NAME_MAX, validName } from "./add.ts";

// The Live World's starter founders (public/live-founders.json, from scripts/pickFounders.ts): the server seeds a fresh world with them,
// the Live page and the RL Arena offer them. Each is held to the rules of an upload: the creature-file checks (parseCreatureFile:
// checkPlan, checkGenome), a spread above 0 as an add needs, and a lineage name of letters and digits.

export const MAX_FOUNDERS = 8;

export interface Founder {
  id: string;
  name: string; // as shown, "Slow and steady"
  lineage: string; // as a lineage name, "SlowAndSteady": the starters' families and a visitor's copy carry the same one
  blurb: string;
  speed: number;
  plan: BodyPlan;
  genome: Float32Array;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// "Slow and steady" -> "SlowAndSteady": the name as a lineage name (validName), or "" when nothing of it is left.
export const lineageName = (name: string): string =>
  name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("").slice(0, NAME_MAX);

function parseFounder(f: unknown, i: number): Founder | string {
  if (!isObj(f) || typeof f.name !== "string") return `founder ${i + 1} has no name`;
  const file = parseCreatureFile({ format: "evolve-world-creature", version: 1, kind: "forager", name: f.name, plan: f.plan, genome: f.genome });
  if (typeof file === "string") return `founder ${i + 1}: ${file}`;
  if (!(file.plan.raySpread > 0)) return `founder ${i + 1}: raySpread must be above 0`;
  const lineage = lineageName(f.name);
  if (!validName(lineage)) return `founder ${i + 1}: the name has no letters or digits`;
  const speed = typeof f.speed === "number" && Number.isFinite(f.speed) ? f.speed : 0;
  return { id: String(f.id).slice(0, 20), name: file.name.slice(0, 30), lineage, blurb: typeof f.blurb === "string" ? f.blurb.slice(0, 80) : "", speed, plan: file.plan, genome: Float32Array.from(file.genome) };
}

// The checked founders of the file's JSON. strict (the server): every founder must pass and there must be 1 to MAX_FOUNDERS, else the
// reason. Otherwise (the pages): the first MAX_FOUNDERS, skipping any that fail, possibly none.
export function parseFounders(data: unknown, strict: true): Founder[] | string;
export function parseFounders(data: unknown, strict?: false): Founder[];
export function parseFounders(data: unknown, strict = false): Founder[] | string {
  if (!isObj(data) || !Array.isArray(data.founders)) return strict ? "no founders list" : [];
  const list = data.founders;
  if (strict && (list.length < 1 || list.length > MAX_FOUNDERS)) return `${list.length} founders, the file must hold 1 to ${MAX_FOUNDERS}`;
  const out: Founder[] = [];
  for (const [i, f] of list.slice(0, MAX_FOUNDERS).entries()) {
    const r = parseFounder(f, i);
    if (typeof r !== "string") out.push(r);
    else if (strict) return r;
  }
  return out;
}
