import { refit } from "./brain.ts";
import { Creature } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import type { EngineConfig } from "./config.ts";
import type { Ecosystem } from "./ecosystem.ts";
import type { BodyPlan } from "./sensors.ts";
import type { HitKind } from "./types.ts";
import { ITEM_REMOVE, ITEM_SET, World } from "./world.ts";

// Sense and think on helper threads. Each tick the coordinator, which owns the Ecosystem, publishes a packet:
// every creature's pose, energy and memory, plus the changes since the last packet (item changes, deaths, and births
// with their plan and genome). Each helper keeps a copy of the item world and the brains of the creatures it owns,
// runs Creature.senseThink for those and writes their outputs into the packet. The coordinator copies the outputs
// into its creatures and finishes the tick. Helpers see exactly what Ecosystem.sensePhase sees, so results are identical.
// The packet is a plain buffer, so it travels by postMessage (one copy per helper) or lives in a SharedArrayBuffer.

const DIED = 3; // delta record: DIED, id
const BORN = 4; // delta record: BORN, id, owner, rayCount, raySpread, rayLength, memoryShort, memoryLong, hidden layers, ...sizes, genome length, ...genome

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
  memoryAt: Int32Array; // creature i's memory units are memory[memoryAt[i] .. memoryAt[i + 1] - 1]
  x: Float64Array;
  y: Float64Array;
  cos: Float64Array; // heading
  sin: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  turnRate: Float64Array;
  energy: Float64Array;
  memory: Float64Array;
  delta: Float64Array;
  out: Float32Array; // turn and thrust of creature i at 2i, 2i + 1
  memoryOut: Float32Array; // memory targets, laid out like memory
  outputAt: number; // byte offset of out
}

function layout(caps: Caps): { f64At: number; outputAt: number; bytes: number } {
  const ints = HEADER_BYTES + 4 * (3 * caps.creatures + 1);
  const f64At = Math.ceil(ints / 8) * 8;
  const outputAt = f64At + 8 * (8 * caps.creatures + caps.memory + caps.delta);
  return { f64At, outputAt, bytes: outputAt + 4 * (2 * caps.creatures + caps.memory) };
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
    memoryAt: new Int32Array(buffer, HEADER_BYTES + 8 * C, C + 1),
    x: f64(C),
    y: f64(C),
    cos: f64(C),
    sin: f64(C),
    vx: f64(C),
    vy: f64(C),
    turnRate: f64(C),
    energy: f64(C),
    memory: f64(caps.memory),
    delta: f64(caps.delta),
    out: new Float32Array(buffer, outputAt, 2 * C),
    memoryOut: new Float32Array(buffer, outputAt + 8 * C, caps.memory),
    outputAt,
  };
}

// Caps covering need with room to grow, or null when have already covers it.
export function grownCaps(have: Caps | null, need: Caps): Caps | null {
  if (have && need.creatures <= have.creatures && need.memory <= have.memory && need.delta <= have.delta) return null;
  const up = (n: number, h: number): number => (have && n <= h ? h : Math.ceil(n * 1.5) + 64);
  return { creatures: up(need.creatures, have?.creatures ?? 0), memory: up(need.memory, have?.memory ?? 0), delta: up(need.delta, have?.delta ?? 0) };
}

// Coordinator side: assigns each new creature to the least loaded helper, writes packets and reads the outputs back.
export class ShareCoordinator {
  readonly helpers: number;
  private readonly ownerOf = new Map<number, number>();
  private readonly costOf = new Map<number, number>();
  private readonly load: Float64Array;

  constructor(helpers: number) {
    this.helpers = helpers;
    this.load = new Float64Array(helpers);
  }

  // Sizes the next packet needs; eco must have been built with the journal option.
  need(eco: Ecosystem): Caps {
    const j = eco.journal!;
    let memory = 0;
    for (const m of eco.members) memory += m.creature.memory.length;
    let delta = j.items.length + 2 * j.died.length;
    for (const id of j.born) {
      const c = eco.get(id)?.creature;
      if (c) delta += 10 + c.plan.hiddenLayers.length + c.brain.genome.length;
    }
    return { creatures: eco.population, memory, delta };
  }

