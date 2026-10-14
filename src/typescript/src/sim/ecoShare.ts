import { refit } from "./brain.ts";
import { Creature, SenseBatch, senseThinkBatch } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import type { EngineConfig } from "./config.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { agingOf } from "./physics.ts";
import type { Aging } from "./physics.ts";
import type { Ecosystem } from "./ecosystem.ts";
import type { BodyPlan } from "./sensors.ts";
import { seenEnergyScale, speciesEngine, speciesList } from "./species.ts";
import type { HitKind } from "./types.ts";
import { ITEM_REMOVE, ITEM_SET, World } from "./world.ts";
import { F, I } from "./wasm/resident.ts";
import type { ResidentStore } from "./wasm/resident.ts";
import { advanceRows, prepareRows } from "./wasm/residentStep.ts";
import { SenseKernels } from "./wasm/senseKernels.ts";

// Sense and think on helper threads. Each tick the coordinator, which owns the Ecosystem, publishes a packet:
// every creature's pose, energy and species, plus the changes since the last packet (item changes, deaths, and births
// with their plan; the genome and the starting memory units go only to the helper that owns the creature, which keeps the memory from then on). Each helper keeps a copy of the item world and the brains of the creatures it owns,
// runs senseThinkBatch for those and writes their outputs into the packet. The coordinator owns a share too and senses
// it on its own creatures meanwhile; then it copies the helpers' outputs into its creatures and finishes the tick.
// Each thread also does memory and motion of its own creatures and looks up what each touches (the part of the tick that
// touches only one creature), so the coordinator is left with the order-dependent shared phase and the copies.
// Helpers see exactly what Ecosystem.sensePhase sees, so results are identical.
// Bodies are rows of each thread's kernel memory (wasm/resident.ts) when the kernels run, so the packet is filled from and read into the rows in bulk.
// The packet is a plain buffer, so it travels by postMessage (one copy per helper).

const DIED = 3; // delta record: DIED, id
const BORN = 4; // delta record: BORN, id, owner, species, rayCount, raySpread, rayLength, memoryShort, memoryLong, hidden layers, ...sizes, genome length (the genome itself, then the memory units, go only to its owner, in Packet.genomes)

// Header slots (Int32).
const H_COUNT = 0;
const H_CREATURE_CAP = 1;
const H_MEMORY_CAP = 2;
const H_DELTA_CAP = 3;
const H_DELTA_LENGTH = 4;
const H_GENOME_CAP = 5;
const H_STRIDE = 12; // memory units reserved per creature in memoryOut (after the aging rule, which takes bytes 24 to 47)
const AGING_AT = 24; // byte offset in the header after the six int32 fields, 8-aligned
const HEADER_BYTES = 64;

export interface Caps {
  creatures: number;
  memory: number; // Float64 words of memory units in a packet: creatures times the stride
  delta: number; // Float64 words of changes
  genome: number; // Float64 words of genomes, per helper packet: only those of its own new creatures
}

// Typed views over one packet buffer. Outputs come last, so the bytes before outputAt are the published state.
export interface Packet {
  buffer: ArrayBufferLike;
  caps: Caps;
  header: Int32Array;
  aging: Float64Array; // old-age rule in force this tick: on (1 or 0), startTicks, perTick; it follows Ecosystem.retune
  ids: Int32Array;
  owner: Int32Array; // helper that thinks for creature i
  species: Int32Array;
  x: Float64Array;
  y: Float64Array;
  cos: Float64Array; // heading
  sin: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  turnRate: Float64Array;
  energy: Float64Array;
  angle: Float64Array; // heading angle
  ticks: Float64Array; // ticks alive
  delta: Float64Array;
  genomes: Float64Array; // genomes of the helper's own births, in birth order; the delta records carry only their lengths
  // Outputs of the thread that owns creature i: its state after memory and motion, the new memory (laid out like memory)
  // and the item it touches there (-1 for none).
  after: Record<"x" | "y" | "vx" | "vy" | "turnRate" | "energy" | "angle" | "cos" | "sin", Float64Array>;
  memoryOut: Float64Array; // stride units per creature, creature i's from i * stride (header slot H_STRIDE)
  touched: Int32Array;
  outputAt: number; // byte offset of the outputs
}

