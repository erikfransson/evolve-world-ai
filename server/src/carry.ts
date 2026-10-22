import type { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { SCALARS } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { PLAN_LIMITS, plainText } from "../../src/typescript/src/sim/rl/validate.ts";
import { MAX_ADD_GENOME, MAX_COPIES, encodeAdd, parseAdd, validName, wireName } from "../../src/typescript/src/live/add.ts";
import type { AddRules, Birth } from "../../src/typescript/src/live/add.ts";
import type { SeedFounder } from "./founders.ts";

// An admin reset may carry one creature into the next world: `copies` copies of the oldest living creature of the running world or of a
// listed save (another world's too), under an admin-given family name. The reset writes the order to CARRY_FILE in the state directory,
// and the next fresh start checks it again, seeds it with the founders and moves it to USED_CARRY.
export const CARRY_FILE = "carry.json";
export const USED_CARRY = "carry.used.json";
export const REFUSED_CARRY = "carry.refused.json";
export const NEXT_CARRY = "carry.next.json"; // written before a reset moves anything, renamed to CARRY_FILE once the move is done
export const MAX_CARRY = 200; // copies of the carried creature
export const MAX_CARRY_FILE_BYTES = 24 * MAX_ADD_GENOME + 65_536; // the largest genome an add allows as a JSON number list (a float32 as a double is up to 24 characters), and the rest

// The creature a reset carries, and where it came from (for the admin's confirmation).
export interface Carried {
  from: string; // the save's name, or "running world"
  id: number;
  ageTicks: number;
  family: string; // the name its family carries, or "#<founder id>"
  plan: BodyPlan;
  genome: number[];
  birth: Birth;
}

export interface CarryOrder {
  version: 1;
  name: string;
  copies: number;
  creature: Carried;
}

const family = (name: string, founder: number): string => wireName(name).name || `#${founder}`;

// The oldest living creature of a running world (most ticks alive, the lowest id on a tie), or null when it is empty. Call between ticks.
export function oldestInWorld(eco: Ecosystem): Carried | null {
  let best = null as Ecosystem["members"][number] | null;
  for (const m of eco.members) if (!best || m.ageTicks > best.ageTicks || (m.ageTicks === best.ageTicks && m.id < best.id)) best = m;
  if (!best) return null;
  const p = best.creature.plan;
  const plan: BodyPlan = { rayCount: p.rayCount, raySpread: p.raySpread, rayLength: p.rayLength, hiddenLayers: [...p.hiddenLayers], memoryShort: p.memoryShort, memoryLong: p.memoryLong };
  return { from: "running world", id: best.id, ageTicks: best.ageTicks, family: family(eco.lineageName(best.founderId), best.founderId), plan, genome: Array.from(best.creature.brain.genome), birth: { ...best.birth } };
}

const unpack = (text: string): ArrayBuffer => Uint8Array.from(Buffer.from(text, "base64")).buffer; // a copy, so the typed views are aligned

// The oldest living creature of a parsed save, or null when it holds none. Read straight from the columns, never restored, so a save of
// another map, size or map version works as well as this world's; runs on the parse worker (saveParse.ts parseCarry) on unchecked JSON,
// so it checks the shape it reads and throws on a broken one. The creature itself is checked as an upload afterwards (checkCarry).
export function oldestInState(state: EcoState, from: string): Carried | null {
  const bad = (): never => {
    throw new Error("the save's creature columns are broken");
  };
  const c = (state as { creatures?: EcoState["creatures"] } | null)?.creatures ?? bad();
  if (!Number.isSafeInteger(c.count) || c.count < 0 || typeof c.scalars !== "string" || typeof c.genomes !== "string" || !Array.isArray(c.plans) || c.plans.length !== c.count) bad();
  if (c.count === 0) return null;
  const K = SCALARS.length;
  const at = (name: (typeof SCALARS)[number]): number => SCALARS.indexOf(name);
  const s = new Float64Array(unpack(c.scalars.length % 4 === 0 ? c.scalars : bad()));
  const g = new Float32Array(unpack(c.genomes.length % 4 === 0 ? c.genomes : bad()));
  if (s.length !== c.count * K) bad();
  for (const row of c.plans) if (!Array.isArray(row) || row.length < 7 || !row.every((v) => typeof v === "number" && Number.isFinite(v)) || !Number.isSafeInteger(row[5]) || row[5]! < 1) bad();
  let best = -1;
  for (let i = 0; i < c.count; i++) {
    const age = s[i * K + at("ticksAlive")]!;
    const bestAge = best < 0 ? -1 : s[best * K + at("ticksAlive")]!;
    if (age > bestAge || (age === bestAge && s[i * K + at("id")]! < s[best * K + at("id")]!)) best = i;
  }
  if (best < 0) bad(); // no age is a number
  let offset = 0;
  for (let i = 0; i < best; i++) offset += c.plans[i]![5]!;
  const row = c.plans[best]!;
  if (offset + row[5]! > g.length || row[5]! > MAX_ADD_GENOME || row.length > 6 + PLAN_LIMITS.layers[1]) bad(); // no larger than an upload, so a crafted save cannot post a huge genome to the main heap
  const v = (name: (typeof SCALARS)[number]): number => s[best * K + at(name)]!;
  const founder = v("founderId");
  const lateList = (state as { lineages?: { late?: unknown } }).lineages?.late;
  const late = Array.isArray(lateList) ? (lateList as unknown[]).find((l): l is [number, number, number, number, number, string] => Array.isArray(l) && l[0] === founder && typeof l[5] === "string") : undefined;
  return {
    from,
    id: v("id"),
    ageTicks: v("ticksAlive"),
    family: family(late?.[5] ?? "", founder),
    plan: { rayCount: row[0]!, raySpread: row[1]!, rayLength: row[2]!, memoryShort: row[3]!, memoryLong: row[4]!, hiddenLayers: row.slice(6) },
    genome: Array.from(g.subarray(offset, offset + row[5]!)),
    birth: { energy: v("birthEnergy"), cost: v("birthCost"), cooldown: v("birthCooldown") },
  };
}

// The order checked as an upload is (parseAdd: plan within the add limits, the genome the plan needs, every weight finite and bounded,
// birth traits in the world's ranges), with an admin name and 1 to min(MAX_CARRY, room) copies; or the reason it is refused.
// Used when the reset writes the order and again when the next start reads it back. founders: the starter names it may not take (any case),
// or the two families would show as one. The mutation scale is not carried: the copies breed at 1, as founders do.
export function checkCarry(data: unknown, rules: AddRules, room: number, founders: readonly string[] = []): CarryOrder | string {
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!obj(data) || data.version !== 1 || !obj(data.creature)) return "not a carry order";
  if (!validName(data.name)) return "the carried family's name must be 1 to 16 letters or digits";
  if (founders.some((f) => f.toLowerCase() === (data.name as string).toLowerCase())) return `the carried family's name must not be a starter founder's (${founders.join(", ")})`;
  const most = Math.min(MAX_CARRY, room);
  if (!Number.isInteger(data.copies) || (data.copies as number) < 1 || (data.copies as number) > most) return `carried copies must be a whole number from 1 to ${most}`;
  const c = data.creature;
  if (typeof c.from !== "string" || !Number.isSafeInteger(c.id) || typeof c.ageTicks !== "number" || !Number.isFinite(c.ageTicks) || c.ageTicks < 0 || typeof c.family !== "string") return "the carried creature's source fields are wrong";
  if (!Array.isArray(c.genome) || !obj(c.plan) || !obj(c.birth)) return "the carried creature has no plan, genome or birth traits";
  if (!c.genome.every((w) => typeof w === "number")) return "the carried creature's weights must be numbers"; // Float32Array.from would take "0.5" too
  let add: ReturnType<typeof parseAdd>;
  try {
    add = parseAdd(encodeAdd({ plan: c.plan as unknown as BodyPlan, genome: Float32Array.from(c.genome as number[]), birth: c.birth as unknown as Birth, name: data.name as string, hue: 0, copies: 1 }), { ...rules, maxCopies: MAX_COPIES });
  } catch {
    return "the carried creature is malformed";
  }
  if (typeof add === "string") return `the carried creature would not pass as an upload: ${add}`;
  const creature: Carried = { from: plainText(c.from, 64), id: c.id as number, ageTicks: c.ageTicks, family: plainText(c.family, 40), plan: add.plan, genome: Array.from(add.genome), birth: add.birth };
  return { version: 1, name: data.name as string, copies: data.copies as number, creature };
}

// The order as a founder for LiveWorld.seedFounders.
export const carryFounder = (o: CarryOrder): SeedFounder => ({ id: "carry", name: o.name, plan: o.creature.plan, genome: Float32Array.from(o.creature.genome), birth: o.creature.birth });

// One line for the admin: what was carried, from where.
export const carryLine = (o: CarryOrder, dt: number): string =>
  `${o.copies} copies named ${o.name} of creature #${o.creature.id} (family ${o.creature.family}, ${Math.round(o.creature.ageTicks * dt)} s old) from ${o.creature.from}`;
