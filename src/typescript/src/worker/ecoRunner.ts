import type { EcoConfig } from "../sim/ecoConfig.ts";
import { Ecosystem } from "../sim/ecosystem.ts";
import type { CreatureFrame } from "../sim/ecosystem.ts";
import type { EcoInMessage, EcoOutMessage, EcoSnapshot, EcoSpeedSetting, SelectedDetails } from "./ecoProtocol.ts";
import { snapshotBytes, snapshotViews } from "./ecoProtocol.ts";

const SLICE_MS = 12; // longest stretch of ticks before the worker checks messages and posts
const POST_MS = 1000 / 30; // snapshot interval
const MAX_IN_FLIGHT = 3; // snapshots posted but not yet recycled, so a slow page is not flooded
const MAX_CATCH_UP = 0.25; // real seconds of ticks that can be owed after a stall
const SAMPLE_CAP = 600; // graph samples kept; at the cap every other one is dropped and sampling slows to half
const MIN_CREATURE_CAP = 256;

export type Post = (msg: EcoOutMessage, transfer: Transferable[]) => void;

// Owns one Ecosystem and paces it against the clock. The Worker wrapper calls handle for each message and pump in a timer loop.
export class EcoRunner {
  private eco: Ecosystem | null = null;
  private readonly post: Post;
  private readonly now: () => number;
  private paused = false;
  private run = 0;
  private speed: EcoSpeedSetting = 1;
  private selectedId: number | null = null;
  private sendGenome = false;
  private debt = 0; // ticks owed to the clock
  private last = 0;
  private lastPost = 0;
  private lastPostSim = 0;
  private achieved = 0;
  private inFlight = 0;
  private pool: ArrayBuffer[] = [];
  private creatureCap = MIN_CREATURE_CAP;
  private samples: number[] = []; // time, population, food per sample
  private sampleStride = 1; // sim seconds between samples
  private nextSample = 0;
  private historyChanged = false;
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
        if (this.eco) this.postSnapshot();
        break;
      case "recycle":
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.pool.length < MAX_IN_FLIGHT) this.pool.push(msg.buffer);
        break;
    }
  }

  // Runs the ticks due, posts a snapshot when one is due. Returns the delay in ms before the next call, or -1 when there is nothing to run.
  pump(): number {
    const eco = this.eco;
    if (!eco || this.paused || eco.extinct) return -1;
    const t0 = this.now();
    const dt = eco.config.dt;
    const max = this.speed === "max";
    if (!max) {
      this.debt += Math.min(MAX_CATCH_UP, Math.max(0, (t0 - this.last) / 1000)) * (this.speed as number) / dt;
      this.debt = Math.min(this.debt, (MAX_CATCH_UP * (this.speed as number)) / dt);
    }
    this.last = t0;
    while (!eco.extinct && (max || this.debt >= 1)) {
      eco.step();
      this.debt--;
      this.sampleIfDue(eco);
      if (this.now() - t0 >= SLICE_MS) break;
    }
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
    this.eco = new Ecosystem(config);
    this.run = run;
    this.inFlight = 0;
    this.paused = false;
    this.selectedId = null;
    this.debt = 0;
    this.achieved = 0;
    this.samples = [];
    this.sampleStride = 1;
    this.nextSample = 0;
    this.rayScratch = null;
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
    this.nextSample = time + this.sampleStride;
    this.historyChanged = true;
    if (this.samples.length >= 3 * SAMPLE_CAP) {
      const kept: number[] = [];
      for (let i = 0; i < this.samples.length; i += 6) kept.push(this.samples[i]!, this.samples[i + 1]!, this.samples[i + 2]!);
      this.samples = kept;
      this.sampleStride *= 2;
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
    const frame: CreatureFrame = { count: 0, ids: v.ids, x: v.x, y: v.y, heading: v.heading, energy: v.energy, hue: v.hue };
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
      count: n,
      itemCount: items,
      creatureCap,
      itemCap,
      buffer,
      selected: this.selectedDetails(eco),
    };
    if (this.historyChanged) {
      msg.history = Float64Array.from(this.samples);
      this.historyChanged = false;
    }
    this.inFlight++;
    this.post(msg, [buffer]);
  }

  private selectedDetails(eco: Ecosystem): SelectedDetails | null {
    if (this.selectedId === null) return null;
    const m = eco.get(this.selectedId);
    if (!m) {
      const s = this.rayScratch;
      return {
        id: this.selectedId, alive: false, x: 0, y: 0, heading: 0, energy: 0, age: 0, children: 0, depth: 0, parentId: -1, hue: 0,
        rayKinds: s?.rayKinds ?? new Uint8Array(0), rayCloseness: s?.rayCloseness ?? new Float32Array(0), rayEnergy: s?.rayEnergy ?? new Float32Array(0),
        rayOffsets: s?.rayOffsets ?? new Float32Array(0), inputs: s?.inputs ?? new Float32Array(0), genome: null,
      };
    }
    const c = m.creature;
    const s = c.state;
    const rays = c.rays;
    const input = c.brain.layerActivations()[0]!;
    if (!this.rayScratch || this.rayScratch.inputs.length !== input.length) {
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
    sc.inputs.set(input);
    const genome = this.sendGenome ? c.brain.genome.slice() : null;
    this.sendGenome = false;
    return {
      id: m.id, alive: true, x: s.x, y: s.y, heading: s.heading, energy: s.energy, age: m.ageTicks * eco.config.dt,
      children: m.children, depth: m.depth, parentId: m.parentId, hue: m.hue, ...sc, genome,
    };
  }
}
