import { refit } from "./brain.ts";
import { Creature, SenseBatch, senseThinkBatch } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import type { EngineConfig } from "./config.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { agingOf } from "./physics.ts";
import type { Aging } from "./physics.ts";
import type { Ecosystem } from "./ecosystem.ts";
import type { BodyPlan } from "./sensors.ts";
import { speciesEngine, speciesList } from "./species.ts";
import type { HitKind } from "./types.ts";
import { ITEM_REMOVE, ITEM_SET, World } from "./world.ts";
import { SenseKernels } from "./wasm/senseKernels.ts";

// Sense and think on helper threads. Each tick the coordinator, which owns the Ecosystem, publishes a packet:
// every creature's pose, energy, species and memory, plus the changes since the last packet (item changes, deaths, and births
// with their plan and genome). Each helper keeps a copy of the item world and the brains of the creatures it owns,
// runs senseThinkBatch for those and writes their outputs into the packet. The coordinator owns a share too and senses
// it on its own creatures meanwhile; then it copies the helpers' outputs into its creatures and finishes the tick.
// Each thread also does memory and motion of its own creatures and looks up what each touches (the part of the tick that
// touches only one creature), so the coordinator is left with the order-dependent shared phase and the copies.
// Helpers see exactly what Ecosystem.sensePhase sees, so results are identical.
// The packet is a plain buffer, so it travels by postMessage (one copy per helper) or lives in a SharedArrayBuffer.

const DIED = 3; // delta record: DIED, id
const BORN = 4; // delta record: BORN, id, owner, species, rayCount, raySpread, rayLength, memoryShort, memoryLong, hidden layers, ...sizes, genome length, ...genome

// Header slots (Int32).
const H_COUNT = 0;
const H_CREATURE_CAP = 1;
const H_MEMORY_CAP = 2;
const H_DELTA_CAP = 3;
const H_DELTA_LENGTH = 4;
const HEADER_BYTES = 64;

export interface Caps {
  creatures: number;
  memory: number; // memory units of all creatures
  delta: number; // Float64 words of changes
}

// Typed views over one packet buffer. Outputs come last, so the bytes before outputAt are the published state.
export interface Packet {
  buffer: ArrayBufferLike;
  caps: Caps;
  header: Int32Array;
  ids: Int32Array;
  owner: Int32Array; // helper that thinks for creature i
  species: Int32Array;
  memoryAt: Int32Array; // creature i's memory units are memory[memoryAt[i] .. memoryAt[i + 1] - 1]
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
  memory: Float64Array;
  delta: Float64Array;
  // Outputs of the thread that owns creature i: its state after memory and motion, the new memory (laid out like memory)
  // and the item it touches there (-1 for none).
  after: Record<"x" | "y" | "vx" | "vy" | "turnRate" | "energy" | "angle" | "cos" | "sin", Float64Array>;
  memoryOut: Float64Array;
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
  const ints = HEADER_BYTES + 4 * (4 * caps.creatures + 1);
  const f64At = Math.ceil(ints / 8) * 8;
  const outputAt = f64At + 8 * (10 * caps.creatures + caps.memory + caps.delta);
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
  } else caps = { creatures: header[H_CREATURE_CAP]!, memory: header[H_MEMORY_CAP]!, delta: header[H_DELTA_CAP]! };
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
    ids: new Int32Array(buffer, HEADER_BYTES, C),
    owner: new Int32Array(buffer, HEADER_BYTES + 4 * C, C),
    species: new Int32Array(buffer, HEADER_BYTES + 8 * C, C),
    memoryAt: new Int32Array(buffer, HEADER_BYTES + 12 * C, C + 1),
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
    memory: f64(caps.memory),
    delta: f64(caps.delta),
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

// Caps covering need with room to grow, or null when have already fits. The delta cap also shrinks once far too big
// (after the first packet, which carries every founder's genome), since in fork-join each tick moves whole buffers.
export function fittedCaps(have: Caps | null, need: Caps): Caps | null {
  const oversized = have !== null && have.delta > 4 * need.delta + 65536;
  if (have && need.creatures <= have.creatures && need.memory <= have.memory && need.delta <= have.delta && !oversized) return null;
  const up = (n: number, h: number): number => (have && n <= h ? h : Math.ceil(n * 1.5) + 64);
  const delta = oversized ? Math.ceil(need.delta * 1.5) + 4096 : up(need.delta, have?.delta ?? 0);
  return { creatures: up(need.creatures, have?.creatures ?? 0), memory: up(need.memory, have?.memory ?? 0), delta };
}

// Coordinator side: assigns each new creature to the least loaded thread, writes packets and reads the outputs back.
// Owner index helpers stands for the coordinator itself.
export class ShareCoordinator {
  readonly helpers: number;
  private readonly ownerOf = new Map<number, number>();
  private readonly costOf = new Map<number, number>();
  private readonly load: Float64Array;
  private readonly batch = new SenseBatch();
  private advanced = false; // senseOwn has moved the own creatures since the last publish

  constructor(helpers: number) {
    this.helpers = helpers;
    this.load = new Float64Array(helpers + 1);
  }

