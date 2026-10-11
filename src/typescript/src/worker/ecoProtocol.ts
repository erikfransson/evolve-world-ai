import type { EcoConfig } from "../sim/ecoConfig.ts";
import type { Lineage, SpeciesCount } from "../sim/ecosystem.ts";
import type { Leaders } from "../sim/leaderboard.ts";
import type { TraitHistogram } from "../sim/popStats.ts";
import type { BodyPlan } from "../sim/sensors.ts";

export type BestBy = "age" | "children" | "eaten" | "kills";
export type EcoSpeedSetting = number | "max"; // simulated seconds per real second, "max" = as many ticks as fit

export type EcoInMessage =
  // poolUrl: seed pool JSON, fetched once by the worker. threads: helper threads, 0 for none, default from the core count.
  // shared: false keeps the helpers on messages even when shared memory is available.
  | { type: "start"; config: EcoConfig; run: number; poolUrl?: string; threads?: number; shared?: boolean }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reset" }
  | { type: "speed"; speed: EcoSpeedSetting }
  | { type: "select"; id: number | null }
  | { type: "selectBest"; by: BestBy; request: number } // selects the living creature with the highest value, ties to the lowest id
  | { type: "recycle"; buffer: ArrayBuffer; run?: number }; // run: the snapshot's run, only current-run buffers count as returned; hands a consumed snapshot buffer back for reuse

// The selected creature. alive is false once it has died, then only id is meaningful.
export interface SelectedDetails {
  id: number;
  alive: boolean;
  x: number;
  y: number;
  heading: number;
  energy: number;
  age: number; // seconds
  children: number;
  eaten: number; // food items eaten
  kills: number; // prey eaten
  species: number; // index into the config's species
  depth: number;
  parentId: number;
  hue: number;
  founderId: number; // the founder it descends from
  founderPool: boolean; // that founder came from the seed pool
  founderHue: number; // that founder's colour
  plan: BodyPlan; // the creature's own senses and brain shape; the genome is sized for it
  upkeep: number; // energy per second besides thrust and turning
  drain: number; // energy per second now, with old age, thrust and turning
  rayKinds: Uint8Array; // HitKind per ray
  rayCloseness: Float32Array;
  rayEnergy: Float32Array;
  rayOffsets: Float32Array;
  inputs: Float32Array; // brain input layer of the last tick; the rest follows from the genome
  genome: Float32Array | null; // only in the first snapshot after selecting
}

export interface EcoSnapshot {
  type: "snapshot";
  run: number; // the run number of the start message this belongs to
  tick: number;
  simTime: number;
  population: number;
  births: number;
  deaths: number;
  food: number;
  poison: number;
  oldestDepth: number;
  extinct: boolean;
  speed: number; // simulated seconds per real second achieved, 0 until measured
  helpers: number; // helper threads sensing and thinking, 0 when the worker runs alone
  sharedMemory: boolean; // the helpers use shared memory rather than messages
  wasm: boolean; // sense and think run on the WebAssembly kernels
  count: number; // creatures in the buffer
  itemCount: number;
  creatureCap: number; // array capacities that define the buffer layout
  itemCap: number;
  buffer: ArrayBuffer; // transferred; see snapshotViews
  selected: SelectedDetails | null;
  bestRequest: number; // the last selectBest request handled, so the page ignores selections from before it
  history?: Float64Array; // [time, population, food] per sample, then each species' population with several species; only when it changed
  species?: SpeciesCount[]; // per species, with several species
  // Lineages, sent about once a second (and with the first and last snapshot of a run). With several species, each
  // species has its own: lineages lists each species' in turn, and each history sample holds one block per species.
  lineages?: Lineage[]; // the LINEAGE_TOP largest living lineages, biggest first
  leaders?: Leaders[]; // the run's records per species, with the lineages
  traits?: (TraitHistogram[] | null)[]; // body plan histograms of each species' living creatures (TRAITS order), null for none alive, with the lineages
  lineageHistory?: Float64Array; // LINEAGE_STRIDE numbers per sample and species, at the times of `history`, only when it changed
}

export const LINEAGE_TOP = 8;
// One lineage history sample: time, creatures outside the top lineages, then LINEAGE_TOP times (founder id, count, hue); unused slots have id -1.
export const LINEAGE_STRIDE = 2 + 3 * LINEAGE_TOP;

export interface EcoErrorMessage {
  type: "error";
  message: string;
}

export type EcoOutMessage = EcoSnapshot | EcoErrorMessage;

export interface SnapshotViews {
  count: number;
  ids: Int32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  energy: Float32Array;
  hue: Float32Array;
  age: Float32Array; // seconds
  founder: Int32Array; // founder id
  species: Int32Array; // index into the config's species, 0 without
  itemCount: number;
  itemX: Float32Array;
  itemY: Float32Array;
  itemKind: Uint8Array;
}

const CREATURE_BYTES = 9 * 4; // id, x, y, heading, energy, hue, age, founder, species
const ITEM_BYTES = 2 * 4 + 1;

export function snapshotBytes(creatureCap: number, itemCap: number): number {
  return creatureCap * CREATURE_BYTES + itemCap * ITEM_BYTES;
}

// Typed views over a snapshot buffer: nine per-creature arrays, then item x, y and kind. A buffer may be larger than needed.
export function snapshotViews(buffer: ArrayBuffer, count: number, itemCount: number, creatureCap: number, itemCap: number): SnapshotViews {
  const f32 = (at: number, n: number): Float32Array => new Float32Array(buffer, at, n);
  const c = creatureCap * 4;
  const itemsAt = 9 * c;
  return {
    count,
    ids: new Int32Array(buffer, 0, creatureCap),
    x: f32(c, creatureCap),
    y: f32(2 * c, creatureCap),
    heading: f32(3 * c, creatureCap),
    energy: f32(4 * c, creatureCap),
    hue: f32(5 * c, creatureCap),
    age: f32(6 * c, creatureCap),
    founder: new Int32Array(buffer, 7 * c, creatureCap),
    species: new Int32Array(buffer, 8 * c, creatureCap),
    itemCount,
    itemX: f32(itemsAt, itemCap),
    itemY: f32(itemsAt + itemCap * 4, itemCap),
    itemKind: new Uint8Array(buffer, itemsAt + itemCap * 8, itemCap),
  };
}
