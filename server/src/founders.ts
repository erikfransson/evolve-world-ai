import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { lineageName, parseFounders as parseShared } from "../../src/typescript/src/live/founders.ts";
import type { FounderBirth } from "../../src/typescript/src/live/founders.ts";
import { lstatSync } from "node:fs";
import { genomeLengthFor } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import { checkGenome } from "../../src/typescript/src/sim/rl/validate.ts";
import { MAX_FOUNDERS_FILE_BYTES, MAX_POOL, MAX_POOLS_FILE_BYTES, MAX_POOL_WEIGHTS, liveConfig } from "./config.ts";
import { readRegularFile } from "./state.ts";

// The founders a fresh world is seeded with (LiveWorld.seedFounders), from src/typescript/public/live-founders.json, the file the page
// offers visitors, checked by the page's own parser (live/founders.ts). name: the lineage name.
export interface SeedFounder {
  id: string;
  name: string;
  plan: BodyPlan;
  genome: Float32Array;
  birth?: FounderBirth; // inside the live world's birth ranges
  pool?: Float32Array[]; // trained variants with the same plan (founder-pools.json): a fresh world's copies are drawn from genome and these
}

export { lineageName };

// The checked founders of the file's JSON (the shared parser, strict: every founder must pass), or the reason it is refused.
export function parseFounders(data: unknown): SeedFounder[] | string {
  const r = parseShared(data, true);
  if (typeof r === "string") return r;
  const { birthEnergyRange: e, birthCostRange: c, birthCooldownRange: d } = liveConfig.eco;
  const inside = (v: number, range: number[]): boolean => v >= range[0]! && v <= range[1]!;
  for (const [i, f] of r.entries()) {
    const b = f.birth;
    if (b && (!inside(b.energy, e) || !inside(b.cost, c) || (b.cooldown !== undefined && !inside(b.cooldown, d)))) return `founder ${i + 1}: birth must lie in the world's ranges (energy ${e[0]} to ${e[1]}, cost ${c[0]} to ${c[1]}, cooldown ${d[0]} to ${d[1]} s)`;
  }
  return r.map((f) => ({ id: f.id, name: f.lineage, plan: f.plan, genome: f.genome, ...(f.birth ? { birth: f.birth } : {}) }));
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

// Checks the pools file's JSON against the founders and adds each founder's pool, or returns the reason it is refused:
// {"version": 1, "pools": {"<founder id>": [[...genome], ...]}}, at most MAX_POOL variants a founder and MAX_POOL_WEIGHTS in all, each
// checked as an upload's genome is (checkGenome: exactly the length of its founder's plan, every weight finite and bounded). A pool for an
// unknown id is refused.
export function parsePools(data: unknown, founders: SeedFounder[]): SeedFounder[] | string {
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!obj(data) || data.version !== 1 || !obj(data.pools)) return 'pools must be {"version": 1, "pools": {"<founder id>": [[...genome], ...]}}';
  const byId = new Map(founders.map((f) => [f.id, f]));
  let weights = 0;
  const pools = new Map<string, Float32Array[]>();
  for (const [id, list] of Object.entries(data.pools)) {
    const f = byId.get(id);
    if (!f) return `pool "${id.slice(0, 20)}" is for no founder in the founders file`;
    if (founders.filter((x) => x.id === id).length > 1) return `pool ${id}: more than one founder has this id`;
    if (!Array.isArray(list) || list.length > MAX_POOL) return `pool ${id}: a list of at most ${MAX_POOL} genomes`;
    const n = genomeLengthFor("forager", f.plan);
    const out: Float32Array[] = [];
    for (const [k, g] of list.entries()) {
      weights += n;
      if (weights > MAX_POOL_WEIGHTS) return `pools hold more than ${MAX_POOL_WEIGHTS} weights in all`;
      const checked = checkGenome(g, n);
      if (typeof checked === "string") return `pool ${id}, genome ${k + 1}: ${checked}`;
      out.push(Float32Array.from(checked));
    }
    pools.set(id, out);
  }
  return founders.map((f) => (pools.get(f.id)?.length ? { ...f, pool: pools.get(f.id)! } : f));
}

// The founders with their pools from file, a regular file of at most MAX_POOLS_FILE_BYTES; unchanged when there is no file, unless it is
// required (a path the admin set, which the sandbox may hide). Throws with the reason.
export function loadPools(file: string, founders: SeedFounder[], required = false): SeedFounder[] {
  try {
    lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !required) return founders; // only a missing file means no pools; any other stat error stops the start
    throw new Error(`founder pools file ${file}: ${e instanceof Error ? e.message : e}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(readRegularFile(file, MAX_POOLS_FILE_BYTES).toString("utf8"));
  } catch (e) {
    throw new Error(`founder pools file ${file}: ${e instanceof Error ? e.message.replace("save file", "file") : e}`);
  }
  const r = parsePools(data, founders);
  if (typeof r === "string") throw new Error(`founder pools file ${file}: ${r}`);
  return r;
}
