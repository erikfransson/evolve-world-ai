import type { EcoConfig } from "../sim/ecoConfig.ts";
import { planOf } from "../sim/sensors.ts";
import { Ecosystem } from "../sim/ecosystem.ts";
import type { CreatureFrame, EcoCreature } from "../sim/ecosystem.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import { Leaderboard } from "../sim/leaderboard.ts";
import { traitStats } from "../sim/popStats.ts";
import type { BestBy, EcoInMessage, EcoOutMessage, EcoSnapshot, EcoSpeedSetting, SelectedDetails } from "./ecoProtocol.ts";
import { LINEAGE_STRIDE, LINEAGE_TOP, snapshotBytes, snapshotViews } from "./ecoProtocol.ts";
import type { ThinkPool } from "./ecoPool.ts";

const SLICE_MS = 12; // longest stretch of ticks before the worker checks messages and posts
const POST_MS = 1000 / 30; // snapshot interval
const MAX_IN_FLIGHT = 3; // snapshots posted but not yet recycled, so a slow page is not flooded
const MAX_CATCH_UP = 0.25; // real seconds of ticks that can be owed after a stall
const SAMPLE_CAP = 600; // graph samples kept; at the cap every other one is dropped and sampling slows to half
const MIN_CREATURE_CAP = 256;
const LINEAGE_MS = 1000; // lineages ride along with a snapshot at most this often

export type Post = (msg: EcoOutMessage, transfer: Transferable[]) => void;

// Owns one Ecosystem and paces it against the clock. The Worker wrapper calls handle for each message and pump in a timer loop.
export class EcoRunner {
  seedPool: readonly PoolEntry[] | null = null; // trained founders for the next start; null gives all-random founders
  private eco: Ecosystem | null = null;
  get ecosystem(): Ecosystem | null { return this.eco; } // read-only, for tests
  private helpers: ThinkPool | null = null;
  private starting: Promise<void> | null = null; // the helpers getting ready for the current run
  private readonly post: Post;
  private readonly now: () => number;
  private paused = false;
  private run = 0;
  private speed: EcoSpeedSetting = 1;
  private selectedId: number | null = null;
  private sendGenome = false;
  private bestRequest = 0;
  private debt = 0; // ticks owed to the clock
  private last = 0;
  private lastPost = 0;
  private lastPostSim = 0;
  private achieved = 0;
  private inFlight = 0;
  private pool: ArrayBuffer[] = [];
  private creatureCap = MIN_CREATURE_CAP;
  private samples: number[] = []; // time, population, food, then each species' population with several species, per sample
  private sampleSize = 3;
  private blocks = 1; // lineage history blocks per sample: one per species
  private sampleStride = 1; // sim seconds between samples
  private nextSample = 0;
  private historyChanged = false;
  private lineageSamples: number[] = []; // LINEAGE_STRIDE numbers per entry of samples
  private lineagePostedAt = -Infinity;
  private board = new Leaderboard();
  private rayScratch: Pick<SelectedDetails, "rayKinds" | "rayCloseness" | "rayEnergy" | "rayOffsets" | "inputs"> | null = null;

  constructor(post: Post, now: () => number = () => performance.now()) {
    this.post = post;
    this.now = now;
  }

