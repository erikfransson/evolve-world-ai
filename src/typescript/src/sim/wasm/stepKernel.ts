import type { Creature } from "../creature.ts";
import type { EngineConfig } from "../config.ts";
import { decaysFor } from "../physics.ts";
import type { Aging } from "../physics.ts";
import { FAST_FACTOR, ROCK_CELL, SLOW_FACTOR } from "../terrain.ts";
import type { Terrain } from "../terrain.ts";
import type { PhaseTimer } from "../profile.ts";
import { STEP_BYTES, compiled } from "./loader.ts";
import { Region } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";
import type { World } from "../world.ts";

// Memory and motion (Creature.remember and steer, physics.stepBody) of a whole batch in one WebAssembly call (step.wat), on the
// resident rows. The sin and cos are the fdlibm port of V8's, so on Node the results equal the JS; a browser whose Math.sin differs
// gets self-consistent results that are not the JS path's, so one world never mixes the two (resident creatures always step here).

const P_BYTES = 64;
const F_BYTES = 128;
const NEAR_ROWS_AT = 200;

interface StepExports extends WebAssembly.Exports {
  setTab(ptr: number): void;
  step(p: number): number;
  fill(f: number): void;
}

export class WasmStepper {
  private readonly store: ResidentStore;
  private readonly exports: StepExports;
  private pP = 0;
  private readonly rRows = new Region(); // addresses of the rows of the batch, in batch order (built by batch, read by fill and run)
  private readonly rSelves = new Region();
  private readonly rPlace = new Region();
  private readonly rCount = new Region();
  private pF = 0;
  private rowsN = 0;
  private readonly grounds = new Map<Uint8Array, number>();
  private terrain: Terrain | null = null;
  private rock = { start: 0, order: 0, xyr: 0 };
  private readonly nears = new Map<Uint8Array, number>();

  private constructor(store: ResidentStore, exports: StepExports) {
    this.store = store;
    this.exports = exports;
    this.reset();
  }

  // Back to a new stepper's state, after the brain bank was reset (its arena, and with it every address held here, is gone).
  reset(): void {
    for (const r of [this.rRows, this.rSelves, this.rPlace, this.rCount]) r.cap = 0;
    this.rowsN = 0;
    this.terrain = null;
    this.nears.clear();
    this.grounds.clear();
    this.pF = this.store.bank.alloc(F_BYTES);
    this.pP = this.store.bank.alloc(P_BYTES);
    const tab = this.store.bank.alloc(256);
    new Uint8Array(this.store.bank.memory.buffer, tab, TAB.length).set(TAB);
    this.exports.setTab(tab);
  }

  static create(store: ResidentStore): WasmStepper | null {
    try {
      const instance = new WebAssembly.Instance(compiled(STEP_BYTES), { brain: { mem: store.bank.memory } });
      return new WasmStepper(store, instance.exports as StepExports);
    } catch {
      return null;
    }
  }

  // Memory and motion for creatures[0 .. n-1], each with outputs adopted from the brain kernel.
  run(creatures: readonly Creature[], n: number, aging: Aging | null, terrain: Terrain, prof: PhaseTimer | null): void {
    if (n === 0) return;
    if (this.rowsN !== n) this.batch(creatures, n);
    if (this.terrain !== terrain) this.syncRock(terrain);
    this.writeBlocks(terrain);
    const { f64, i32 } = this.store;
    const P = this.pP >> 2;
    i32[P] = n;
    i32[P + 1] = this.rRows.ptr;
    f64[(this.pP >> 3) + 1] = aging ? aging.startTicks : Infinity;
    f64[(this.pP >> 3) + 2] = aging ? aging.perTick : 0;
    prof?.lap("step setup");
    const bad = this.exports.step(this.pP);
    this.rowsN = 0;
    if (bad > 0) {
      for (let k = 0; k < n; k++) {
        const r = creatures[k]!.resident!;
        if (r.bad) {
          r.clearBad();
          creatures[k]!.steer(); // heading beyond the port's range: motion in JS (memory was updated by the kernel)
        }
      }
    }
  }

  // Writes the addresses of the rows of creatures[0 .. n-1] for fill and run.
  private batch(creatures: readonly Creature[], n: number): void {
    const at = this.store.grow(this.rRows, n * 4);
    const i32 = this.store.i32;
    const base = at >> 2;
    for (let k = 0; k < n; k++) i32[base + k] = creatures[k]!.resident!.ptr;
    this.rowsN = n;
  }

  // The sense records (into pRec) and brain input extras of creatures[0 .. n-1], and the brain slot list at slotsAt (see fill in step.wat).
  // selves[k] is the crowd index of creatures[k]; detail, when in the batch, gets its rays written at pDetail.
  fill(creatures: readonly Creature[], n: number, selves: Int32Array, world: World, terrain: Terrain, pRec: number, slotsAt: number, pDetail: number, detail: Creature | null, stride: number): void {
    this.batch(creatures, n);
    if (this.terrain !== terrain) this.syncRock(terrain);
    this.writeBlocks(terrain);
    const store = this.store;
    const selvesAt = store.grow(this.rSelves, n * 4);
    const placeAt = store.grow(this.rPlace, n * 4);
    const countAt = store.grow(this.rCount, (world.rows + 1) * 4);
    const ground = terrain.ground;
    const groundAt = ground ? this.groundOf(ground.data) : 0;
    const { f64, i32 } = store;
    i32.set(selves.subarray(0, n), selvesAt >> 2);
    const F = this.pF >> 2;
    i32[F] = n;
    i32[F + 1] = this.rRows.ptr;
    i32[F + 2] = selvesAt;
    i32[F + 3] = pRec;
    i32[F + 4] = placeAt;
    i32[F + 5] = countAt;
    i32[F + 6] = slotsAt;
    i32[F + 7] = pDetail;
    i32[F + 8] = detail ? detail.resident!.ptr : 0;
    i32[F + 9] = stride;
    i32[F + 10] = world.rows;
    i32[F + 14] = groundAt;
    i32[F + 15] = ground ? ground.cols : 0;
    i32[F + 16] = ground ? ground.rows : 0;
    const D = this.pF >> 3;
    f64[D + 6] = 1 / world.cell;
    f64[D + 9] = ground ? 1 / ground.cell : 0;
    f64[D + 10] = SLOW_FACTOR;
    f64[D + 11] = FAST_FACTOR;
    this.exports.fill(this.pF);
  }

