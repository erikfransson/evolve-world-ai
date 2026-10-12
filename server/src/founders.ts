import { parseCreatureFile } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { NAME_MAX, validName } from "../../src/typescript/src/live/add.ts";
import { MAX_FOUNDERS_FILE_BYTES, MAX_SEED_FOUNDERS } from "./config.ts";
import { readRegularFile } from "./state.ts";

// The founders a fresh world is seeded with (LiveWorld.seedFounders), from src/typescript/public/live-founders.json, the file the page
// offers visitors. Held to the same rules as an upload: the creature-file checks (parseCreatureFile: checkPlan, checkGenome), a spread
// above 0 as an add needs, and a lineage name of letters and digits.
export interface SeedFounder {
  name: string;
  plan: BodyPlan;
  genome: Float32Array;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// "Slow and steady" -> "SlowAndSteady": the name as a lineage name (validName), or "" when nothing of it is left.
export const lineageName = (name: string): string =>
  name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("").slice(0, NAME_MAX);

// The checked founders of the file's JSON, or the reason it is refused. Every founder must pass; none is skipped.
export function parseFounders(data: unknown): SeedFounder[] | string {
  if (!isObj(data) || !Array.isArray(data.founders)) return "no founders list";
  const list = data.founders;
  if (list.length < 1 || list.length > MAX_SEED_FOUNDERS) return `${list.length} founders, the file must hold 1 to ${MAX_SEED_FOUNDERS}`;
  const out: SeedFounder[] = [];
  for (const [i, f] of list.entries()) {
    if (!isObj(f) || typeof f.name !== "string") return `founder ${i + 1} has no name`;
    const file = parseCreatureFile({ format: "evolve-world-creature", version: 1, kind: "forager", name: f.name, plan: f.plan, genome: f.genome });
    if (typeof file === "string") return `founder ${i + 1}: ${file}`;
    if (!(file.plan.raySpread > 0)) return `founder ${i + 1}: raySpread must be above 0`;
    const name = lineageName(f.name);
    if (!validName(name)) return `founder ${i + 1}: the name has no letters or digits`;
    out.push({ name, plan: file.plan, genome: Float32Array.from(file.genome) });
  }
  return out;
}

// Reads and checks the founders file: a regular file of at most MAX_FOUNDERS_FILE_BYTES. Throws with the reason.
export function loadFounders(file: string): SeedFounder[] {
  let data: unknown;
  try {
    data = JSON.parse(readRegularFile(file, MAX_FOUNDERS_FILE_BYTES).toString("utf8"));
  } catch (e) {
    throw new Error(`founders file ${file}: ${e instanceof Error ? e.message.replace("save file", "file") : e}`);
  }
  const founders = parseFounders(data);
  if (typeof founders === "string") throw new Error(`founders file ${file}: ${founders}`);
  return founders;
}