type StateColumns = Packet["after"]; // the nine state columns, also those of a published Packet

function readState(c: Creature, a: StateColumns, i: number): void {
  const s = c.state;
  s.x = a.x[i]!;
  s.y = a.y[i]!;
  s.vx = a.vx[i]!;
  s.vy = a.vy[i]!;
  s.turnRate = a.turnRate[i]!;
  s.energy = a.energy[i]!;
  s.heading = a.angle[i]!;
  c.heading.cos = a.cos[i]!;
  c.heading.sin = a.sin[i]!;
}

function writeState(c: Creature, a: StateColumns, i: number): void {
  const s = c.state;
  a.x[i] = s.x;
  a.y[i] = s.y;
  a.vx[i] = s.vx;
  a.vy[i] = s.vy;
  a.turnRate[i] = s.turnRate;
  a.energy[i] = s.energy;
  a.angle[i] = s.heading;
  a.cos[i] = c.heading.cos;
  a.sin[i] = c.heading.sin;
}

function layout(caps: Caps): { f64At: number; outputAt: number; bytes: number } {
  const ints = HEADER_BYTES + 4 * 3 * caps.creatures;
  const f64At = Math.ceil(ints / 8) * 8;
  const outputAt = f64At + 8 * (10 * caps.creatures + caps.delta + caps.genome);
  return { f64At, outputAt, bytes: outputAt + 8 * (9 * caps.creatures + caps.memory) + 4 * caps.creatures };
}

export function packetBytes(caps: Caps): number {
  return layout(caps).bytes;
}

// Views over buffer laid out for caps; with caps omitted, the ones written in its header.
export function packetViews(buffer: ArrayBufferLike, caps?: Caps): Packet {
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
  if (caps) {
    header[H_CREATURE_CAP] = caps.creatures;
    header[H_MEMORY_CAP] = caps.memory;
    header[H_DELTA_CAP] = caps.delta;
    header[H_GENOME_CAP] = caps.genome;
  } else caps = { creatures: header[H_CREATURE_CAP]!, memory: header[H_MEMORY_CAP]!, delta: header[H_DELTA_CAP]!, genome: header[H_GENOME_CAP]! };
  const C = caps.creatures;
  const { f64At, outputAt } = layout(caps);
  let at = f64At;
  const f64 = (n: number): Float64Array => {
    const v = new Float64Array(buffer, at, n);
    at += 8 * n;
    return v;
  };
  return {
    buffer,
    caps,
    header,
    aging: new Float64Array(buffer, AGING_AT, 3),
    ids: new Int32Array(buffer, HEADER_BYTES, C),
    owner: new Int32Array(buffer, HEADER_BYTES + 4 * C, C),
    species: new Int32Array(buffer, HEADER_BYTES + 8 * C, C),
    x: f64(C),
    y: f64(C),
    cos: f64(C),
    sin: f64(C),
    vx: f64(C),
    vy: f64(C),
    turnRate: f64(C),
    energy: f64(C),
    angle: f64(C),
    ticks: f64(C),
    delta: f64(caps.delta),
    genomes: f64(caps.genome),
    after: {
      x: f64(C),
      y: f64(C),
      vx: f64(C),
      vy: f64(C),
      turnRate: f64(C),
      energy: f64(C),
      angle: f64(C),
      cos: f64(C),
      sin: f64(C),
    },
    memoryOut: f64(caps.memory),
    touched: new Int32Array(buffer, at, C),
    outputAt,
  };
}

// Bytes of p that hold the published state and changes; the rest of the delta area is unused this tick.
export function publishedBytes(p: Packet): number {
  return p.delta.byteOffset + 8 * p.header[H_DELTA_LENGTH]!;
}

