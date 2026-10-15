import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { lineageName, parseFounders as parseShared } from "../../src/typescript/src/live/founders.ts";
import { MAX_FOUNDERS_FILE_BYTES } from "./config.ts";
import { readRegularFile } from "./state.ts";

// The founders a fresh world is seeded with (LiveWorld.seedFounders), from src/typescript/public/live-founders.json, the file the page
// offers visitors, checked by the page's own parser (live/founders.ts). name: the lineage name.
export interface SeedFounder {
  name: string;
  plan: BodyPlan;
  genome: Float32Array;
}

export { lineageName };

// The checked founders of the file's JSON (the shared parser, strict: every founder must pass), or the reason it is refused.
export function parseFounders(data: unknown): SeedFounder[] | string {
  const r = parseShared(data, true);
  return typeof r === "string" ? r : r.map((f) => ({ name: f.lineage, plan: f.plan, genome: f.genome }));
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
