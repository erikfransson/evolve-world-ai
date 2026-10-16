// "Add your creature" on the wire (Live World protocol 4, see protocol.ts), shared by the page and the server.
//
// Client to server, text: {"t":"add","plan":Plan,"genome":<base64>,"birth":{"energy","cost","cooldown"},"name":<1-16 letters or digits>,"hue":<0..360>,"copies":<1..10>[,"mutationScale":<0.25..4>]}
//   plan: exactly the six creature-file plan fields within PLAN_LIMITS. genome: little-endian float32 weights in the forager (Ecosystem)
//   layout for the plan, base64, every weight finite and within the creature-file bound. Exact keys everywhere; anything else is refused.
// Server to client, text: Added {"t":"added","ids":[...],"name"} or Refused {"t":"refused","reason","retryS"?}.

import { MUTATION_SCALE_RANGE } from "../sim/ecoInsert.ts";
import { PLAN_LIMITS, checkGenome, checkPlan } from "../sim/rl/validate.ts";
import { genomeLengthFor } from "../sim/rl/creatureFile.ts";
import type { BodyPlan } from "../sim/sensors.ts";

export const NAME_MAX = 16;
export const NAME_RE = /^[A-Za-z0-9]{1,16}$/;
export const MAX_COPIES = 10; // copies per add the protocol allows; the server's add.maxCopies may hold it lower
const L = PLAN_LIMITS;
// The largest forager genome PLAN_LIMITS allow, and the add message that carries it (base64 of 4 bytes a weight, plus room for the rest).
export const MAX_ADD_GENOME = genomeLengthFor("forager", { rayCount: L.rayCount[1], raySpread: 1, rayLength: 100, hiddenLayers: Array<number>(L.layers[1]).fill(L.neurons[1]), memoryShort: L.memory[1], memoryLong: L.memory[1] });
export const MAX_ADD_BYTES = Math.ceil((MAX_ADD_GENOME * 4) / 3) * 4 + 1024;
export const ADD_PREFIX = '{"t":"add",'; // encodeAdd puts t first; the server reads no longer message that does not start so

// The Live World's birth trait ranges (wider than the Ecosystem's 100-225, 50-110, 5-20), so a visitor can make a creature that waits
// for far more energy before a child. The server's world uses them (config.ts), the add panel falls back to them before the hello.
export const LIVE_BIRTH = { energy: [100, 500], cost: [50, 250], cooldown: [5, 40] } as const satisfies Record<string, readonly [number, number]>;

export interface Birth {
  energy: number;
  cost: number;
  cooldown: number;
}

export interface AddRequest {
  plan: BodyPlan;
  genome: Float32Array;
  birth: Birth;
  name: string;
  hue: number;
  copies: number;
  mutationScale?: number; // how strongly its descendants' brains change, MUTATION_SCALE_RANGE; missing is 1 (a page from before 0.2.1)
}

// What the server allows, sent in the hello (null while adding is off): copies, birth trait ranges and the costs behind energy per second.
export interface AddRules {
  maxCopies: number;
  everyS: number; // a connection may add once per this many seconds (after a burst of the server's add.burst); one sent before a refusal's retryS is a strike, and strikes cut it off
  birth: { energy: [number, number]; cost: [number, number]; cooldown: [number, number] };
  costs: { living: number; ray: number; neuron: number }; // planUpkeep's livingCost, rayCost (per 100 units of ray), neuronCost
}

export interface Added {
  t: "added";
  ids: number[];
  name: string;
}
export interface Refused {
  t: "refused";
  reason: string;
  retryS?: number; // try again after about this many seconds
}

export const validName = (name: unknown): name is string => typeof name === "string" && NAME_RE.test(name);

// The starter founders a fresh Live world is seeded with keep their name in the engine behind this mark, which no visitor's name
// can have, so they are told apart from visitor adds, also after a save and restore. The wire carries the bare name and a starter flag.
export const STARTER_MARK = "*";
export const BLANKED = "-"; // a name an admin cleared (no valid name, so the wire carries none), still a visitor's add
export function wireName(engineName: string): { name: string; starter: boolean } {
  const starter = engineName.startsWith(STARTER_MARK);
  const name = starter ? engineName.slice(STARTER_MARK.length) : engineName;
  return validName(name) ? { name, starter } : { name: "", starter: false };
}

// Energy per second of a plan besides thrust and turning, as the engine's planUpkeep computes it.
export function upkeepOf(plan: Pick<BodyPlan, "rayCount" | "rayLength" | "hiddenLayers" | "memoryShort" | "memoryLong">, costs: AddRules["costs"]): number {
  let neurons = plan.memoryShort + plan.memoryLong;
  for (const n of plan.hiddenLayers) neurons += n;
  return costs.living + (costs.ray * plan.rayCount * plan.rayLength) / 100 + costs.neuron * neurons;
}