// Caps covering need with room to grow, or null when have already fits. The delta and genome caps also shrink once far
// too big (after the first packet, which carries every founder's genome), since in fork-join each tick moves whole buffers.
export function fittedCaps(have: Caps | null, need: Caps): Caps | null {
  const big = (h: number, n: number): boolean => h > 4 * n + 65536;
  const oversized = have !== null && (big(have.delta, need.delta) || big(have.genome, need.genome));
  if (have && need.creatures <= have.creatures && need.memory <= have.memory && need.delta <= have.delta && need.genome <= have.genome && !oversized) return null;
  const up = (n: number, h: number): number => (have && n <= h ? h : Math.ceil(n * 1.5) + 64);
  const shrink = (n: number, h: number): number => (big(h, n) ? Math.ceil(n * 1.5) + 4096 : up(n, h));
  return { creatures: up(need.creatures, have?.creatures ?? 0), memory: up(need.memory, have?.memory ?? 0), delta: shrink(need.delta, have?.delta ?? 0), genome: shrink(need.genome, have?.genome ?? 0) };
}

// Coordinator side: assigns each new creature to the least loaded thread, writes packets and reads the outputs back.
// Owner index helpers stands for the coordinator itself.
export class ShareCoordinator {
  readonly helpers: number;
  private readonly ownerOf = new Map<number, number>();
  private readonly costOf = new Map<number, number>();
  private readonly load: Float64Array;
  private readonly genomeAt: Float64Array; // words of genomes written into each helper's packet this tick
  private readonly batch = new SenseBatch();
  private stride = 0; // most memory units of any creature so far
  private undo = new Float64Array(0); // the own creatures' memory at the tick start, for undoOwn, laid out like Packet.memoryOut
  private ownRows = new Int32Array(0); // resident bodies: row addresses and member indices of the own creatures, plus the watched one last
  private ownSelves = new Int32Array(0);
  private advanced = false; // senseOwn has moved the own creatures since the last publish

  constructor(helpers: number) {
    this.helpers = helpers;
    this.load = new Float64Array(helpers + 1);
    this.genomeAt = new Float64Array(helpers + 1);
  }

  // Sizes the next packet needs; eco must have been built with the journal option.
  need(eco: Ecosystem): Caps {
    const j = eco.journal!;
    let delta = j.items.length + 2 * j.died.length;
    let genome = 0;
    for (const id of j.born) {
      const c = eco.get(id)?.creature;
      if (!c) continue;
      const plan = c.plan;
      delta += 11 + plan.hiddenLayers.length;
      genome += c.brain.genome.length + plan.memoryShort + plan.memoryLong;
      this.stride = Math.max(this.stride, plan.memoryShort + plan.memoryLong);
    }
    return { creatures: eco.population, memory: eco.population * this.stride, delta, genome };
  }

