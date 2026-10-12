import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { CreatureFrame as EngineFrame } from "../../src/typescript/src/sim/ecosystem.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { PoolEntry } from "../../src/typescript/src/sim/seedPool.ts";
import { MAX_DELTA_EVENTS, MAX_DELTA_OPS, MAX_ITEM_SLOTS, PROTOCOL_VERSION, encodeCreatures, encodeDeltaChunk, encodeItems, itemsBytes } from "../../src/typescript/src/live/protocol.ts";
import type { Hello, ItemOp, Stats, WireEvent } from "../../src/typescript/src/live/protocol.ts";
import { encodeDetail, encodeGenome } from "../../src/typescript/src/live/detail.ts";
import { ITEM_REMOVE, ITEM_SET } from "../../src/typescript/src/sim/world.ts";
import type { World } from "../../src/typescript/src/sim/world.ts";
import { EVENT_STRIDE } from "../../src/typescript/src/sim/ecosystem.ts";
import { TokenBucket } from "./budget.ts";
import { Chronicle } from "./chronicle.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { ITEM_HEADROOM, LIMITS, LIVE, MAX_POPULATION } from "./config.ts";
import type { AddRequest, AddRules } from "../../src/typescript/src/live/add.ts";
import { fullEnergy } from "../../src/typescript/src/sim/species.ts";
import type { ThinkPool } from "../../src/typescript/src/worker/ecoPool.ts";

// The selected creature's rays and brain input as of one tick.
interface Capture {
  tick: number;
  kinds: Uint8Array;
  closeness: Float32Array;
  offsets: Float32Array;
  inputs: Float32Array;
}

// The shared world: one Ecosystem stepped against the clock, on this thread or with helper threads that sense and think.
// With helpers a tick awaits them, so everything else that reads or changes the world goes through whenIdle, between ticks.
export class LiveWorld {
  eco: Ecosystem;
  private owed = 0; // ticks due but not yet run
  private lastAt = performance.now();
  private frame: EngineFrame | undefined;
  private ages = new Float32Array(0);
  private speedTicks = 0;
  private speedSince = performance.now();
  paused = false; // admin pause: no ticks run and no time is owed afterwards
  speed = 0; // simulated seconds per real second achieved, over the last second (below LIVE.speed when the machine cannot keep up)
  readonly startedAt = Date.now();
  private restarts = 0;
  failedTicks = 0; // consecutive ticks that threw; a world that keeps failing is not saved (saves.ts) and the server exits (main.ts)
  onReseed: (() => void) | null = null; // the world was replaced, viewers need a fresh hello

  private readonly pool: readonly PoolEntry[] | null;
  private helpers: ThinkPool | null;
  private starting: Promise<void> | null = null; // the helpers getting ready for the current world
  private inFlight = false; // a tick is waiting for the helpers
  private pending: (() => void)[] = []; // work waiting for the tick in flight to end
  private readAt = 0; // records of the journal's item log already collected
  // Item changes since the last frame, from the engine's item log (World.log), with the tick they happened at.
  private itemLog: number[] = [];
  private ops: ItemOp[] = [];
  private opsOverflow = false;
  // Selected creatures: how many viewers watch each id, and its rays and inputs from the last tick it was the engine's detail creature.
  private readonly watched = new Map<number, number>();
  private readonly captures = new Map<number, Capture>();
  private readonly refreshes: TokenBucket;
  readonly chronicle = new Chronicle();
  private added = new Set<number>(); // ids of visitor-added creatures that may still live (pruned in aliveAdded)

  // helpers: a pool of helper threads, owned from here on (close() closes it), or null to run on this thread.
  constructor(config: EcoConfig, pool: readonly PoolEntry[] | null, helpers: ThinkPool | null = null) {
    this.pool = pool;
    this.helpers = helpers;
    this.eco = this.build(config);
    this.refreshes = new TokenBucket(LIMITS.detailRefreshesPerSecond, LIMITS.detailRefreshesPerSecond);
    this.attach();
  }