function toBase64(f: Float32Array): string {
  const bytes = new Uint8Array(f.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < f.length; i++) dv.setFloat32(4 * i, f[i]!, true);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const B64 = /^[A-Za-z0-9+/]*$/;
// Exactly n float32 weights, or null. Checks the length before decoding anything.
function fromBase64(s: unknown, n: number): Float32Array | null {
  if (typeof s !== "string" || s.length !== Math.ceil((n * 4) / 3) * 4) return null;
  const pad = (3 - ((n * 4) % 3)) % 3;
  const body = s.slice(0, s.length - pad);
  if (!B64.test(body) || s.slice(s.length - pad) !== "=".repeat(pad)) return null;
  let raw: string;
  try {
    raw = atob(s);
  } catch {
    return null;
  }
  if (raw.length !== n * 4) return null;
  const dv = new DataView(new ArrayBuffer(n * 4));
  for (let i = 0; i < raw.length; i++) dv.setUint8(i, raw.charCodeAt(i));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(4 * i, true);
  return out;
}

export function encodeAdd(r: AddRequest): string {
  const plan = { rayCount: r.plan.rayCount, raySpread: r.plan.raySpread, rayLength: r.plan.rayLength, hiddenLayers: r.plan.hiddenLayers.slice(), memoryShort: r.plan.memoryShort, memoryLong: r.plan.memoryLong };
  return JSON.stringify({ t: "add", plan, genome: toBase64(r.genome), birth: { energy: r.birth.energy, cost: r.birth.cost, cooldown: r.birth.cooldown }, name: r.name, hue: r.hue, copies: r.copies, ...(r.mutationScale !== undefined ? { mutationScale: r.mutationScale } : {}) });
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
};
const inRange = (v: unknown, [lo, hi]: readonly [number, number]): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const PLAN_KEYS = ["rayCount", "raySpread", "rayLength", "hiddenLayers", "memoryShort", "memoryLong"] as const;

// A well-formed add request within the rules, or the reason it is not one. Strict: exact keys, numbers in range, the genome the
// plan needs. The plan and weights pass the same checks as a creature file (checkPlan, checkGenome).
export function parseAdd(data: string, rules: AddRules): AddRequest | string {
  if (data.length > MAX_ADD_BYTES) return "message too large";
  if (!data.startsWith(ADD_PREFIX)) return "not an add message";
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return "not JSON";
  }
  const keys = ["t", "plan", "genome", "birth", "name", "hue", "copies"];
  if (!isPlain(m) || !(exactKeys(m, keys) || exactKeys(m, [...keys, "mutationScale"])) || m.t !== "add") return "wrong fields";
  if (!isPlain(m.plan) || !exactKeys(m.plan, PLAN_KEYS)) return "wrong plan fields";
  if (!Array.isArray(m.plan.hiddenLayers) || m.plan.hiddenLayers.length > L.layers[1]) return "hiddenLayers must be 1 to 4 layers of 1 to 32";
  const plan = checkPlan(m.plan);
  if (typeof plan === "string") return plan;
  if (!(plan.raySpread > 0)) return "raySpread must be above 0"; // insertCreature needs a spread
  const n = genomeLengthFor("forager", plan);
  const weights = fromBase64(m.genome, n);
  if (!weights) return `genome must be ${n} float32 weights in base64`;
  const genome = checkGenome(Array.from(weights), n);
  if (typeof genome === "string") return genome;
  if (!isPlain(m.birth) || !exactKeys(m.birth, ["energy", "cost", "cooldown"])) return "wrong birth fields";
  const b = rules.birth;
  if (!inRange(m.birth.energy, b.energy) || !inRange(m.birth.cost, b.cost) || !inRange(m.birth.cooldown, b.cooldown)) return "birth traits out of range";
  if (!validName(m.name)) return `name must be 1 to ${NAME_MAX} letters or digits`;
  if (!inRange(m.hue, [0, 360])) return "hue must be 0 to 360";
  if (!Number.isInteger(m.copies) || !inRange(m.copies, [1, Math.min(MAX_COPIES, rules.maxCopies)])) return `copies must be 1 to ${Math.min(MAX_COPIES, rules.maxCopies)}`;
  if (m.mutationScale !== undefined && !inRange(m.mutationScale, MUTATION_SCALE_RANGE)) return `mutationScale must be a number from ${MUTATION_SCALE_RANGE[0]} to ${MUTATION_SCALE_RANGE[1]}`;
  return { plan, genome: Float32Array.from(genome), birth: { energy: m.birth.energy, cost: m.birth.cost, cooldown: m.birth.cooldown }, name: m.name, hue: m.hue, copies: m.copies, ...(m.mutationScale !== undefined ? { mutationScale: m.mutationScale as number } : {}) };
}

// Replies from the wire with sane values, or null.
export function cleanAddReply(m: unknown): Added | Refused | null {
  if (!isPlain(m)) return null;
  if (m.t === "added") {
    if (!Array.isArray(m.ids) || m.ids.length < 1 || m.ids.length > MAX_COPIES || !m.ids.every((i) => Number.isInteger(i) && i >= 0 && i <= 0xffffffff) || !validName(m.name)) return null;
    return { t: "added", ids: (m.ids as number[]).slice(), name: m.name };
  }
  if (m.t === "refused") {
    const reason = typeof m.reason === "string" ? m.reason.replace(/[^\x20-\x7e]/g, "").slice(0, 160) : "";
    const retryS = inRange(m.retryS, [0, 86400]) ? Math.ceil(m.retryS) : undefined;
    return { t: "refused", reason: reason || "refused", ...(retryS !== undefined ? { retryS } : {}) };
  }
  return null;
}

export function cleanAddRules(r: unknown): AddRules | null {
  if (!isPlain(r) || !isPlain(r.birth) || !isPlain(r.costs)) return null;
  const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && inRange(v[0], [0, 1e5]) && inRange(v[1], [v[0], 1e5]) ? [v[0], v[1]] : null);
  const energy = pair(r.birth.energy);
  const cost = pair(r.birth.cost);
  const cooldown = pair(r.birth.cooldown);
  const { living, ray, neuron } = r.costs;
  if (!energy || !cost || !cooldown || !inRange(living, [0, 1e4]) || !inRange(ray, [0, 1e4]) || !inRange(neuron, [0, 1e4])) return null;
  if (!Number.isInteger(r.maxCopies) || !inRange(r.maxCopies, [1, MAX_COPIES]) || !inRange(r.everyS, [0, 86400])) return null;
  return { maxCopies: r.maxCopies, everyS: r.everyS, birth: { energy, cost, cooldown }, costs: { living, ray, neuron } };
}