  // Writes the tick-start state and drains the journal into p, whose caps must cover need(eco). Each new helper
  // creature's genome goes into that helper's packet only (packets[h]); the other threads need no copy.
  publish(eco: Ecosystem, p: Packet, packets: readonly Packet[]): void {
    this.advanced = false;
    const j = eco.journal!;
    const d = p.delta;
    let k = 0;
    const genomeAt = this.genomeAt.fill(0);
    const items = j.items;
    for (let i = 0; i < items.length; i++) d[k++] = items[i]!;
    for (const id of j.died) {
      d[k++] = DIED;
      d[k++] = id;
      const owner = this.ownerOf.get(id);
      if (owner === undefined) continue;
      this.load[owner] -= this.costOf.get(id)!;
      this.ownerOf.delete(id);
      this.costOf.delete(id);
    }
    for (const id of j.born) {
      const m = eco.get(id);
      if (!m) continue; // born and died since the last packet
      const c = m.creature;
      const genome = c.brain.genome;
      const plan = c.plan;
      let owner = 0;
      for (let h = 1; h <= this.helpers; h++) if (this.load[h]! < this.load[owner]!) owner = h;
      const cost = genome.length + 30 * plan.rayCount; // rough relative work of one creature
      this.load[owner] += cost;
      this.ownerOf.set(id, owner);
      m.owner = owner;
      this.costOf.set(id, cost);
      d[k++] = BORN;
      d[k++] = id;
      d[k++] = owner;
      d[k++] = m.species;
      d[k++] = plan.rayCount;
      d[k++] = plan.raySpread;
      d[k++] = plan.rayLength;
      d[k++] = plan.memoryShort;
      d[k++] = plan.memoryLong;
      d[k++] = plan.hiddenLayers.length;
      for (const n of plan.hiddenLayers) d[k++] = n;
      d[k++] = genome.length;
      if (owner < this.helpers) {
        const to = packets[owner]!.genomes;
        let at = genomeAt[owner]!;
        for (let g = 0; g < genome.length; g++) to[at++] = genome[g]!;
        const memory = c.memory; // a restored creature has memory already; the helper keeps it from here on
        for (let u = 0; u < memory.length; u++) to[at++] = memory[u]!;
        genomeAt[owner] = at;
      }
    }
    eco.drainJournal();
    p.header[H_DELTA_LENGTH] = k;
    const rule = eco.agingRule;
    p.aging[0] = rule ? 1 : 0;
    p.aging[1] = rule?.startTicks ?? 0;
    p.aging[2] = rule?.perTick ?? 0;

    const members = eco.members;
    const n = members.length;
    p.header[H_COUNT] = n;
    const stride = this.stride;
    p.header[H_STRIDE] = stride;
    if (this.undo.length < n * stride) this.undo = new Float64Array(Math.ceil(1.5 * n * stride));
    const undo = this.undo;
    const rows = eco.residentRows();
    if (rows) {
      // Bodies are rows of the kernel memory: copy the columns straight from there, walking the rows in memory order.
      const f = rows.store.f64;
      const i32 = rows.store.i32;
      const rowAt = rows.rowAt;
      for (let i = 0; i < n; i++) {
        const m = members[i]!;
        p.ids[i] = m.id;
        p.owner[i] = m.owner;
        p.species[i] = m.species;
        if (m.owner === this.helpers) {
          const b = rowAt[i]! << 1;
          const u0 = i32[b + I.units]! >> 3;
          const count = i32[b + I.unitCount]!;
          for (let u = 0; u < count; u++) undo[i * stride + u] = f[u0 + u]!;
        }
      }
      const all = eco.senseBatchRows();
      for (let k = 0; k < all.n; k++) {
        const i = all.selves[k]!;
        const o = all.rows[k]! >> 3;
        p.x[i] = f[o + F.x]!;
        p.y[i] = f[o + F.y]!;
        p.vx[i] = f[o + F.vx]!;
        p.vy[i] = f[o + F.vy]!;
        p.turnRate[i] = f[o + F.turn]!;
        p.energy[i] = f[o + F.energy]!;
        p.angle[i] = f[o + F.heading]!;
        p.cos[i] = f[o + F.cos]!;
        p.sin[i] = f[o + F.sin]!;
        p.ticks[i] = f[o + F.ticks]!;
      }
    } else for (let i = 0; i < n; i++) {
      const m = members[i]!;
      const c = m.creature;
      p.ids[i] = m.id;
      p.owner[i] = m.owner;
      p.species[i] = m.species;
      writeState(c, p, i);
      p.ticks[i] = c.state.ticksAlive;
      if (m.owner === this.helpers) {
        const memory = c.memory;
        for (let u = 0; u < memory.length; u++) undo[i * stride + u] = memory[u]!;
      }
    }
  }

  // Senses and thinks for the coordinator's own share, after eco.prepareTick; watch: id of a creature to sense even when
  // a helper owns it (same outputs), so its rays and brain inputs are current on this thread, or null.
  senseOwn(eco: Ecosystem, p: Packet, watch: number | null): void {
    if (eco.residentRows()) return this.senseOwnRows(eco, p, watch);
    const n = p.header[H_COUNT]!;
    const batch = this.batch;
    batch.clear();
    for (let i = 0; i < n; i++) if (p.owner[i] === this.helpers || p.ids[i] === watch) batch.add(eco.members[i]!.creature, i);
    eco.senseBatch(batch);
    // Memory and motion of the own creatures; a watched creature of a helper gets them from that helper.
    for (let k = 0; k < batch.count; k++) {
      const i = batch.selves[k]!;
      if (p.owner[i] === this.helpers) p.touched[i] = eco.advance(batch.creatures[k]!);
    }
    this.advanced = true;
  }

