import { genomeLength, layerSizes, upgradeGenome } from "./brain.ts";
import { overrideConfig } from "./config.ts";
import type { DeepPartial } from "./config.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "./ecoConfig.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { Ecosystem } from "./ecosystem.ts";
import type { EcoCore, MemberRecord } from "./ecosystem.ts";
import type { LineageState } from "./lineages.ts";
import type { PoolEntry } from "./seedPool.ts";
import { checkRanges, mergeSpeciesList } from "./species.ts";
import type { World, WorldSnapshot } from "./world.ts";

// Save and restore of a whole Ecosystem run as plain JSON-serialisable data. A restored world continues bit-identically
// (same fingerprint tick for tick, with or without helper threads). Binary columns are base64 of little-endian typed arrays.
// Size: 11.7 MB of JSON for 1481 creatures on the default 12000 x 7500 world (about 6 KB per creature, the genomes dominate, plus the item slots).
// Not saved: the display-only collision events, the detail selection, the onDeath callback and the spare creature pool.
// A state saved on a machine with WebAssembly SIMD restores only where it is available too (the two paths are not bit-identical).

// Version 2 genomes have the terrain input (#34). A version 1 state is still read: restoreState inserts that input's zero weight column
// into every genome, and a config without the map fields comes back with no rock or ground (their defaults are 0).
export const STATE_VERSION = 2;
const OLDEST_VERSION = 1;

export interface EcoState {
  version: number;
  config: EcoConfig; // as it stands, retunes included; eco.wasm says whether the run used the kernels
  core: EcoCore;
  items: { xs: string; ys: string; kinds: string; nextItem: string; cellHead: string; freeSlots: string; freeCount: number };
  lineages: LineageState;
  creatures: {
    count: number;
    scalars: string; // float64, SCALARS.length per creature in list order
    plans: number[][]; // per creature: rayCount, raySpread, rayLength, memoryShort, memoryLong, genome length, ...hidden layers
    genomes: string; // float32, all creatures one after the other
    memory: string; // float64, the same
  };
}

// Per-creature numbers of the scalars column, in order.
const SCALARS = [
  "id", "parentId", "depth", "birthTick", "children", "eaten", "kills", "species", "hue", "founderId", "lastBirthTick",
  "birthEnergy", "birthCost", "birthCooldown", "cooldownTicks", "x", "y", "heading", "vx", "vy", "turnRate", "energy", "ticksAlive", "cos", "sin",
] as const;

type Typed = Float32Array | Float64Array | Int32Array | Uint8Array;

function pack(a: Typed): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function saveState(eco: Ecosystem): EcoState {
  const config = structuredClone(eco.config);
  config.eco.wasm = eco.wasm;
  const members = eco.members;
  const n = members.length;
  const K = SCALARS.length;
  const scalars = new Float64Array(n * K);
  const plans: number[][] = [];
  let genomeTotal = 0;
  let memoryTotal = 0;
  for (const m of members) {
    genomeTotal += m.creature.brain.genome.length;
    memoryTotal += m.creature.memory.length;
  }
  const genomes = new Float32Array(genomeTotal);
  const memory = new Float64Array(memoryTotal);
  let g = 0;
  let u = 0;
  members.forEach((m, i) => {
    const c = m.creature;
    const s = c.state;
    const row: number[] = [
      m.id, m.parentId, m.depth, m.birthTick, m.children, m.eaten, m.kills, m.species, m.hue, m.founderId, m.lastBirthTick,
      m.birth.energy, m.birth.cost, m.birth.cooldown, m.cooldownTicks, s.x, s.y, s.heading, s.vx, s.vy, s.turnRate, s.energy, s.ticksAlive, c.heading.cos, c.heading.sin,
    ];
    scalars.set(row, i * K);
    const p = c.plan;
    const genome = c.brain.genome;
    plans.push([p.rayCount, p.raySpread, p.rayLength, p.memoryShort, p.memoryLong, genome.length, ...p.hiddenLayers]);
    genomes.set(genome, g);
    g += genome.length;
    memory.set(c.memory, u);
    u += c.memory.length;
  });
  const w = (eco.world as World).snapshot();
  return {
    version: STATE_VERSION,
    config,
    core: eco.exportCore(),
    items: { xs: pack(w.xs), ys: pack(w.ys), kinds: pack(w.kinds), nextItem: pack(w.nextItem), cellHead: pack(w.cellHead), freeSlots: pack(w.freeSlots), freeCount: w.freeCount },
    lineages: eco.lineageTable.toState(),
    creatures: { count: n, scalars: pack(scalars), plans, genomes: pack(genomes), memory: pack(memory) },
  };
}