  // Sizes the next packet needs; eco must have been built with the journal option.
  need(eco: Ecosystem): Caps {
    const j = eco.journal!;
    let memory = 0;
    for (const m of eco.members) memory += m.creature.memory.length;
    let delta = j.items.length + 2 * j.died.length;
    for (const id of j.born) {
      const c = eco.get(id)?.creature;
      if (c) delta += 11 + c.plan.hiddenLayers.length + c.brain.genome.length;
    }
    return { creatures: eco.population, memory, delta };
  }

  // Writes the tick-start state and drains the journal into p, whose caps must cover need(eco).
  publish(eco: Ecosystem, p: Packet): void {
    this.advanced = false;
    const j = eco.journal!;
    const d = p.delta;
    let k = 0;
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
      for (let g = 0; g < genome.length; g++) d[k++] = genome[g]!;
    }
    eco.drainJournal();
    p.header[H_DELTA_LENGTH] = k;

    const members = eco.members;
    const n = members.length;
    p.header[H_COUNT] = n;
    let at = 0;
    for (let i = 0; i < n; i++) {
      const m = members[i]!;
      const c = m.creature;
      const s = c.state;
      p.ids[i] = m.id;
      p.owner[i] = this.ownerOf.get(m.id)!;
      p.species[i] = m.species;
      p.memoryAt[i] = at;
      writeState(c, p, i);
      p.ticks[i] = s.ticksAlive;
      const memory = c.memory;
      for (let u = 0; u < memory.length; u++) p.memory[at + u] = memory[u]!;
      at += memory.length;
    }
    p.memoryAt[n] = at;
  }

  // Senses and thinks for the coordinator's own share, after eco.prepareTick; watch: id of a creature to sense even when
  // a helper owns it (same outputs), so its rays and brain inputs are current on this thread, or null.
  senseOwn(eco: Ecosystem, p: Packet, watch: number | null): void {
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
      c.setMemory(p.memory, p.memoryAt[i]!);
    }
  }

  // Copies the results for creatures a helper owns from that helper's packet; home is the published one, packets[h] is
  // helper h's (all home when shared). Leaves what every creature touches in home.touched.
  collect(eco: Ecosystem, home: Packet, packets: readonly Packet[]): void {
    const members = eco.members;
    for (let i = 0; i < members.length; i++) {
      const owner = home.owner[i]!;
      if (owner === this.helpers) continue;
      const p = packets[owner]!;
      const c = members[i]!.creature;
      readState(c, p.after, i);
      c.setMemory(p.memoryOut, home.memoryAt[i]!);
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
  private readonly plan: BodyPlan = { rayCount: 0, raySpread: 0, rayLength: 0, hiddenLayers: [], memoryShort: 0, memoryLong: 0 };

  private readonly kernels: SenseKernels | null;
  private readonly aging: Aging | null;

  // wasm: sense and think on the WebAssembly kernels when available, as the coordinator does.
  constructor(config: EcoConfig, worldCapacity: number, index: number, wasm = false) {
    this.kernels = wasm ? SenseKernels.create() : null;
    this.engines = speciesList(config).map((sp) => speciesEngine(config, sp));
    this.spare = this.engines.map(() => []);
    this.index = index;
    this.aging = agingOf(config.eco, config.dt);
    this.world = new World(config, worldCapacity);
    this.crowd = new Crowd(config);
  }

  // Creatures this helper thinks for.
  get owned(): number {
    return this.mine.size;
  }

  // Applies p's changes, then senses and thinks for the creatures this helper owns, writing their outputs into p.
  run(p: Packet): void {
    this.apply(p.delta, p.header[H_DELTA_LENGTH]!);
    const n = p.header[H_COUNT]!;
    this.crowd.rebuildFrom(p.x, p.y, p.energy, n, p.species);
    const batch = this.batch;
    batch.clear();
    for (let i = 0; i < n; i++) {
      if (p.owner[i] !== this.index) continue;
      const c = this.mine.get(p.ids[i]!)!;
      readState(c, p, i);
      c.state.ticksAlive = p.ticks[i]!;
      c.setMemory(p.memory, p.memoryAt[i]!);
      batch.add(c, i);
    }
    senseThinkBatch(this.world, this.crowd, batch, this.kernels);
    const a = p.after;
    for (let k = 0; k < batch.count; k++) {
      const i = batch.selves[k]!;
      const c = batch.creatures[k]!;
      c.remember();
      c.steer();
      p.touched[i] = c.touched(this.world);
      writeState(c, a, i);
      const memory = c.memory;
      const at = p.memoryAt[i]!;
      for (let u = 0; u < memory.length; u++) p.memoryOut[at + u] = memory[u]!;
    }
  }

  private apply(d: Float64Array, length: number): void {
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
        k = this.born(d, k);
      } else throw new Error(`bad packet record ${code}`);
    }
  }

  // Reads one birth record from d[k ..]; returns the index after it.
  private born(d: Float64Array, k: number): number {
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
    if (owner !== this.index) return k + length;
    this.genome = refit(this.genome, length);
    const genome = this.genome;
    for (let g = 0; g < length; g++) genome[g] = d[k++]!;
    let c = this.spare[species]!.pop();
    if (c) c.reset(genome, 0, 0, 0, 0, plan);
    else c = new Creature(this.engines[species]!, genome.slice(), 0, 0, 0, plan);
    c.aging = this.aging;
    this.mine.set(id, c);
    this.speciesOf.set(id, species);
    return k;
  }
}
