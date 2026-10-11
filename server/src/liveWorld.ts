import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { CreatureFrame as EngineFrame } from "../../src/typescript/src/sim/ecosystem.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { PoolEntry } from "../../src/typescript/src/sim/seedPool.ts";
import { PROTOCOL_VERSION, encodeCreatures, encodeItems } from "../../src/typescript/src/live/protocol.ts";
import type { Hello, Stats } from "../../src/typescript/src/live/protocol.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { ITEM_HEADROOM, LIMITS, LIVE, MAX_POPULATION } from "./config.ts";
import { fullEnergy } from "../../src/typescript/src/sim/species.ts";

// The shared world: one Ecosystem stepped at 1x real time on this thread.
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
  onReseed: (() => void) | null = null; // the world was replaced, viewers need a fresh hello

  private readonly pool: readonly PoolEntry[] | null;

  constructor(config: EcoConfig, pool: readonly PoolEntry[] | null) {
    this.pool = pool;
    this.eco = this.build(config);
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
    const eco = new Ecosystem(config, this.pool);
    const r = eco.retune({ eco: caps });
    if (!r.ok) throw new Error(`cannot set the item caps: ${r.reason}`);
    return eco;
  }

  get world(): { width: number; height: number } {
    return this.config.world;
  }

  // Runs the ticks that are due, at most sliceMs of work. Returns milliseconds until the next tick is due, 0 when behind.
  advance(): number {
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
      if (this.eco.extinct) this.reseed();
      this.eco.step();
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

  // An extinct world starts over with a new seed, so visitors never watch an empty board.
  private reseed(): void {
    this.config.seed += 1;
    this.restarts++;
    this.eco = this.build(this.config);
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
      summary: { initialPopulation: eco.initialPopulation, maxPopulation: eco.maxPopulation, collisionDamage: eco.collisionDamage, seasons: eco.seasons },
      maxViewers,
    };
  }

  stats(viewers: number): Stats {
    const e = this.eco;
    return {
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
    };
  }

  creatureFrame(): Uint8Array {
    const e = this.eco;
    const f = (this.frame = e.readCreatures(this.frame));
    if (this.ages.length < f.count) this.ages = new Float32Array(Math.max(f.count, 2 * this.ages.length));
    for (let i = 0; i < f.count; i++) this.ages[i] = e.get(f.ids[i]!)!.ageTicks * this.config.dt;
    return encodeCreatures(e.tick, { ...f, age: this.ages, radius: this.config.creature.radius }, this.config.world, fullEnergy(this.config.eco));
  }

  itemsFrame(): Uint8Array {
    const w = this.eco.world;
    return encodeItems(this.eco.tick, w.xs, w.ys, w.kinds, w.count, this.config.world);
  }

  // TODO(L1): insert a visitor's creatures at random places. Waiting for the engine hook (#22/#31).
  insertCreature(_genome: Float32Array, _plan: unknown, _name: string, _colour: number): never {
    throw new Error("insertCreature: waiting for the engine hook (#22/#31)");
  }

  // The full world as plain data, to be written out by the caller.
  saveState(): EcoState {
    return saveState(this.eco);
  }

  // Replaces the world with the saved one. Throws, and leaves the running world alone, if the state is invalid
  // or needs WebAssembly kernels this machine lacks. Viewers then need a fresh hello.
  restoreState(state: EcoState): void {
    const eco = restoreState(state, this.pool);
    const r = eco.retune({ eco: { maxPopulation: Math.min(eco.config.eco.maxPopulation, MAX_POPULATION) } }); // older saves allowed more
    if (!r.ok) throw new Error(`cannot cap the population: ${r.reason}`);
    this.eco = eco;
    this.owed = 0;
    this.onReseed?.();
  }
}