  // senseOwn for resident bodies: sense the own rows (and the watched one), then step the own rows in one pass.
  private senseOwnRows(eco: Ecosystem, p: Packet, watch: number | null): void {
    const all = eco.senseBatchRows();
    if (all.n > this.ownRows.length) {
      this.ownRows = new Int32Array(all.n + 1);
      this.ownSelves = new Int32Array(all.n + 1);
    }
    const { ownRows, ownSelves } = this;
    let n = 0;
    let watched = -1; // position in all of the watched creature when a helper owns it
    for (let k = 0; k < all.n; k++) {
      const self = all.selves[k]!;
      if (p.owner[self] === this.helpers) {
        ownRows[n] = all.rows[k]!;
        ownSelves[n++] = self;
      } else if (p.ids[self] === watch) watched = k;
    }
    if (watched >= 0) {
      ownRows[n] = all.rows[watched]!; // sensed after the own bodies, but not stepped
      ownSelves[n] = all.selves[watched]!;
      eco.senseRows(ownRows, ownSelves, n + 1);
    } else eco.senseRows(ownRows, ownSelves, n);
    eco.advanceRows(ownRows, ownSelves, n, p.touched);
    this.advanced = true;
  }

  // Puts the coordinator's own creatures back to the tick start from the published packet, after a tick that failed before
  // finishing (senseOwn has already moved them), so the ecosystem can run that tick again on this thread.
  undoOwn(eco: Ecosystem, p: Packet): void {
    if (!this.advanced) return; // senseOwn did not run, so nothing moved
    this.advanced = false;
    const members = eco.members;
    const n = Math.min(p.header[H_COUNT]!, members.length);
    for (let i = 0; i < n; i++) {
      if (p.owner[i] !== this.helpers) continue;
      const c = members[i]!.creature;
      readState(c, p, i);
      c.setMemory(this.undo, i * p.header[H_STRIDE]!);
    }
  }

  // Copies the results for creatures a helper owns from that helper's packet; home is the published one, packets[h] is
  // helper h's. Leaves what every creature touches in home.touched.
  collect(eco: Ecosystem, home: Packet, packets: readonly Packet[]): void {
    const members = eco.members;
    const stride = home.header[H_STRIDE]!;
    const rows = eco.residentRows();
    if (rows) {
      const f = rows.store.f64;
      const i32 = rows.store.i32;
      const rowAt = rows.rowAt;
      for (let i = 0; i < members.length; i++) {
        const owner = home.owner[i]!;
        if (owner === this.helpers) continue;
        const p = packets[owner]!;
        const a = p.after;
        const o = rowAt[i]!;
        f[o + F.x] = a.x[i]!;
        f[o + F.y] = a.y[i]!;
        f[o + F.vx] = a.vx[i]!;
        f[o + F.vy] = a.vy[i]!;
        f[o + F.turn] = a.turnRate[i]!;
        f[o + F.energy] = a.energy[i]!;
        f[o + F.heading] = a.angle[i]!;
        f[o + F.cos] = a.cos[i]!;
        f[o + F.sin] = a.sin[i]!;
        const b = o << 1;
        const u0 = i32[b + I.units]! >> 3;
        const count = i32[b + I.unitCount]!;
        const at = i * stride;
        for (let u = 0; u < count; u++) f[u0 + u] = p.memoryOut[at + u]!;
        home.touched[i] = p.touched[i]!;
      }
      return;
    }
    for (let i = 0; i < members.length; i++) {
      const owner = home.owner[i]!;
      if (owner === this.helpers) continue;
      const p = packets[owner]!;
      const c = members[i]!.creature;
      readState(c, p.after, i);
      c.setMemory(p.memoryOut, i * stride);
      home.touched[i] = p.touched[i]!;
    }
  }
}