  // Hooks the running world: its item log and the chronicle. Every item change goes through World.setItem or removeItem, which log.
  private attach(): void {
    if (this.eco.world.count > MAX_ITEM_SLOTS) throw new Error("the world has more item slots than the wire carries");
    // With helpers the engine's journal records item changes (its World.log), and the pool drains it at each tick's start.
    this.itemLog = [];
    if (!this.eco.journal) (this.eco.world as World).log = this.itemLog;
    this.readAt = 0;
    this.ops = [];
    this.opsOverflow = false;
    this.captures.clear();
    this.chronicle.reset(this.eco);
    this.eco.drainEvents();
    // Added creatures found named lineages (late rows of the lineage table, kept in saves); the living founders among them count.
    this.added = new Set(this.eco.lineageTable.toState().late.filter((r) => r[5] !== "" && this.eco.get(r[0])).map((r) => r[0]));
    if (this.helpers) {
      const starting = this.helpers.start(this.eco);
      this.starting = starting;
      starting.catch(() => {}); // handled by the next tick
    }
  }

  get threads(): number {
    return this.helpers?.helpers ?? 0;
  }

  // The helpers failed: the world goes on on this thread (a failed tick never reached finishTick, so stepping it again gives the same result).
  private dropHelpers(error: unknown): void {
    console.warn(`helper threads failed, running on one thread: ${error instanceof Error ? error.message : error}`);
    this.helpers?.close();
    this.helpers = null;
    this.starting = null;
    this.eco.dropJournal();
    (this.eco.world as World).log = this.itemLog;
    this.itemLog.length = 0;
    this.readAt = 0;
    this.opsOverflow = true; // changes may have been missed: viewers get the full set
  }