// Limits a state is held to on restore; far above any real world, they only stop a corrupt or hostile state from exhausting memory or time.
const MAX_RAYS = 64; // the WebAssembly kernels' limit
const MAX_ITEM_SLOTS = 2_000_000;
const MAX_CREATURES = 20_000;
const MAX_GENOME_FLOATS = 30_000_000; // all creatures together, 120 MB
const MAX_WORLD_SIZE = 50_000;
const MAX_DUE = 1e6; // food or poison due, items
const MAX_VELOCITY = 10_000; // units per second, each component
const MAX_NAME = 24; // characters of an inserted lineage's name

const invalid = (what: string): never => {
  throw new Error(`saved state is invalid: ${what}`);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number, what: string): number => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : invalid(`${what} must be a whole number from ${min} to ${max}`));

// Numbers anywhere in value must be finite.
function allFinite(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} is not a finite number`);
  } else if (Array.isArray(value)) value.forEach((v, i) => allFinite(v, `${path}[${i}]`));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) allFinite(v, `${path}.${k}`);
}

// The lineage table's columns and late rows hold the types Lineages.load expects: whole counts, finite hues, species in range, names as short plain text.
function checkLineages(raw: unknown, species: number, nextId: number): void {
  if (!isObject(raw)) return invalid("lineages are missing");
  const founders = raw.founders;
  for (const [k, col] of Object.entries({ live: raw.live, hue: raw.hue, species: raw.species, pool: raw.pool })) {
    if (!Array.isArray(col)) return invalid(`lineages.${k} is not a list`);
    for (const v of col) {
      if (k === "hue") { if (typeof v !== "number" || !Number.isFinite(v)) invalid("a lineage hue is not finite"); }
      else whole(v, 0, k === "species" ? species - 1 : k === "pool" ? 1 : MAX_CREATURES, `lineages.${k}`);
    }
  }
  if (!Array.isArray(raw.late) || raw.late.length > MAX_CREATURES) return invalid("lineages.late is not a list of bounded length");
  for (const row of raw.late as unknown[]) {
    if (!Array.isArray(row) || row.length !== 6) return invalid("a late lineage row is malformed");
    const [id, live, hue, sp, pool, name] = row as unknown[];
    whole(id, typeof founders === "number" ? founders : 0, Math.max(0, nextId - 1), "late lineage founder");
    whole(live, 0, MAX_CREATURES, "late lineage count");
    if (typeof hue !== "number" || !Number.isFinite(hue)) invalid("a late lineage hue is not finite");
    whole(sp, 0, species - 1, "late lineage species");
    whole(pool, 0, 1, "late lineage pool flag");
    if (typeof name !== "string" || name.length > MAX_NAME || /\p{Cc}/u.test(name)) invalid(`a late lineage name must be text of at most ${MAX_NAME} characters without control characters`);
  }
}

// The genomes in the current layout, each checked against the layout of its plan: a version 1 genome first gets the terrain input's
// column, so its length is judged in the new layout. plans[i][5] is genome i's length as saved. Returns the plans with the lengths
// that now hold, and the genomes one after the other; a state already current is returned as it is.
function currentGenomes(version: number, config: EcoConfig, plans: readonly number[][], genomes: Float32Array): { plans: number[][]; genomes: Float32Array } {
  const out: Float32Array[] = [];
  let at = 0;
  const fitted = plans.map((p) => {
    const plan = { rayCount: p[0]!, raySpread: p[1]!, rayLength: p[2]!, memoryShort: p[3]!, memoryLong: p[4]!, hiddenLayers: p.slice(6) };
    const saved = genomes.subarray(at, at + p[5]!);
    at += p[5]!;
    const genome = version === OLDEST_VERSION ? upgradeGenome(saved, config, plan) : saved;
    if (!genome || genome.length !== genomeLength(layerSizes(config, plan)) || (version === OLDEST_VERSION && genome === saved)) return invalid("a genome does not fit the layout of its plan");
    out.push(genome);
    return [...p.slice(0, 5), genome.length, ...plan.hiddenLayers];
  });
  if (version !== OLDEST_VERSION) return { plans: plans as number[][], genomes };
  const joined = new Float32Array(out.reduce((n, g) => n + g.length, 0));
  at = 0;
  for (const g of out) {
    joined.set(g, at);
    at += g.length;
  }
  return { plans: fitted, genomes: joined };
}

// The saved config merged over the defaults (unknown keys and wrong types throw), with sizes held to sane bounds.
function checkedConfig(raw: unknown): EcoConfig {
  if (!isObject(raw)) return invalid("config is missing");
  allFinite(raw, "config");
  const { species, ...rest } = raw;
  const defaults = species === undefined ? DEFAULT_ECO_CONFIG : DEFAULT_PREDATOR_CONFIG;
  const config = overrideConfig<EcoConfig>(defaults, rest as DeepPartial<EcoConfig>);
  if (species === undefined) delete config.species;
  else config.species = mergeSpeciesList(species, DEFAULT_PREDATOR_CONFIG.species!);
  checkRanges(config.eco as unknown as Record<string, unknown>, "eco");
  const { world, creature, eco } = config;
  if (!(world.width > 0 && world.width <= MAX_WORLD_SIZE && world.height > 0 && world.height <= MAX_WORLD_SIZE)) invalid("world size is out of bounds");
  if (!(config.dt > 0 && config.dt <= 1)) invalid("dt is out of bounds");
  if (!(creature.radius > 0 && creature.rayLength > 0 && creature.rayLength <= 5000)) invalid("creature radius or ray length is out of bounds");
  whole(eco.maxPopulation, 0, MAX_CREATURES, "eco.maxPopulation");
  whole(eco.initialPopulation, 0, MAX_CREATURES, "eco.initialPopulation");
  return config;
}

// Checks the item snapshot as the world will walk it: every link in range, no item on two lists or in a cycle, free slots and used slots adding up to the capacity.
function checkItems(w: WorldSnapshot, food: number, poison: number): void {
  const cap = w.xs.length;
  const visited = new Uint8Array(cap);
  let used = 0;
  let foods = 0;
  let poisons = 0;
  for (const head of w.cellHead) {
    for (let i = head; i !== -1; i = w.nextItem[i]!) {
      if (i < 0 || i >= cap) invalid("an item link points outside the item slots");
      if (visited[i]) invalid("the item lists loop or share an item");
      visited[i] = 1;
      used++;
      if (w.kinds[i] === 1) foods++;
      else if (w.kinds[i] === 2) poisons++;
      else invalid("a listed item has no food or poison kind");
    }
  }
  if (w.freeCount < 0 || w.freeCount > cap || used + w.freeCount !== cap) invalid("free and used item slots do not add up to the capacity");
  const free = new Uint8Array(cap);
  for (let k = 0; k < w.freeCount; k++) {
    const i = w.freeSlots[k]!;
    if (i < 0 || i >= cap || free[i] || visited[i]) invalid("the free slot list is wrong");
    free[i] = 1;
  }
  for (let i = 0; i < cap; i++) if (!(Number.isFinite(w.xs[i]) && Number.isFinite(w.ys[i]))) invalid("an item position is not finite");
  if (foods !== food || poisons !== poison) invalid("food and poison counts do not match the items");
}

// A text of base64 that decodes to length elements, checked before decoding so a huge text is refused cheaply.
function unpack<T extends Typed>(make: { new (buffer: ArrayBuffer): T; BYTES_PER_ELEMENT: number }, text: unknown, length: number, what: string): T {
  const bytes = length * make.BYTES_PER_ELEMENT;
  if (typeof text !== "string" || text.length !== 4 * Math.ceil(bytes / 3)) return invalid(`${what} has the wrong size`);
  const raw = atob(text);
  if (raw.length !== bytes) invalid(`${what} has the wrong size`);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return new make(out.buffer);
}

// A new Ecosystem continuing the saved run. pool is only needed for the same reason as in the constructor (ray limit of the WebAssembly kernels).
// journal: build it for helper threads, which then receive every creature and item in their first packet.
// The state is checked first (config, limits, ranges, links of the items, ids, lineages) and any violation throws an Error saying which.
export function restoreState(state: EcoState, pool: readonly PoolEntry[] | null = null, options: { journal?: boolean } = {}): Ecosystem {
  if (!isObject(state) || (state.version !== STATE_VERSION && state.version !== OLDEST_VERSION)) throw new Error(`saved state has version ${isObject(state) ? String(state.version) : "none"}, this build reads versions ${OLDEST_VERSION} and ${STATE_VERSION}`);
  const { core, creatures: cr } = state;
  if (!isObject(core) || !isObject(cr) || !isObject(state.items)) return invalid("core, items or creatures are missing");
  const config = checkedConfig(state.config);
  const species = config.species?.length ?? 1;
  const capacity = whole(core.itemCapacity, 0, MAX_ITEM_SLOTS, "itemCapacity");
  const founders = whole(core.founders, 0, MAX_CREATURES, "founders");
  whole(core.poolFounders, 0, founders, "poolFounders");
  const n = whole(cr.count, 0, MAX_CREATURES, "creature count");
  whole(core.tick, 0, Number.MAX_SAFE_INTEGER, "tick");
  for (const k of ["births", "deaths", "foodEaten", "poisonEaten", "food", "poison"] as const) whole(core[k], 0, Number.MAX_SAFE_INTEGER, k);
  const nextId = whole(core.nextId, 0, Number.MAX_SAFE_INTEGER, "nextId");
  whole(core.rngState, -(2 ** 31), 2 ** 32, "rngState");
  for (const k of ["foodDue", "poisonDue"] as const) if (!(typeof core[k] === "number" && core[k] >= 0 && core[k] <= MAX_DUE)) invalid(`${k} is out of bounds`);
  if (!Array.isArray(core.counts) || core.counts.length !== species) invalid("species counts do not match the config");
  if (!Array.isArray(cr.plans) || cr.plans.length !== n) invalid("plan count does not match creature count");
  const it = state.items;
  const cells = Math.max(1, Math.ceil(config.world.width / Math.max(config.creature.rayLength, 4 * config.world.itemRadius, 1))) * Math.max(1, Math.ceil(config.world.height / Math.max(config.creature.rayLength, 4 * config.world.itemRadius, 1)));
  const snapshot: WorldSnapshot = {
    xs: unpack(Float32Array, it.xs, capacity, "items.xs"),
    ys: unpack(Float32Array, it.ys, capacity, "items.ys"),
    kinds: unpack(Uint8Array, it.kinds, capacity, "items.kinds"),
    nextItem: unpack(Int32Array, it.nextItem, capacity, "items.nextItem"),
    cellHead: unpack(Int32Array, it.cellHead, cells, "items.cellHead"),
    freeSlots: unpack(Int32Array, it.freeSlots, capacity, "items.freeSlots"),
    freeCount: it.freeCount,
  };
  checkItems(snapshot, core.food, core.poison);

  const K = SCALARS.length;
  let genomeTotal = 0;
  let memoryTotal = 0;
  for (const p of cr.plans) {
    if (!Array.isArray(p) || p.length < 7 || p.length > 6 + 8) return invalid("a creature plan is malformed");
    allFinite(p, "plan");
    whole(p[0], 1, MAX_RAYS, "rayCount");
    if (!(p[2]! > 0 && p[2]! <= 5000)) invalid("a ray length is out of bounds");
    whole(p[3], 0, 64, "memoryShort");
    whole(p[4], 0, 64, "memoryLong");
    whole(p[5], 1, 5_000_000, "genome length");
    for (const h of p.slice(6)) whole(h, 1, 512, "hidden layer");
    genomeTotal += p[5]!;
    memoryTotal += p[3]! + p[4]!;
    if (genomeTotal > MAX_GENOME_FLOATS) invalid("the genomes are too big");
  }
  const scalars = unpack(Float64Array, cr.scalars, n * K, "creatures.scalars");
  const saved = unpack(Float32Array, cr.genomes, genomeTotal, "creatures.genomes");
  if (!saved.every(Number.isFinite)) invalid("a genome or memory holds a number that is not finite");
  const { plans, genomes } = currentGenomes(state.version, config, cr.plans as number[][], saved);
  const memory = unpack(Float64Array, cr.memory, memoryTotal, "creatures.memory");
  if (!memory.every(Number.isFinite)) invalid("a genome or memory holds a number that is not finite");
  const at = (name: (typeof SCALARS)[number]): number => SCALARS.indexOf(name);
  const ids = new Set<number>();
  const perFounder = new Map<number, number>();
  const perSpecies = new Array<number>(species).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < K; j++) {
      const v = scalars[i * K + j]!;
      if (Number.isNaN(v) || (!Number.isFinite(v) && SCALARS[j] !== "lastBirthTick")) invalid(`creature ${i} has a ${SCALARS[j]} that is not finite`);
    }
    const x = scalars[i * K + at("x")]!;
    const y = scalars[i * K + at("y")]!;
    if (!(x >= 0 && x <= config.world.width && y >= 0 && y <= config.world.height)) invalid(`creature ${i} is outside the walls`);
    if (!(Math.abs(scalars[i * K + at("vx")]!) <= MAX_VELOCITY && Math.abs(scalars[i * K + at("vy")]!) <= MAX_VELOCITY)) invalid(`creature ${i} moves faster than ${MAX_VELOCITY}`);
    const c = scalars[i * K + at("cos")]!;
    const sn = scalars[i * K + at("sin")]!;
    if (!(Math.abs(c * c + sn * sn - 1) <= 1e-6)) invalid(`creature ${i} has a heading that is not a unit vector`);
    const id = scalars[i * K + at("id")]!;
    whole(id, 0, nextId - 1, `creature ${i} id`);
    if (ids.has(id)) invalid(`creature id ${id} appears twice`);
    ids.add(id);
    const sp = whole(scalars[i * K + at("species")], 0, species - 1, `creature ${i} species`);
    perSpecies[sp]!++;
    const f = scalars[i * K + at("founderId")]!;
    perFounder.set(f, (perFounder.get(f) ?? 0) + 1);
  }
  for (let s = 0; s < species; s++) if (core.counts[s]!.population !== perSpecies[s]) invalid("species populations do not match the creatures");

  checkLineages(state.lineages, species, nextId);

  const eco = new Ecosystem(config, pool, { journal: options.journal, restore: { founders, poolFounders: core.poolFounders, itemCapacity: capacity } });
  if (config.eco.wasm !== eco.wasm) throw new Error("saved state ran with WebAssembly kernels that are not available here, or the reverse; results would differ");
  eco.importCore(core);
  eco.lineageTable.load(state.lineages);
  for (const f of perFounder.keys()) if (!eco.lineageTable.has(f)) invalid(`a creature descends from founder ${f}, which has no lineage row`);
  const off = eco.lineageTable.firstMismatch(perFounder);
  if (off >= 0) invalid(`lineage ${off} counts ${eco.lineageTable.size(off)} living, the creatures say ${perFounder.get(off) ?? 0}`);
  (eco.world as World).load(snapshot);
  let g = 0;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const p = plans[i]!;
    const v = (name: (typeof SCALARS)[number]): number => scalars[i * K + at(name)]!;
    const units = p[3]! + p[4]!;
    const record: MemberRecord = {
      id: v("id"), parentId: v("parentId"), depth: v("depth"), birthTick: v("birthTick"), children: v("children"), eaten: v("eaten"), kills: v("kills"),
      species: v("species"), hue: v("hue"), founderId: v("founderId"), lastBirthTick: v("lastBirthTick"),
      birthEnergy: v("birthEnergy"), birthCost: v("birthCost"), birthCooldown: v("birthCooldown"), cooldownTicks: v("cooldownTicks"),
      x: v("x"), y: v("y"), heading: v("heading"), vx: v("vx"), vy: v("vy"), turnRate: v("turnRate"), energy: v("energy"), ticksAlive: v("ticksAlive"), cos: v("cos"), sin: v("sin"),
      plan: { rayCount: p[0]!, raySpread: p[1]!, rayLength: p[2]!, memoryShort: p[3]!, memoryLong: p[4]!, hiddenLayers: p.slice(6) },
      genome: genomes.subarray(g, g + p[5]!),
      memory: memory.subarray(u, u + units),
    };
    eco.restoreMember(record);
    g += p[5]!;
    u += units;
  }
  return eco;
}