  handle(msg: EcoInMessage): void {
    switch (msg.type) {
      case "start":
        this.begin(msg.config, msg.run);
        break;
      case "pause":
        this.paused = true;
        break;
      case "resume":
        this.paused = false;
        this.last = this.now();
        this.lastPost = this.last;
        break;
      case "reset":
        this.eco = null;
        this.selectedId = null;
        break;
      case "speed":
        this.speed = msg.speed;
        this.debt = 0;
        break;
      case "select":
        this.selectedId = msg.id;
        this.sendGenome = msg.id !== null;
        this.refreshDetail();
        if (this.eco) this.postSnapshot();
        break;
      case "selectBest": {
        const best = this.eco ? this.best(this.eco, msg.by) : null;
        this.bestRequest = msg.request;
        this.selectedId = best ? best.id : null;
        this.sendGenome = best !== null;
        this.refreshDetail();
        if (this.eco) this.postSnapshot();
        break;
      }
      case "recycle":
        if (msg.run === undefined || msg.run === this.run) this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.pool.length < MAX_IN_FLIGHT) this.pool.push(msg.buffer);
        break;
    }
  }

  // Runs the ticks due, posts a snapshot when one is due. Returns the delay in ms before the next call, or -1 when there is nothing to run.
  // Ticks run on this thread only; see pumpAsync for helper threads.
  pump(): number {
    const eco = this.due();
    if (!eco) return -1;
    const t0 = this.last;
    while (this.wantTick(eco)) {
      eco.step();
      if (this.ticked(eco, t0)) break;
    }
    return this.settle(eco);
  }

  // pump with the helper threads when there are any. A pool that fails, at the start or later, is dropped and the run
  // continues on this thread: a failed tick never reached finishTick, so stepping it again here gives the same result.
  async pumpAsync(): Promise<number> {
    if (this.starting) {
      try {
        await this.starting;
      } catch (error) {
        this.dropHelpers(error);
      }
      this.starting = null;
    }
    const pool = this.helpers;
    if (!pool) return this.pump();
    const eco = this.due();
    if (!eco) return -1;
    const t0 = this.last;
    pool.watch = this.selectedId;
    try {
      while (this.wantTick(eco)) {
        await pool.step(eco);
        if (this.ticked(eco, t0)) break;
      }
    } catch (error) {
      this.dropHelpers(error);
    }
    return this.settle(eco);
  }

  // Uses these helper threads from the next start on; null runs on this thread.
  useHelpers(pool: ThinkPool | null): void {
    this.helpers = pool;
  }

  private dropHelpers(error: unknown): void {
    console.warn("Helper threads failed, running on one thread:", error);
    this.helpers?.close();
    this.helpers = null;
    this.eco?.dropJournal();
  }

  // The ecosystem when ticks may run now, after adding the ticks the clock owes.
  private due(): Ecosystem | null {
    const eco = this.eco;
    if (!eco || this.paused || eco.extinct) return null;
    const t0 = this.now();
    if (this.speed !== "max") {
      this.debt += Math.min(MAX_CATCH_UP, Math.max(0, (t0 - this.last) / 1000)) * this.speed / eco.config.dt;
      this.debt = Math.min(this.debt, (MAX_CATCH_UP * this.speed) / eco.config.dt);
    }
    this.last = t0;
    eco.detail = this.selectedId;
    return eco;
  }

  private wantTick(eco: Ecosystem): boolean {
    return eco === this.eco && !eco.extinct && (this.speed === "max" || this.debt >= 1);
  }

  // Bookkeeping after one tick; true when the slice that began at t0 is used up.
  private ticked(eco: Ecosystem, t0: number): boolean {
    this.debt--;
    this.sampleIfDue(eco);
    return this.now() - t0 >= SLICE_MS;
  }

  // Posts what is due after a slice; returns pump's delay.
  private settle(eco: Ecosystem): number {
    if (eco !== this.eco) return 0;
    const dt = eco.config.dt;
    const max = this.speed === "max";
    const t1 = this.now();
    if (eco.extinct) {
      this.sampleIfDue(eco, true);
      this.postSnapshot();
      return -1;
    }
    if (t1 - this.lastPost >= POST_MS && this.inFlight < MAX_IN_FLIGHT) this.postSnapshot();
    if (max || this.debt >= 1) return 0;
    const wait = ((1 - this.debt) * dt * 1000) / (this.speed as number);
    return Math.min(10, Math.max(1, wait));
  }

  private begin(config: EcoConfig, run: number): void {
    this.eco = new Ecosystem(config, this.seedPool, { journal: this.helpers !== null });
    this.starting = this.helpers?.start(this.eco) ?? null;
    this.starting?.catch(() => {}); // handled by the next pumpAsync
    this.run = run;
    this.inFlight = 0;
    this.paused = false;
    this.selectedId = null;
    this.debt = 0;
    this.achieved = 0;
    this.samples = [];
    const species = this.eco.species.length;
    this.blocks = species;
    this.sampleSize = species > 1 ? 3 + species : 3;
    this.lineageSamples = [];
    this.lineagePostedAt = -Infinity;
    this.sampleStride = 1;
    this.nextSample = 0;
    this.rayScratch = null;
    this.board = new Leaderboard();
    this.eco.onDeath = (m) => this.offerRecord(this.eco!, m, false);
    this.last = this.lastPost = this.now();
    this.lastPostSim = 0;
    this.sampleIfDue(this.eco);
    this.postSnapshot();
  }

  // Records a graph sample every sampleStride simulated seconds; force adds the current state regardless (the last one of a run).
  private sampleIfDue(eco: Ecosystem, force = false): void {
    const time = eco.tick * eco.config.dt;
    if (!force && time < this.nextSample) return;
    this.samples.push(time, eco.population, eco.food);
    if (this.blocks > 1) for (const c of eco.speciesCounts) this.samples.push(c.population);
    if (this.blocks > 1) for (let s = 0; s < this.blocks; s++) this.pushLineageSample(eco, time, s);
    else this.pushLineageSample(eco, time, -1);
    this.nextSample = time + this.sampleStride;
    this.historyChanged = true;
    const size = this.sampleSize;
    if (this.samples.length >= size * SAMPLE_CAP) {
      const kept: number[] = [];
      for (let i = 0; i < this.samples.length; i += 2 * size) for (let k = 0; k < size; k++) kept.push(this.samples[i + k]!);
      this.samples = kept;
      const block = LINEAGE_STRIDE * this.blocks;
      const keptLineage: number[] = [];
      for (let i = 0; i < this.lineageSamples.length; i += 2 * block) for (let k = 0; k < block; k++) keptLineage.push(this.lineageSamples[i + k]!);
      this.lineageSamples = keptLineage;
      this.sampleStride *= 2;
    }
  }

  // One lineage block: of one species, or of all creatures (-1).
  private pushLineageSample(eco: Ecosystem, time: number, species: number): void {
    const top = eco.topLineages(LINEAGE_TOP, species);
    let inTop = 0;
    for (const l of top) inTop += l.count;
    const out = this.lineageSamples;
    out.push(time, (species < 0 ? eco.population : eco.speciesCounts[species]!.population) - inTop);
    for (let k = 0; k < LINEAGE_TOP; k++) {
      const l = top[k];
      out.push(l ? l.founder : -1, l ? l.count : 0, l ? l.hue : 0);
    }
  }

  private takeBuffer(creatureCap: number, itemCap: number): ArrayBuffer {
    const need = snapshotBytes(creatureCap, itemCap);
    while (this.pool.length > 0) {
      const b = this.pool.pop()!;
      if (b.byteLength >= need && b.byteLength > 0) return b;
    }
    return new ArrayBuffer(need);
  }

  private postSnapshot(): void {
    const eco = this.eco;
    if (!eco) return;
    const n = eco.population;
    const itemCap = eco.world.count;
    this.creatureCap = Math.max(this.creatureCap, Math.ceil(n * 1.25));
    const creatureCap = this.creatureCap;
    const buffer = this.takeBuffer(creatureCap, itemCap);
    const v = snapshotViews(buffer, n, 0, creatureCap, itemCap);
    // The frame's arrays are views into the buffer, so readCreatures writes straight into the message.
    const frame: CreatureFrame = { count: 0, ids: v.ids, x: v.x, y: v.y, heading: v.heading, energy: v.energy, hue: v.hue, founder: v.founder, species: v.species };
    eco.readCreatures(frame);
    const dt = eco.config.dt;
    let oldest = 0;
    for (let i = 0; i < n; i++) {
      const m = eco.members[i]!;
      v.age[i] = m.ageTicks * dt;
      if (m.depth > oldest) oldest = m.depth;
    }
    const w = eco.world;
    let items = 0;
    for (let i = 0; i < itemCap; i++) {
      const kind = w.kinds[i]!;
      if (kind === 0) continue;
      v.itemX[items] = w.xs[i]!;
      v.itemY[items] = w.ys[i]!;
      v.itemKind[items++] = kind;
    }

    const now = this.now();
    const simTime = eco.tick * dt;
    const realSeconds = (now - this.lastPost) / 1000;
    if (realSeconds > 0.005 && !eco.extinct) {
      const rate = (simTime - this.lastPostSim) / realSeconds;
      this.achieved = this.achieved === 0 ? rate : 0.7 * this.achieved + 0.3 * rate;
    }
    this.lastPost = now;
    this.lastPostSim = simTime;

    const msg: EcoSnapshot = {
      type: "snapshot",
      run: this.run,
      tick: eco.tick,
      simTime,
      population: n,
      births: eco.births,
      deaths: eco.deaths,
      food: eco.food,
      poison: eco.poison,
      oldestDepth: oldest,
      extinct: eco.extinct,
      speed: this.achieved,
      helpers: this.helpers?.helpers ?? 0,
      sharedMemory: this.helpers?.shared ?? false,
      wasm: eco.wasm,
      count: n,
      itemCount: items,
      creatureCap,
      itemCap,
      buffer,
      selected: this.selectedDetails(eco),
      bestRequest: this.bestRequest,
    };
    if (eco.species.length > 1) msg.species = eco.speciesCounts.map((c) => ({ ...c }));
    if (this.historyChanged) {
      msg.history = Float64Array.from(this.samples);
      this.historyChanged = false;
    }
    if (now - this.lineagePostedAt >= LINEAGE_MS || eco.extinct) {
      this.lineagePostedAt = now;
      msg.lineages = this.blocks > 1 ? eco.species.flatMap((_, s) => eco.topLineages(LINEAGE_TOP, s)) : eco.topLineages(LINEAGE_TOP);
      msg.lineageHistory = Float64Array.from(this.lineageSamples);
      for (const m of eco.members) this.offerRecord(eco, m, true);
      msg.leaders = this.board.snapshot();
      msg.traits = eco.species.map((_, s) => traitStats(eco.members.filter((m) => m.species === s).map((m) => m.creature.plan)));
    }
    this.inFlight++;
    this.post(msg, [buffer]);
  }

  // Offers a creature's records to the leaderboard: while alive each second, and once more when it dies.
  private offerRecord(eco: Ecosystem, m: EcoCreature, alive: boolean): void {
    const dt = eco.config.dt;
    const sp = eco.species[m.species]!;
    const now = eco.tick * dt;
    const build = () => ({ id: m.id, species: m.species, hue: m.hue, from: m.birthTick * dt, plan: { ...m.creature.plan, hiddenLayers: m.creature.plan.hiddenLayers.slice() } });
    this.board.offer("age", m.species, m.id, m.ageTicks * dt, now, alive, build);
    this.board.offer("children", m.species, m.id, m.children, now, alive, build);
    if (sp.plants) this.board.offer("eaten", m.species, m.id, m.eaten, now, alive, build);
    if (sp.prey.length > 0) this.board.offer("kills", m.species, m.id, m.kills, now, alive, build);
  }

  // Scans on demand only. Ties go to the lowest id so the pick does not depend on list order.
  private best(eco: Ecosystem, by: BestBy): EcoCreature | null {
    let best: EcoCreature | null = null;
    let bestValue = -1;
    for (const m of eco.members) {
      const v = by === "age" ? m.ageTicks : by === "children" ? m.children : by === "kills" ? m.kills : m.eaten;
      if (v > bestValue || (v === bestValue && m.id < best!.id)) {
        best = m;
        bestValue = v;
      }
    }
    return best;
  }

  // Makes the selected creature's rays and inputs current for the snapshot about to be posted (the WASM sense only keeps them
  // for the creature that was selected during the tick).
  private refreshDetail(): void {
    if (!this.eco) return;
    this.eco.detail = this.selectedId;
    this.eco.refreshDetail();
  }

  private selectedDetails(eco: Ecosystem): SelectedDetails | null {
    if (this.selectedId === null) return null;
    const m = eco.get(this.selectedId);
    if (!m) {
      const s = this.rayScratch;
      return {
        id: this.selectedId, alive: false, x: 0, y: 0, heading: 0, energy: 0, age: 0, children: 0, eaten: 0, kills: 0, species: 0, depth: 0, parentId: -1, hue: 0, founderId: -1, founderPool: false, founderHue: 0, plan: planOf(eco.config), upkeep: 0, drain: 0,
        rayKinds: s?.rayKinds ?? new Uint8Array(0), rayCloseness: s?.rayCloseness ?? new Float32Array(0), rayEnergy: s?.rayEnergy ?? new Float32Array(0),
        rayOffsets: s?.rayOffsets ?? new Float32Array(0), inputs: s?.inputs ?? new Float32Array(0), genome: null,
      };
    }
    const c = m.creature;
    const s = c.state;
    const rays = c.rays;
    const input = c.brain.layerActivations()[0]!;
    if (!this.rayScratch || this.rayScratch.inputs.length !== input.length || this.rayScratch.rayKinds.length !== rays.length) {
      this.rayScratch = {
        rayKinds: new Uint8Array(rays.length),
        rayCloseness: new Float32Array(rays.length),
        rayEnergy: new Float32Array(rays.length),
        rayOffsets: c.rayOffsets.slice(),
        inputs: new Float32Array(input.length),
      };
    }
    const sc = this.rayScratch;
    for (let i = 0; i < rays.length; i++) {
      sc.rayKinds[i] = rays[i]!.kind;
      sc.rayCloseness[i] = rays[i]!.closeness;
      sc.rayEnergy[i] = rays[i]!.energy;
    }
    sc.rayOffsets.set(c.rayOffsets);
    sc.inputs.set(input);
    const genome = this.sendGenome ? c.brain.genome.slice() : null;
    this.sendGenome = false;
    return {
      id: m.id, alive: true, x: s.x, y: s.y, heading: s.heading, energy: s.energy, age: m.ageTicks * eco.config.dt,
      children: m.children, eaten: m.eaten, kills: m.kills, species: m.species, depth: m.depth, parentId: m.parentId, hue: m.hue, founderId: m.founderId, founderPool: eco.fromPool(m.founderId), founderHue: eco.founderColour(m.founderId), plan: { ...c.plan, hiddenLayers: c.plan.hiddenLayers.slice() }, upkeep: c.upkeep, drain: c.drain, ...sc, genome,
    };
  }
}