  // Runs fn between ticks: now when no tick waits for the helpers, else right after it. Everything that reads or changes the world
  // from outside the tick loop (frames, stats, details, saves, admin changes) goes through here.
  whenIdle<T>(fn: () => T): Promise<T> {
    if (!this.inFlight) {
      try {
        return Promise.resolve(fn());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return new Promise<T>((resolve, reject) => this.pending.push(() => {
      try {
        resolve(fn());
      } catch (e) {
        reject(e);
      }
    }));
  }

  close(): void {
    this.helpers?.close();
    this.helpers = null;
  }

  // Moves the logged item changes of the tick just run into ops, up to MAX_DELTA_OPS a frame (past that the frame goes out as a full item set).
  private collectOps(): void {
    const journal = this.eco.journal;
    const log = journal ? journal.items : this.itemLog;
    const tick = this.eco.tick;
    for (let i = journal ? this.readAt : 0; i < log.length; ) {
      const kind = log[i]!;
      const set = kind === ITEM_SET;
      if (!this.opsOverflow) {
        if (this.ops.length >= MAX_DELTA_OPS) this.opsOverflow = true;
        else if (set) this.ops.push({ slot: log[i + 1]!, kind: log[i + 4]!, x: log[i + 2]!, y: log[i + 3]!, tick });
        else if (kind === ITEM_REMOVE) this.ops.push({ slot: log[i + 1]!, kind: 0, x: 0, y: 0, tick });
      }
      i += set ? 5 : kind === ITEM_REMOVE ? 2 : log.length; // an unknown record ends the scan
    }
    if (journal) this.readAt = log.length; // the pool empties it
    else log.length = 0;
  }

  // This frame's item changes and collision events as a delta chunk, or null when the frame changed too much (viewers get a full set).
  takeDelta(): Uint8Array | null {
    const e = this.eco;
    const raw = e.drainEvents();
    const events: WireEvent[] = [];
    if (raw) for (let i = 0; i + EVENT_STRIDE <= raw.length && events.length < MAX_DELTA_EVENTS; i += EVENT_STRIDE) events.push({ kind: raw[i]!, x: raw[i + 1]!, y: raw[i + 2]!, value: raw[i + 3]! });
    const chunk = this.opsOverflow ? null : encodeDeltaChunk(e.tick, this.ops, events, this.config.world);
    this.ops = [];
    this.opsOverflow = false;
    return chunk;
  }

  // A viewer selected (or let go of) a creature.
  watch(id: number): void {
    this.watched.set(id, (this.watched.get(id) ?? 0) + 1);
  }

  unwatch(id: number): void {
    const n = (this.watched.get(id) ?? 0) - 1;
    if (n > 0) this.watched.set(id, n);
    else {
      this.watched.delete(id);
      this.captures.delete(id);
    }
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  // Brings the watched creatures' rays and brain inputs up to this tick, those seen longest ago first, as far as the refresh
  // allowance goes (one sense each, about 0.15 ms at 1000 creatures). Called once a frame, before the details are read.
  refreshWatched(): void {
    const e = this.eco;
    const due = [...this.watched.keys()].filter((id) => (this.captures.get(id)?.tick ?? -1) < e.tick && e.get(id));
    due.sort((a, b) => (this.captures.get(a)?.tick ?? -1) - (this.captures.get(b)?.tick ?? -1));
    for (const id of due) {
      if (!this.refreshes.take(1)) break;
      e.detail = id;
      e.refreshDetail();
      this.capture(id);
    }
    e.detail = null;
  }

  private capture(id: number): Capture | null {
    const m = this.eco.get(id);
    if (!m) return null;
    const c = m.creature;
    const rays = c.rays;
    const input = c.brain.layerActivations()[0]!;
    let cap = this.captures.get(id);
    if (!cap || cap.kinds.length !== rays.length || cap.inputs.length !== input.length) {
      cap = { tick: 0, kinds: new Uint8Array(rays.length), closeness: new Float32Array(rays.length), offsets: new Float32Array(rays.length), inputs: new Float32Array(input.length) };
      this.captures.set(id, cap);
    }
    cap.tick = this.eco.tick;
    for (let i = 0; i < rays.length; i++) {
      cap.kinds[i] = rays[i]!.kind;
      cap.closeness[i] = rays[i]!.closeness;
    }
    cap.offsets.set(c.rayOffsets);
    cap.inputs.set(input);
    return cap;
  }

  // The DETAIL message of a watched creature now, a "died" one when it is gone, or null when its rays are not known yet
  // (refreshWatched has not reached it).
  detail(id: number): Uint8Array | null {
    const e = this.eco;
    const m = e.get(id);
    if (!m) return encodeDetail(e.tick, id, null);
    const cap = this.captures.get(id);
    if (!cap) return null;
    const c = m.creature;
    const s = c.state;
    return encodeDetail(e.tick, id, {
      x: s.x, y: s.y, heading: s.heading, energy: s.energy, age: m.ageTicks * this.config.dt, children: m.children, eaten: m.eaten, depth: m.depth, parentId: m.parentId,
      founderId: m.founderId, founderPool: e.lineages.fromPool(m.founderId), founderName: e.lineageName(m.founderId), founderHue: e.lineages.colour(m.founderId), hue: m.hue, upkeep: c.upkeep, drain: c.drain,
      birthEnergy: m.birth.energy, birthCost: m.birth.cost, birthCooldown: m.birth.cooldown, plan: c.plan, rayKinds: cap.kinds, rayCloseness: cap.closeness, rayOffsets: cap.offsets, inputs: cap.inputs,
    });
  }

  // The GENOME message of a living creature, or null.
  genome(id: number): Uint8Array | null {
    const m = this.eco.get(id);
    return m ? encodeGenome(id, m.creature.brain.genome) : null;
  }

  // The settings of the running world: a restored world brings its own object, so never keep a reference.
  get config(): EcoConfig {
    return this.eco.config;
  }

  // Item slots are sized from the caps at construction, so build with room (ITEM_HEADROOM) and then retune to the caps in force.
  private build(config: EcoConfig): Ecosystem {
    const caps = { foodMaxDensity: config.eco.foodMaxDensity, poisonMaxDensity: config.eco.poisonMaxDensity };
    config.eco.foodMaxDensity = Math.max(caps.foodMaxDensity, ITEM_HEADROOM.foodMaxDensity);
    config.eco.poisonMaxDensity = Math.max(caps.poisonMaxDensity, ITEM_HEADROOM.poisonMaxDensity);
    const eco = new Ecosystem(config, this.pool, { journal: this.helpers !== null });
    const r = eco.retune({ eco: caps });
    if (!r.ok) throw new Error(`cannot set the item caps: ${r.reason}`);
    return eco;
  }

  get world(): { width: number; height: number } {
    return this.config.world;
  }

  // Runs the ticks that are due, at most sliceMs of work. Returns milliseconds until the next tick is due, 0 when behind.
  async advance(): Promise<number> {
    const dtMs = this.config.dt * 1000;
    const now = performance.now();
    if (this.paused) {
      this.lastAt = now;
      this.speed = 0;
      this.speedTicks = 0;
      this.speedSince = now;
      return 100;
    }
    this.owed = Math.min(this.owed + ((now - this.lastAt) / dtMs) * LIVE.speed, LIMITS.maxCatchUpS / this.config.dt);
    this.lastAt = now;
    const stop = now + LIMITS.sliceMs;
    while (this.owed >= 1 && performance.now() < stop) {
      await this.tick();
      this.owed--;
      this.speedTicks++;
    }
    const t = performance.now();
    if (t - this.speedSince >= 1000) {
      this.speed = (this.speedTicks * this.config.dt * 1000) / (t - this.speedSince);
      this.speedTicks = 0;
      this.speedSince = t;
    }
    return this.owed >= 1 ? 0 : Math.max(1, ((1 - this.owed) * dtMs) / LIVE.speed);
  }

  // One tick on this thread, for tests and tools; the server's loop uses advance.
  step(): void {
    if (this.helpers) throw new Error("step runs without helpers only");
    if (this.eco.extinct) this.reseed();
    this.eco.detail = null; // with a detail creature the WebAssembly sense costs several times more
    this.eco.step();
    this.collectOps();
  }

  // One tick, with the helpers when there are any, and the item changes recorded. Work queued by whenIdle runs after it.
  async tick(): Promise<void> {
    try {
      if (this.eco.extinct) this.reseed();
      this.eco.detail = null;
      const eco = this.eco;
      if (this.helpers && this.starting) {
        const s = this.starting;
        try {
          await s;
          if (this.starting === s) this.starting = null; // a restore during the wait started the helpers again: keep that start
        } catch (e) {
          this.dropHelpers(e);
        }
      }
      if (this.helpers && eco === this.eco) {
        this.collectOps(); // changes made between ticks, before the pool empties the journal
        this.readAt = 0;
        this.inFlight = true;
        try {
          await this.helpers.step(eco);
        } catch (e) {
          this.dropHelpers(e);
          eco.step();
        } finally {
          this.inFlight = false;
        }
      } else eco.step();
      this.collectOps();
      this.failedTicks = 0;
    } catch (e) {
      this.failedTicks++;
      throw e;
    } finally {
      // Outside work runs even after a failed tick, so it is never stranded.
      const work = this.pending;
      this.pending = [];
      for (const fn of work) fn();
    }
  }

  // An extinct world starts over with a new seed, so visitors never watch an empty board.
  private reseed(): void {
    this.config.seed += 1;
    this.restarts++;
    this.eco = this.build(this.config);
    this.attach();
    console.log(`world extinct, restarted with seed ${this.config.seed} (restart ${this.restarts})`);
    this.onReseed?.();
  }

  hello(maxViewers: number): Hello {
    const { world, creature, eco } = this.config;
    return {
      t: "hello",
      version: PROTOCOL_VERSION,
      world: { width: world.width, height: world.height },
      radius: creature.radius,
      itemRadius: world.itemRadius,
      fullEnergy: fullEnergy(eco),
      frameHz: 5,
      dt: this.config.dt,
      itemSlots: this.eco.world.count,
      summary: { initialPopulation: eco.initialPopulation, maxPopulation: eco.maxPopulation, collisionDamage: eco.collisionDamage, seasons: eco.seasons },
      maxViewers,
      add: LIVE.add.perWindow > 0 && LIVE.add.aliveShare > 0 ? this.addRules() : null,
    };
  }

  // records: add the records this time (they are the biggest part, so they go out less often).
  stats(viewers: number, records = false): Stats {
    const e = this.eco;
    const { seasons, yearMinutes, winterFood } = this.config.eco;
    const s: Stats = {
      t: "stats",
      tick: e.tick,
      simSeconds: Math.round(e.tick * this.config.dt),
      speed: Math.round(this.speed * 100) / 100,
      population: e.population,
      births: e.births,
      deaths: e.deaths,
      food: e.food,
      poison: e.poison,
      viewers,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      depth: 0,
      season: seasons ? { yearMinutes, winterFood } : null,
      best: null,
    };
    this.chronicle.observe(e, s, records);
    return s;
  }

  creatureFrame(): Uint8Array {
    const e = this.eco;
    const f = (this.frame = e.readCreatures(this.frame));
    if (this.ages.length < f.count) this.ages = new Float32Array(Math.max(f.count, 2 * this.ages.length));
    for (let i = 0; i < f.count; i++) this.ages[i] = e.get(f.ids[i]!)!.ageTicks * this.config.dt;
    return encodeCreatures(e.tick, { ...f, age: this.ages, radius: this.config.creature.radius }, this.config.world, fullEnergy(this.config.eco));
  }

  // Bytes of itemsFrame() now, without encoding it.
  itemsSize(): number {
    const w = this.eco.world as World;
    return itemsBytes(w.count, w.used);
  }

  // The full item set now, at the tick of the creature frame just taken.
  itemsFrame(): Uint8Array {
    const w = this.eco.world;
    return encodeItems(this.eco.tick, { xs: w.xs, ys: w.ys, kinds: w.kinds, slots: w.count }, this.config.world);
  }

  // Visitor-added creatures alive now (the inserted ones, not their children).
  aliveAdded(): number {
    for (const id of this.added) if (!this.eco.get(id)) this.added.delete(id);
    return this.added.size;
  }

  // What an add may ask for: the world's birth trait ranges and the costs behind energy per second.
  addRules(): AddRules {
    const { eco, creature } = this.config;
    const pair = (r: number[]): [number, number] => [r[0]!, r[1]!];
    return { maxCopies: LIVE.add.maxCopies, everyS: LIVE.add.socketEveryS, birth: { energy: pair(eco.birthEnergyRange), cost: pair(eco.birthCostRange), cooldown: pair(eco.birthCooldownRange) }, costs: { living: creature.livingCost, ray: creature.rayCost, neuron: creature.neuronCost } };
  }

  // Inserts a checked add request (live/add.ts parseAdd) as `copies` founders of new named lineages at random free spots, through the
  // engine's insertCreature, so a save keeps them. Call between ticks (whenIdle). random: the server's own draws, never the engine's.
  // Returns the ids, or a reason and nothing inserted.
  addCreatures(req: AddRequest, random: () => number = Math.random): { ids: number[] } | { reason: string } {
    const e = this.eco;
    if (e.population + req.copies > e.config.eco.maxPopulation) return { reason: "the world is full, try again later" };
    const { width, height } = this.config.world;
    const r = this.config.creature.radius;
    const margin = 4 * r;
    const crowded = (x: number, y: number, taken: readonly { x: number; y: number }[]): boolean => {
      for (const p of taken) if ((p.x - x) ** 2 + (p.y - y) ** 2 < (4 * r) ** 2) return true;
      for (const m of e.members) if ((m.creature.state.x - x) ** 2 + (m.creature.state.y - y) ** 2 < (3 * r) ** 2) return true;
      return false;
    };
    const spots: { x: number; y: number; heading: number }[] = [];
    for (let tries = 0; spots.length < req.copies && tries < 40 * req.copies; tries++) {
      const x = margin + random() * (width - 2 * margin);
      const y = margin + random() * (height - 2 * margin);
      if (!(e.world as World).terrain.touchesRock(x, y, 2 * r) && !crowded(x, y, spots)) spots.push({ x, y, heading: random() * 2 * Math.PI });
    }
    if (spots.length < req.copies) return { reason: "no free spot found, try again" };
    const ids: number[] = [];
    for (const p of spots) {
      const res = e.insertCreature({ genome: req.genome, plan: req.plan, x: p.x, y: p.y, heading: p.heading, hue: req.hue, name: req.name, birth: req.birth, energy: req.birth.cost }); // starts like a child of its own traits
      if (!res.ok) return ids.length ? { ids } : { reason: res.reason }; // checked up front, so a refusal after the first is not expected
      ids.push(res.id);
      this.added.add(res.id);
    }
    return { ids };
  }

  // The full world as plain data, to be written out by the caller.
  saveState(): EcoState {
    return saveState(this.eco);
  }

  // Replaces the world with the saved one. Throws, and leaves the running world alone, if the state is invalid
  // or needs WebAssembly kernels this machine lacks. Viewers then need a fresh hello.
  restoreState(state: EcoState): void {
    const eco = restoreState(state, this.pool, { journal: this.helpers !== null });
    const r = eco.retune({ eco: { maxPopulation: Math.min(eco.config.eco.maxPopulation, MAX_POPULATION) } }); // older saves allowed more
    if (!r.ok) throw new Error(`cannot cap the population: ${r.reason}`);
    this.eco = eco;
    this.owed = 0;
    this.attach();
    this.onReseed?.();
  }
}

// The server's tick loop: advance, then again when the next tick is due. After maxFailures consecutive failed ticks it calls fatal
// (main.ts exits with code 1, so systemd restarts from the last good save) and stops.
export function runTicks(live: Pick<LiveWorld, "advance" | "failedTicks">, maxFailures: number, fatal: (why: string) => void): void {
  const loop = async (): Promise<void> => {
    let wait = 100;
    try {
      wait = await live.advance();
    } catch (e) {
      console.error(`tick failed: ${e instanceof Error ? e.message : e}`);
      if (live.failedTicks >= maxFailures) return fatal(`${live.failedTicks} ticks in a row failed`);
    }
    setTimeout(() => void loop(), wait);
  };
  void loop();
}