// Helper side: a copy of the item world and the creatures this helper owns, kept in step by the packets.
export class ShareHelper {
  readonly index: number;
  private readonly engines: EngineConfig[]; // per species
  private readonly world: World;
  private readonly crowd: Crowd;
  private readonly mine = new Map<number, Creature>();
  private readonly speciesOf = new Map<number, number>();
  private readonly batch = new SenseBatch();
  private readonly spare: Creature[][]; // per species
  private genome = new Float32Array(0);
  private genomeAt = 0; // words of the packet's genomes read so far
  private readonly plan: BodyPlan = { rayCount: 0, raySpread: 0, rayLength: 0, hiddenLayers: [], memoryShort: 0, memoryLong: 0 };

  private readonly kernels: SenseKernels | null;
  private aging: Aging | null;
  private readonly store: ResidentStore | null; // with the kernels, the creatures' bodies are rows of their memory, as in the coordinator
  private rows = new Int32Array(0); // per owned creature of this tick: its row address and its index in the packet
  private selves = new Int32Array(0);

  // wasm: sense and think on the WebAssembly kernels when available, as the coordinator does.
  constructor(config: EcoConfig, worldCapacity: number, index: number, wasm = false) {
    this.kernels = wasm ? SenseKernels.create(config) : null;
    if (wasm && !this.kernels) throw new Error("helper has no WebAssembly kernels although the coordinator does"); // the run falls back to one thread
    const species = speciesList(config);
    const scale = seenEnergyScale(species);
    this.engines = species.map((sp) => speciesEngine(config, sp, scale));
    this.spare = this.engines.map(() => []);
    this.index = index;
    this.aging = agingOf(config.eco, config.dt);
    this.world = new World(config, worldCapacity);
    this.crowd = new Crowd(config);
    this.store = this.kernels?.residentStore() ?? null;
    this.store?.species.push(...this.engines); // the configs the rows' species indices stand for
  }

  // Creatures this helper thinks for.
  get owned(): number {
    return this.mine.size;
  }

  // Applies p's changes, then senses and thinks for the creatures this helper owns, writing their outputs into p.
  run(p: Packet): void {
    this.genomeAt = 0;
    this.apply(p.delta, p.genomes, p.header[H_DELTA_LENGTH]!);
    this.followAging(p.aging);
    const n = p.header[H_COUNT]!;
    this.crowd.rebuildFrom(p.x, p.y, p.energy, n, p.species);
    if (this.store) return this.runRows(p, n);
    const batch = this.batch;
    batch.clear();
    for (let i = 0; i < n; i++) {
      if (p.owner[i] !== this.index) continue;
      const c = this.mine.get(p.ids[i]!)!;
      readState(c, p, i);
      c.state.ticksAlive = p.ticks[i]!;
      batch.add(c, i);
    }
    senseThinkBatch(this.world, this.crowd, batch, this.kernels);
    const a = p.after;
    const stride = p.header[H_STRIDE]!;
    for (let k = 0; k < batch.count; k++) {
      const i = batch.selves[k]!;
      const c = batch.creatures[k]!;
      c.remember();
      c.steer();
      p.touched[i] = c.touched(this.world);
      writeState(c, a, i);
      const memory = c.memory;
      const at = i * stride;
      for (let u = 0; u < memory.length; u++) p.memoryOut[at + u] = memory[u]!;
    }
  }

