import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { wrapAngle } from "../../src/typescript/src/sim/angle.ts";
import { VERSION } from "../../src/typescript/src/version.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { PoolEntry } from "../../src/typescript/src/sim/seedPool.ts";
import { MAX_DELTA_EVENTS, MAX_DELTA_OPS, MAX_ITEM_SLOTS, PROTOCOL_VERSION, encodeDeltaChunk, encodeItems, itemsBytes } from "../../src/typescript/src/live/protocol.ts";
import type { Hello, ItemOp, Stats, WireEvent, WireMap } from "../../src/typescript/src/live/protocol.ts";
import { encodeDetail, encodeGenome } from "../../src/typescript/src/live/detail.ts";
import { ITEM_REMOVE, ITEM_SET } from "../../src/typescript/src/sim/world.ts";
import type { World } from "../../src/typescript/src/sim/world.ts";
import { EVENT_STRIDE } from "../../src/typescript/src/sim/ecosystem.ts";
import { TokenBucket } from "./budget.ts";
import { addingOn } from "./adds.ts";
import { Chronicle } from "./chronicle.ts";
import { encodeMembers } from "./memberFrame.ts";
import { restoreState, saveState, snapshotState } from "../../src/typescript/src/sim/ecoState.ts";
import { boardValue } from "../../src/typescript/src/sim/leaderboard.ts";
import type { EcoSnapshot, EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { BIRTH_WEIGHT_CAP, LIMITS, LIVE, MAX_LIVE_WEIGHTS, MAX_POPULATION, MAX_SEED_FOUNDERS, SEED_COPIES, itemHeadroom, mostCopies, seedRoom } from "./config.ts";
import type { SeedFounder } from "./founders.ts";
import { mapRegions } from "../../src/typescript/src/live/mapRegions.ts";
import { mapVersion } from "../../src/typescript/src/sim/maps/index.ts";
import { OtherWorld, otherWorldReason } from "./saveParse.ts";
import type { Home } from "./saveParse.ts";
import { BLANKED, STARTER_MARK, wireName } from "../../src/typescript/src/live/add.ts";
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

// A save of another world (size or map) than the one this server runs, e.g. after the server moved to a new map.

// The shared world: one Ecosystem stepped against the clock, on this thread or with helper threads that sense and think.
// With helpers a tick awaits them, so everything else that reads or changes the world goes through whenIdle, between ticks.
export class LiveWorld {
  eco: Ecosystem;
  private owed = 0; // ticks due but not yet run
  private lastAt = performance.now();
  private speedTicks = 0;
  private speedSince = performance.now();
  paused = false; // admin pause: no ticks run and no time is owed afterwards
  speed = 0; // simulated seconds per real second achieved, over the last second (below LIVE.speed when the machine cannot keep up)
  private speedKnown = false; // a full second was measured since the start or the last resume
  private speedFresh = true; // the next unpaused advance starts a new measuring window (after a slow restore, or a pause)
  readonly startedAt = Date.now();
  private restarts = 0;
  private reseedStuck = false; // a reseed gave an empty world: no more until the world has creatures again
  founders: readonly SeedFounder[] = []; // what a reseed seeds a world built empty with (openWorld sets them)
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
  readonly freshEco: { maxPopulation: number; birthReserve: number }; // a fresh world's caps (the config this server starts from), bounding its seed
  private readonly freshBirth: AddRules["birth"]; // a fresh world's birth ranges, before any admin change (freshAddRules)
  seedCopies = SEED_COPIES; // of each founder this world was seeded with (saves.ts SEED_FILE), for the hello
  private added = new Set<number>(); // ids of visitor-added creatures that may still live (pruned in aliveAdded)
  private map: WireMap = { ground: { normal: 1, mud: 0, firm: 0, rock: 0 }, regions: [] };
  private readonly home: { width: number; height: number; map: string }; // the world this server runs; a save of another is not restored

  // helpers: a pool of helper threads, owned from here on (close() closes it), or null to run on this thread.
  constructor(config: EcoConfig, pool: readonly PoolEntry[] | null, helpers: ThinkPool | null = null) {
    this.freshEco = { maxPopulation: config.eco.maxPopulation, birthReserve: config.eco.birthReserve };
    const pair = (r: number[]): [number, number] => [r[0]!, r[1]!];
    this.freshBirth = { energy: pair(config.eco.birthEnergyRange), cost: pair(config.eco.birthCostRange), cooldown: pair(config.eco.birthCooldownRange) };
    this.pool = pool;
    this.helpers = helpers;
    this.home = { width: config.world.width, height: config.world.height, map: config.world.map ?? "" };
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
    const name = this.config.world.map || undefined;
    this.map = { ...(name ? { name, version: mapVersion(name) } : {}), ground: groundShares(this.eco), regions: mapRegions(name) };
    // Added creatures found named lineages (late rows of the lineage table, kept in saves); the living founders among them count.
    // The starter founders a fresh world was seeded with (seedFounders, names behind STARTER_MARK) are no visitor adds.
    this.added = new Set(this.eco.lineageTable.toState().late.filter((r) => r[5] !== "" && !r[5].startsWith(STARTER_MARK) && this.eco.get(r[0])).map((r) => r[0]));
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
    let grid = false; // the crowd grid is rebuilt for the first creature only: nothing moves between these senses
    for (const id of due) {
      if (!this.refreshes.take(1)) break;
      e.detail = id;
      e.refreshDetail(!grid);
      grid = true;
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
    const founder = wireName(e.lineageName(m.founderId));
    return encodeDetail(e.tick, id, {
      x: s.x, y: s.y, heading: wrapAngle(s.heading), energy: s.energy, age: m.ageTicks * this.config.dt, children: m.children, eaten: m.eaten, kills: boardValue(m, "kills"), depth: m.depth, parentId: m.parentId,
      founderId: m.founderId, founderPool: e.lineages.fromPool(m.founderId), founderName: founder.name, founderStarter: founder.starter, founderHue: e.lineages.colour(m.founderId), hue: m.hue, upkeep: c.upkeep, drain: c.drain,
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

  // Item slots are sized from the caps at construction, so build with room (itemHeadroom) and then retune to the caps in force.
  private build(config: EcoConfig): Ecosystem {
    const caps = { foodMaxDensity: config.eco.foodMaxDensity, poisonMaxDensity: config.eco.poisonMaxDensity };
    const room = itemHeadroom(config.world, caps);
    config.eco.foodMaxDensity = room.foodMaxDensity;
    config.eco.poisonMaxDensity = room.poisonMaxDensity;
    const eco = new Ecosystem(config, this.pool, { journal: this.helpers !== null });
    eco.birthWeightCap = BIRTH_WEIGHT_CAP;
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
      this.speedKnown = false;
      this.speedFresh = true;
      return 100;
    }
    if (this.speedFresh) {
      this.speedFresh = false;
      this.speedTicks = 0;
      this.speedSince = now;
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
      this.speedKnown = true;
      this.speedTicks = 0;
      this.speedSince = t;
    }
    return this.owed >= 1 ? 0 : Math.max(1, ((1 - this.owed) * dtMs) / LIVE.speed);
  }

  // The speed the add caps judge "busy" by: the set speed until a full second was measured, so a start or a resume is not taken for a busy world.
  speedForAdds(): number {
    return this.speedKnown ? this.speed : LIVE.speed;
  }

  // One tick on this thread, for tests and tools; the server's loop uses advance.
  step(): void {
    if (this.helpers) throw new Error("step runs without helpers only");
    this.maybeReseed();
    if (this.eco.extinct) return; // stays as it is until an add, the same with and without helpers
    this.eco.detail = null; // with a detail creature the WebAssembly sense costs several times more
    this.eco.step();
    this.collectOps();
  }

  // One tick, with the helpers when there are any, and the item changes recorded. Work queued by whenIdle runs after it.
  async tick(): Promise<void> {
    try {
      this.maybeReseed();
      if (this.eco.extinct) {
        this.failedTicks = 0; // nothing to step, so nothing failed: the helpers never see an empty world, and finally still runs outside work
        return;
      }
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

  // With LIVE.reseed on, an extinct world starts over with a new seed and the founders; off, it stays empty (the engine's step does
  // nothing) until an add. A reseed that still gives an empty world is not tried again until the world has creatures, so it never
  // rebuilds every tick.
  private maybeReseed(): void {
    if (!this.eco.extinct) this.reseedStuck = false;
    else if (LIVE.reseed && !this.reseedStuck) this.reseed();
  }

  private reseed(): void {
    this.config.seed += 1;
    this.restarts++;
    this.eco = this.build(this.config);
    this.attach();
    if (this.eco.population === 0 && this.founders.length) {
      try {
        const copies = Math.max(1, Math.min(this.seedCopies, mostCopies(this.founders.length, this.eco.config.eco))); // the admin may have lowered the room since
        this.seedFounders(this.founders, Math.random, copies);
      } catch (e) {
        console.error(`reseed: founders not seeded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.reseedStuck = this.eco.extinct;
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
      summary: { initialPopulation: eco.initialPopulation, maxPopulation: eco.maxPopulation, collisionDamage: eco.collisionDamage, killEnergy: eco.killEnergy, seasons: eco.seasons, ...(eco.initialPopulation === 0 ? { seedCopies: this.seedCopies } : {}), foodEnergy: this.eco.config.world.foodEnergy, poisonDamage: this.eco.config.world.poisonDamage },
      maxViewers,
      add: this.currentAddRules(),
      map: this.map,
      serverVersion: VERSION,
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
    this.chronicle.observe(e, s, records, viewers > 0);
    return s;
  }

  creatureFrame(): Uint8Array {
    const e = this.eco;
    return encodeMembers(e.tick, e.members, this.config.dt, this.config.creature.radius, this.config.world, fullEnergy(this.config.eco));
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

  // The add rules of a fresh world (the birth ranges this server starts from, not the admin's): what a reset's carry must pass, at the
  // reset and again at the fresh start, so one does not accept what the other refuses.
  freshAddRules(): AddRules {
    return { ...this.addRules(), birth: this.freshBirth };
  }

  // The rules for the hello and the rules message: null while adding is off.
  currentAddRules(): AddRules | null {
    return addingOn() ? this.addRules() : null;
  }

  // Up to n random spots inside the walls, clear of rock and of creatures, from the given draws (at most 40 tries a spot).
  private freeSpots(n: number, random: () => number): { x: number; y: number; heading: number }[] {
    const e = this.eco;
    const { width, height } = this.config.world;
    const r = this.config.creature.radius;
    const margin = 4 * r;
    const crowded = (x: number, y: number, taken: readonly { x: number; y: number }[]): boolean => {
      for (const p of taken) if ((p.x - x) ** 2 + (p.y - y) ** 2 < (4 * r) ** 2) return true;
      for (const m of e.members) if ((m.creature.state.x - x) ** 2 + (m.creature.state.y - y) ** 2 < (3 * r) ** 2) return true;
      return false;
    };
    const spots: { x: number; y: number; heading: number }[] = [];
    for (let tries = 0; spots.length < n && tries < 40 * n; tries++) {
      const x = margin + random() * (width - 2 * margin);
      const y = margin + random() * (height - 2 * margin);
      if (!(e.world as World).terrain.touchesRock(x, y, 2 * r) && !crowded(x, y, spots)) spots.push({ x, y, heading: random() * 2 * Math.PI });
    }
    return spots;
  }

  // Seeds a fresh world (no tick run, nobody in it) with `copies` (SEED_COPIES unless an admin reset asked for more) of each founder at random open spots, each copy the founder of a
  // lineage with the founder's name (behind STARTER_MARK), each founder its own hue. Not visitor adds: they count toward no add cap (see attach).
  // A founder with a pool gives each copy a genome from [genome, ...pool], in a shuffled order cycled through, so every variant is used once
  // before any repeats, and each fresh world draws its own subset when there are fewer copies than variants.
  // extra: one more founder with its own count (a reset's carried creature, carry.ts), its hue between the first two founders', seeded after
  // the founders and best effort. Returns the creatures seeded.
  // random: the server's own draws (spots, hues, variant order). Throws when the world is not fresh or a founder does not go in.
  seedFounders(founders: readonly SeedFounder[], random: () => number = Math.random, copies = SEED_COPIES, extra?: { founder: SeedFounder; copies: number }): number {
    const e = this.eco;
    if (e.tick !== 0 || e.population !== 0 || e.lineageTable.toState().late.length !== 0) throw new Error("only a fresh, empty world is seeded");
    if (founders.length < 1 || founders.length > MAX_SEED_FOUNDERS) throw new Error(`1 to ${MAX_SEED_FOUNDERS} founders are seeded`);
    if (!Number.isInteger(copies) || copies < 1) throw new Error("copies must be a whole number from 1");
    if (extra && (!Number.isInteger(extra.copies) || extra.copies < 1)) throw new Error("extra copies must be a whole number from 1");
    const own = founders.length * copies;
    const n = own + (extra?.copies ?? 0);
    const weights = seedWeights(founders, copies, extra);
    if (weights > BIRTH_WEIGHT_CAP) throw new Error(`${n} seeded creatures would hold ${weights} brain weights, over the ${BIRTH_WEIGHT_CAP} births stop at`); // so visitors' adds have the reserve from the start
    if (n > seedRoom(e.config.eco)) throw new Error(`${n} founders do not fit below the birth reserve (${seedRoom(e.config.eco)})`);
    const spots = this.freeSpots(n, random);
    if (spots.length < n) throw new Error("no room to seed the founders");
    const hue0 = random() * 360;
    const variants = founders.map((f) => {
      const all = [f.genome, ...(f.pool ?? [])];
      for (let j = all.length - 1; j > 0; j--) {
        const r = Math.min(j, Math.floor(random() * (j + 1)));
        [all[j], all[r]] = [all[r]!, all[j]!];
      }
      return all;
    });
    for (let i = 0; i < own; i++) {
      const k = Math.floor(i / copies);
      const f = founders[k]!;
      const p = spots[i]!;
      const genome = variants[k]![(i % copies) % variants[k]!.length]!;
      const res = e.insertCreature({ genome, plan: f.plan, x: p.x, y: p.y, heading: p.heading, hue: (hue0 + (360 * k) / founders.length) % 360, name: STARTER_MARK + f.name, ...(f.birth ? { birth: f.birth } : {}) }); // the start energy of a pool founder; its own birth traits or the range middles
      if (!res.ok) throw new Error(`founder ${f.name} could not be seeded: ${res.reason}`);
    }
    // The extra founder last and best effort: one refused insert ends it, the founders are in (the caller sees the count).
    for (let i = own; i < n; i++) {
      const f = extra!.founder;
      const p = spots[i]!;
      const res = e.insertCreature({ genome: f.genome, plan: f.plan, x: p.x, y: p.y, heading: p.heading, hue: (hue0 + 180 / founders.length) % 360, name: STARTER_MARK + f.name, ...(f.birth ? { birth: f.birth } : {}) });
      if (!res.ok) return i;
    }
    return n;
  }

  // Renames every family whose name viewers see as `from` to `to` (both letters and digits), keeping the starter mark: a renamed
  // starter founder (the shipped file's names changed) stays a starter. Call between ticks (whenIdle).
  // `from` is the name exactly as viewers see it; a `to` another living family carries (any case, as the add rule compares) is refused
  // unless force, since two families of one name cannot be told apart again. Returns the families renamed, or the reason.
  renameName(from: string, to: string, force = false): number | string {
    const t = to.toLowerCase();
    if (!force && from.toLowerCase() !== t && this.eco.lineageTable.someName((n) => wireName(n).name.toLowerCase() === t)) return `${to} is the name of a living family; add --force to rename anyway (both then carry it)`;
    return this.eco.lineageTable.renameWhere((n) => wireName(n).name === from, (n) => (n.startsWith(STARTER_MARK) ? STARTER_MARK : "") + to);
  }

  // Blanks a visitor's name (as viewers see it, without the starter mark) on every family that carries it, for an admin who finds it
  // unfit; the families live on unnamed. Stats, details and the next save carry the change. Call between ticks (whenIdle).
  // The name becomes BLANKED (or STARTER_MARK + BLANKED), which viewers see as no name, so a visitor family still counts as added.
  blankName(name: string): number {
    return this.eco.lineageTable.renameWhere((n) => wireName(n).name === name, (n) => (n.startsWith(STARTER_MARK) ? STARTER_MARK : "") + BLANKED);
  }

  // Inserts a checked add request (live/add.ts parseAdd) as `copies` founders of new named lineages at random free spots, through the
  // engine's insertCreature, so a save keeps them. Call between ticks (whenIdle). random: the server's own draws, never the engine's.
  // Returns the ids, or a reason and nothing inserted.
  // now: false when waiting will not help (the name is taken), so the page does not hold the Add button back.
  addCreatures(req: AddRequest, random: () => number = Math.random): { ids: number[] } | { reason: string; now?: false } {
    const e = this.eco;
    if (e.population + req.copies > e.config.eco.maxPopulation) return { reason: "the world is full, try again later" };
    if (e.weights + req.copies * req.genome.length > MAX_LIVE_WEIGHTS) return { reason: "the world holds all the brain weights it can save: fewer copies or a smaller brain may fit, or try again later" };
    // One name, one family on the list: a name a living family carries (any case), or a starter's, is refused; it frees when that family dies out.
    const wanted = req.name.toLowerCase();
    if (this.founders.some((f) => f.name.toLowerCase() === wanted) || e.lineageTable.someName((n) => wireName(n).name.toLowerCase() === wanted)) return { reason: `the name ${req.name} is taken by a family alive now, pick another`, now: false };
    const spots = this.freeSpots(req.copies, random);
    if (spots.length < req.copies) return { reason: "no free spot found, try again" };
    const ids: number[] = [];
    for (const p of spots) {
      const res = e.insertCreature({ genome: req.genome, plan: req.plan, x: p.x, y: p.y, heading: p.heading, hue: req.hue, name: req.name, birth: req.birth, energy: LIVE.add.startEnergy, ...(req.mutationScale !== undefined ? { mutationScale: req.mutationScale } : {}) }); // tunables.ts bounds it
      if (!res.ok) return ids.length ? { ids } : { reason: res.reason }; // checked up front, so a refusal after the first is not expected
      // Birth hold: the engine lets a creature give birth once tick - lastBirthTick >= cooldownTicks, so a last birth placed in the future
      // holds the first one back for birthHoldS. Saves keep lastBirthTick; children are spawned without it.
      const m = e.get(res.id)!;
      m.lastBirthTick = e.tick + Math.round(LIVE.add.birthHoldS / e.config.dt) - m.cooldownTicks;
      ids.push(res.id);
      this.added.add(res.id);
    }
    return { ids };
  }

  // The full world as plain data, to be written out by the caller.
  saveState(): EcoState {
    return saveState(this.eco);
  }

  // The same with its binary columns as typed arrays (copies), for a worker to pack (saves.ts).
  saveSnapshot(): EcoSnapshot {
    return snapshotState(this.eco);
  }

  // The world this server runs, as a save must match it (saveParse.ts otherWorldReason).
  homeWorld(): Home {
    const h = this.home;
    return { ...h, mapVersion: h.map ? mapVersion(h.map) : "" };
  }

  // Replaces the world with the saved one. Throws, and leaves the running world alone, if the state is invalid
  // or needs WebAssembly kernels this machine lacks. Viewers then need a fresh hello.
  restoreState(state: EcoState): void {
    // A save of another size, map or map data is of another world, so startup starts fresh instead of retrying it.
    const other = otherWorldReason(state, this.homeWorld());
    if (other) throw new OtherWorld(other);
    const eco = restoreState(state, this.pool, { journal: this.helpers !== null });
    const maxPopulation = Math.min(eco.config.eco.maxPopulation, MAX_POPULATION); // older saves allowed more
    const birthReserve = Math.min(eco.config.eco.birthReserve, Math.max(0, maxPopulation - 1)); // a reserve at the cap would stop every birth
    const r = eco.retune({ eco: { maxPopulation, birthReserve } });
    if (!r.ok) throw new Error(`cannot cap the population: ${r.reason}`);
    eco.birthWeightCap = BIRTH_WEIGHT_CAP; // a save over it only waits for deaths before births resume
    this.eco = eco;
    this.owed = 0;
    this.attach();
    this.onReseed?.();
  }
}

// Shares of the world's area that are normal ground, mud, firm ground and rock, from a grid of samples (about 40000, once per world).
export function groundShares(eco: Ecosystem, cols = 256): WireMap["ground"] {
  const { width, height } = eco.config.world;
  const terrain = (eco.world as World).terrain;
  const rows = Math.max(1, Math.round((cols * height) / width));
  const n = { normal: 0, mud: 0, firm: 0, rock: 0 };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ((i + 0.5) / cols) * width;
      const y = ((j + 0.5) / rows) * height;
      if (terrain.touchesRock(x, y, 0)) n.rock++;
      else {
        const v = terrain.valueAt(x, y);
        if (v < 0) n.mud++;
        else if (v > 0) n.firm++;
        else n.normal++;
      }
    }
  }
  const all = cols * rows;
  const r = (v: number): number => Math.round((v / all) * 1000) / 1000;
  return { normal: r(n.normal), mud: r(n.mud), firm: r(n.firm), rock: r(n.rock) };
}

// The server's tick loop: advance, then again when the next tick is due. After maxFailures consecutive failed ticks it calls fatal
// (main.ts exits with code 1, so systemd restarts from the last good save) and stops.
// Brain weights a seed of `copies` of each founder (and the extra founder's copies) holds; a founder's pool variants share its plan.
export const seedWeights = (founders: readonly SeedFounder[], copies: number, extra?: { founder: SeedFounder; copies: number }): number =>
  founders.reduce((sum, f) => sum + f.genome.length * copies, 0) + (extra ? extra.founder.genome.length * extra.copies : 0);

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