  // Writes the tick-start state and drains the journal into p, whose caps must cover need(eco).
  publish(eco: Ecosystem, p: Packet): void {
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
      const c = eco.get(id)?.creature;
      if (!c) continue; // born and died since the last packet
      const genome = c.brain.genome;
      const plan = c.plan;
      let owner = 0;
      for (let h = 1; h < this.helpers; h++) if (this.load[h]! < this.load[owner]!) owner = h;
      const cost = genome.length + 30 * plan.rayCount; // rough relative work of one creature
      this.load[owner] += cost;
      this.ownerOf.set(id, owner);
      this.costOf.set(id, cost);
      d[k++] = BORN;
      d[k++] = id;
      d[k++] = owner;
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
    items.length = j.died.length = j.born.length = 0;
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
      p.memoryAt[i] = at;
      p.x[i] = s.x;
      p.y[i] = s.y;
      p.cos[i] = c.heading.cos;
      p.sin[i] = c.heading.sin;
      p.vx[i] = s.vx;
      p.vy[i] = s.vy;
      p.turnRate[i] = s.turnRate;
      p.energy[i] = s.energy;
      const memory = c.memory;
      for (let u = 0; u < memory.length; u++) p.memory[at + u] = memory[u]!;
      at += memory.length;
    }
    p.memoryAt[n] = at;
  }

  // Copies each creature's outputs from the packet of the helper that owns it; packets[h] is helper h's (all the same when shared).
  collect(eco: Ecosystem, packets: readonly Packet[]): void {
    const members = eco.members;
    const first = packets[0]!;
    for (let i = 0; i < members.length; i++) {
      const p = packets[first.owner[i]!]!;
      const out = members[i]!.creature.outputs;
      out[0] = p.out[2 * i]!;
      out[1] = p.out[2 * i + 1]!;
      const at = first.memoryAt[i]!;
      for (let u = 2; u < out.length; u++) out[u] = p.memoryOut[at + u - 2]!;
    }
  }
}

// Helper side: a copy of the item world and the creatures this helper owns, kept in step by the packets.
export class ShareHelper {
  readonly index: number;
  private readonly config: EngineConfig;
  private readonly world: World;
  private readonly crowd: Crowd;
  private readonly mine = new Map<number, Creature>();
  private readonly spare: Creature[] = [];
  private genome = new Float32Array(0);
  private readonly plan: BodyPlan = { rayCount: 0, raySpread: 0, rayLength: 0, hiddenLayers: [], memoryShort: 0, memoryLong: 0 };

  constructor(config: EngineConfig, worldCapacity: number, index: number) {
    this.config = config;
    this.index = index;
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
    this.crowd.rebuildFrom(p.x, p.y, p.energy, n);
    for (let i = 0; i < n; i++) {
      if (p.owner[i] !== this.index) continue;
      const c = this.mine.get(p.ids[i]!)!;
      const s = c.state;
      s.x = p.x[i]!;
      s.y = p.y[i]!;
      s.vx = p.vx[i]!;
      s.vy = p.vy[i]!;
      s.turnRate = p.turnRate[i]!;
      s.energy = p.energy[i]!;
      c.heading.cos = p.cos[i]!;
      c.heading.sin = p.sin[i]!;
      const at = p.memoryAt[i]!;
      c.setMemory(p.memory, at);
      c.senseThink(this.world, this.crowd, i);
      const out = c.outputs;
      p.out[2 * i] = out[0]!;
      p.out[2 * i + 1] = out[1]!;
      for (let u = 2; u < out.length; u++) p.memoryOut[at + u - 2] = out[u]!;
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
          this.spare.push(c);
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
    let c = this.spare.pop();
    if (c) c.reset(genome, 0, 0, 0, 0, plan);
    else c = new Creature(this.config, genome.slice(), 0, 0, 0, plan);
    this.mine.set(id, c);
    return k;
  }
}