  // run for resident bodies: the packet's state goes into the rows, which are sensed, stepped and read back in bulk.
  private runRows(p: Packet, n: number): void {
    const store = this.store!;
    const kernels = this.kernels!;
    if (n > this.rows.length) {
      this.rows = new Int32Array(n);
      this.selves = new Int32Array(n);
    }
    const { rows, selves } = this;
    let m = 0;
    let f = store.f64;
    for (let i = 0; i < n; i++) {
      if (p.owner[i] !== this.index) continue;
      const r = this.mine.get(p.ids[i]!)!.resident!;
      const o = r.o;
      f[o + F.x] = p.x[i]!;
      f[o + F.y] = p.y[i]!;
      f[o + F.vx] = p.vx[i]!;
      f[o + F.vy] = p.vy[i]!;
      f[o + F.turn] = p.turnRate[i]!;
      f[o + F.energy] = p.energy[i]!;
      f[o + F.heading] = p.angle[i]!;
      f[o + F.cos] = p.cos[i]!;
      f[o + F.sin] = p.sin[i]!;
      f[o + F.ticks] = p.ticks[i]!;
      rows[m] = r.ptr;
      selves[m++] = i;
    }
    prepareRows(store, rows, m, this.world.terrain);
    kernels.runRows(this.world, this.crowd, rows, selves, m, null);
    advanceRows(store, kernels.f32, rows, selves, m, this.aging, this.world, this.engines[0]!.creature.radius, p.touched);
    const a = p.after;
    const stride = p.header[H_STRIDE]!;
    f = store.f64; // the memory may have grown
    const g = store.i32;
    for (let k = 0; k < m; k++) {
      const i = selves[k]!;
      const o = rows[k]! >> 3;
      a.x[i] = f[o + F.x]!;
      a.y[i] = f[o + F.y]!;
      a.vx[i] = f[o + F.vx]!;
      a.vy[i] = f[o + F.vy]!;
      a.turnRate[i] = f[o + F.turn]!;
      a.energy[i] = f[o + F.energy]!;
      a.angle[i] = f[o + F.heading]!;
      a.cos[i] = f[o + F.cos]!;
      a.sin[i] = f[o + F.sin]!;
      const b = o << 1;
      const u0 = g[b + I.units]! >> 3;
      const count = g[b + I.unitCount]!;
      const at = i * stride;
      for (let u = 0; u < count; u++) p.memoryOut[at + u] = f[u0 + u]!;
    }
  }

  // Takes the old-age rule of the packet, for the creatures this helper owns now and later.
  private followAging(a: Float64Array): void {
    const now = this.aging;
    if (a[0] === (now ? 1 : 0) && (!now || (now.startTicks === a[1] && now.perTick === a[2]))) return;
    this.aging = a[0] === 1 ? { startTicks: a[1]!, perTick: a[2]! } : null;
    for (const c of this.mine.values()) c.aging = this.aging;
  }

  private apply(d: Float64Array, genomes: Float64Array, length: number): void {
    let k = 0;
    while (k < length) {
      const code = d[k++];
      if (code === ITEM_SET) {
        this.world.setItem(d[k]!, d[k + 1]!, d[k + 2]!, d[k + 3]! as HitKind);
        k += 4;
      } else if (code === ITEM_REMOVE) {
        this.world.removeItem(d[k++]!);
      } else if (code === DIED) {
        const id = d[k++]!;
        const c = this.mine.get(id);
        if (c) {
          this.mine.delete(id);
          this.spare[this.speciesOf.get(id)!]!.push(c);
          this.speciesOf.delete(id);
        }
      } else if (code === BORN) {
        k = this.born(d, genomes, k);
      } else throw new Error(`bad packet record ${code}`);
    }
  }

  // Reads one birth record from d[k ..]; returns the index after it.
  private born(d: Float64Array, genomes: Float64Array, k: number): number {
    const id = d[k++]!;
    const owner = d[k++]!;
    const species = d[k++]!;
    const plan = this.plan;
    plan.rayCount = d[k++]!;
    plan.raySpread = d[k++]!;
    plan.rayLength = d[k++]!;
    plan.memoryShort = d[k++]!;
    plan.memoryLong = d[k++]!;
    plan.hiddenLayers.length = d[k++]!;
    for (let l = 0; l < plan.hiddenLayers.length; l++) plan.hiddenLayers[l] = d[k++]!;
    const length = d[k++]!;
    if (owner !== this.index) return k;
    this.genome = refit(this.genome, length);
    const genome = this.genome;
    for (let g = 0; g < length; g++) genome[g] = genomes[this.genomeAt++]!;
    const units = plan.memoryShort + plan.memoryLong;
    let c = this.spare[species]!.pop();
    if (c) c.reset(genome, 0, 0, 0, 0, plan);
    else c = new Creature(this.engines[species]!, genome, 0, 0, 0, plan, this.store);
    if (this.store) {
      this.kernels!.attach(c);
      c.resident!.species = species;
    }
    c.setMemory(genomes, this.genomeAt);
    this.genomeAt += units;
    c.aging = this.aging;
    this.mine.set(id, c);
    this.speciesOf.set(id, species);
    return k;
  }
}