  // The address of a copy of the map's ground raster, made once.
  private groundOf(data: Uint8Array): number {
    let ptr = this.grounds.get(data);
    if (ptr === undefined) {
      ptr = this.store.bank.alloc(data.length);
      this.grounds.set(data, ptr);
      new Uint8Array(this.store.bank.memory.buffer, ptr, data.length).set(data);
    }
    return ptr;
  }

  private syncRock(terrain: Terrain): void {
    const bank = this.store.bank;
    this.terrain = terrain;
    this.nears.clear();
    if (terrain.rockCount === 0) return;
    this.rock = { start: bank.alloc(terrain.rockStart.length * 4), order: bank.alloc(terrain.rockCount * 4 + 4), xyr: bank.alloc(terrain.rockCount * 24 + 8) };
    const { f64, i32 } = this.store;
    i32.set(terrain.rockStart, this.rock.start >> 2);
    i32.set(terrain.rockOrder, this.rock.order >> 2);
    const o = this.rock.xyr >> 3;
    for (let d = 0; d < terrain.rockCount; d++) {
      f64[o + 3 * d] = terrain.rockX[d]!;
      f64[o + 3 * d + 1] = terrain.rockY[d]!;
      f64[o + 3 * d + 2] = terrain.rockR[d]!;
    }
  }

  // The address of keepOut's clear-of-rock raster for creatures of this radius, copied into the memory once.
  private nearOf(terrain: Terrain, radius: number): number {
    const { near } = terrain.clearRaster(radius);
    let ptr = this.nears.get(near);
    if (ptr === undefined) {
      ptr = this.store.bank.alloc(near.length);
      this.nears.set(near, ptr);
      new Uint8Array(this.store.bank.memory.buffer, ptr, near.length).set(near);
    }
    return ptr;
  }

  // Rewrites every species block from its config, so a retune takes effect and the first tick has them.
  private writeBlocks(terrain: Terrain): void {
    const blocks: [number, EngineConfig, number][] = [];
    for (const [config, ptr] of this.store.blocks) blocks.push([ptr, config, terrain.rockCount > 0 ? this.nearOf(terrain, config.creature.radius) : 0]);
    const { f64, i32 } = this.store;
    for (const [ptr, config, near] of blocks) this.writeBlock(f64, i32, ptr, config, terrain, near);
  }

  private writeBlock(f64: Float64Array, i32: Int32Array, ptr: number, config: EngineConfig, terrain: Terrain, near: number): void {
    const P = ptr >> 3;
    const PI = ptr >> 2;
    const c = config.creature;
    const d = decaysFor(config);
    f64[P] = config.dt;
    f64[P + 1] = c.maxTurnRate;
    f64[P + 2] = d.turn;
    f64[P + 3] = d.drag;
    f64[P + 4] = d.side;
    f64[P + 5] = c.drag;
    f64[P + 6] = c.maxThrust;
    f64[P + 7] = c.maxBrake;
    f64[P + 8] = c.thrustCost;
    f64[P + 9] = c.turnCost;
    f64[P + 10] = c.radius;
    f64[P + 11] = c.wallBounce;
    f64[P + 12] = config.world.width;
    f64[P + 13] = config.world.height;
    f64[P + 14] = c.brakeThreshold;
    f64[P + 15] = config.brain.shortRate;
    f64[P + 16] = config.brain.longRate;
    f64[P + 17] = terrain.maxRockR;
    f64[P + 18] = 1 / ROCK_CELL;
    f64[P + 26] = c.startEnergy;
    const rocky = terrain.rockCount > 0;
    i32[PI + 43] = rocky ? terrain.cols : 0;
    i32[PI + 44] = terrain.rows;
    i32[PI + 45] = this.rock.start;
    i32[PI + 46] = this.rock.order;
    i32[PI + 47] = this.rock.xyr;
    i32[PI + 48] = near;
    i32[PI + 49] = rocky ? Math.ceil(terrain.width / 100) : 0;
    i32[PI + NEAR_ROWS_AT / 4] = rocky ? Math.ceil(terrain.height / 100) : 0;
  }
}

// fdlibm npio2_hw: the high words of n pi/2 for n = 1 .. 32 (see trig.wat), as bytes
const TAB_HEX = "fb21f93ffb2109407cd91240fb2119407a6a1f407cd92240bbfd2540fb2129403a462c407a6a2f405c4731407cd932409c6b3440bbfd3540db8f3740fb2139401bb43a403a463c405ad83d407a6a3f404c7e40405c4741406c1042407cd942408ca243409c6b4440ac344540bbfd4540cbc64640db8f4740eb584840fb214940";
const TAB = Uint8Array.from({ length: TAB_HEX.length / 2 }, (_, i) => parseInt(TAB_HEX.substr(2 * i, 2), 16));
