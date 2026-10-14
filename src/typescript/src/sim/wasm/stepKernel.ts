import type { Aging } from "../physics.ts";
import { decaysFor } from "../physics.ts";
import { OUTPUT_SIZE } from "../sensors.ts";
import { CLEAR_CELL, ROCK_CELL } from "../terrain.ts";
import type { Terrain } from "../terrain.ts";
import { STEP_BYTES, compiled } from "./loader.ts";
import { LAYOUT as L } from "./layout.ts";
import { Region } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";

// The per-creature step of resident rows in WebAssembly (step.wat). Twin of stepRows in residentStep.ts, which stays the reference and the
// fallback; wasm/stepParity in tests/typescript/wasmStep.test.ts compares them bit for bit. Math.sin and Math.cos are the engine's own,
// imported, and the decay factors (Math.exp) are computed here per call, so the results equal the JS path on every engine.

let jsOnly = false;
// Runs the JS step even where the WebAssembly one exists (tests and comparisons).
export function forceJsStep(flag: boolean): void {
  jsOnly = flag;
}
export const jsStepForced = (): boolean => jsOnly;

interface StepExports extends WebAssembly.Exports {
  step(p: number): void;
}

export class WasmStepper {
  private readonly store: ResidentStore;
  private readonly exports: StepExports;
  private readonly rRows = new Region(); // the row addresses of the batch
  private readonly rSpecies = new Region(); // one species block each
  private readonly rRock = [new Region(), new Region(), new Region()]; // rockStart, rockOrder, the discs as x, y, r
  private nearRegions: Region[] = []; // per species, the clear-of-rock raster
  private nearRadius: number[] = []; // the radius each raster was made for
  private terrain: Terrain | null = null; // the map whose rock is in wasm memory
  private pP = 0;

  private constructor(store: ResidentStore, exports: StepExports) {
    this.store = store;
    this.exports = exports;
    this.reset();
  }

  static create(store: ResidentStore): WasmStepper | null {
    try {
      const imports = { brain: { mem: store.bank.memory }, math: { sin: Math.sin, cos: Math.cos } };
      return new WasmStepper(store, new WebAssembly.Instance(compiled(STEP_BYTES), imports).exports as StepExports);
    } catch {
      return null;
    }
  }

  // Back to a new stepper's state, after the brain bank was reset (its arena, and with it every address held here, is gone).
  reset(): void {
    for (const r of [this.rRows, this.rSpecies, ...this.rRock, ...this.nearRegions]) r.cap = 0;
    this.nearRadius = [];
    this.terrain = null;
    this.pP = this.store.bank.alloc(L.P_BYTES);
  }

  // Rock and the clear-of-rock rasters into wasm memory, when the map or a species' radius changed.
  private syncTerrain(terrain: Terrain): void {
    const store = this.store;
    if (terrain !== this.terrain) {
      this.terrain = terrain;
      this.nearRadius = [];
      if (terrain.rockCount === 0) return;
      const start = store.grow(this.rRock[0]!, terrain.rockStart.length * 4);
      const order = store.grow(this.rRock[1]!, terrain.rockCount * 4);
      const xyr = store.grow(this.rRock[2]!, terrain.rockCount * 24);
      store.i32.set(terrain.rockStart, start >> 2);
      store.i32.set(terrain.rockOrder, order >> 2);
      const f = store.f64;
      for (let d = 0; d < terrain.rockCount; d++) {
        f[(xyr >> 3) + 3 * d] = terrain.rockX[d]!;
        f[(xyr >> 3) + 3 * d + 1] = terrain.rockY[d]!;
        f[(xyr >> 3) + 3 * d + 2] = terrain.rockR[d]!;
      }
    }
    if (terrain.rockCount === 0) return;
    store.species.forEach((config, s) => {
      const radius = config.creature.radius;
      if (this.nearRadius[s] === radius) return;
      const raster = terrain.nearFor(radius);
      const region = (this.nearRegions[s] ??= new Region());
      const at = store.grow(region, raster.length);
      new Uint8Array(store.i32.buffer, at, raster.length).set(raster);
      this.nearRadius[s] = radius;
    });
  }

  // Steps the resident rows at rows[0 .. n-1] (byte addresses), as stepRows does.
  step(rows: Int32Array, n: number, aging: Aging | null, terrain: Terrain): void {
    const store = this.store;
    const species = store.species;
    const rowsAt = store.grow(this.rRows, n * 4);
    const speciesAt = store.grow(this.rSpecies, species.length * L.Q_BYTES);
    this.syncTerrain(terrain);
    const { f64, i32 } = store; // after the last allocation
    i32.set(rows.subarray(0, n), rowsAt >> 2);
    species.forEach((config, s) => {
      const { dt, creature: c, world: w, brain } = config;
      const k = decaysFor(config);
      const at = (speciesAt + s * L.Q_BYTES) >> 3;
      const values: [number, number][] = [
        [L.Q_DT, dt], [L.Q_MAX_THRUST, c.maxThrust], [L.Q_DRAG, c.drag], [L.Q_MAX_TURN, c.maxTurnRate], [L.Q_BRAKE_THRESHOLD, c.brakeThreshold],
        [L.Q_MAX_BRAKE, c.maxBrake], [L.Q_THRUST_COST, c.thrustCost], [L.Q_TURN_COST, c.turnCost], [L.Q_RADIUS, c.radius], [L.Q_WALL_BOUNCE, c.wallBounce],
        [L.Q_WIDTH, w.width], [L.Q_HEIGHT, w.height], [L.Q_SHORT_RATE, brain.shortRate], [L.Q_LONG_RATE, brain.longRate],
        [L.Q_DECAY_TURN, k.turn], [L.Q_DECAY_DRAG, k.drag], [L.Q_DECAY_SIDE, k.side],
      ];
      for (const [off, v] of values) f64[at + off / 8] = v;
      const nearAt = this.nearRegions[s]?.ptr ?? 0;
      i32[(speciesAt + s * L.Q_BYTES + L.Q_NEAR) >> 2] = terrain.rockCount > 0 ? nearAt : 0;
    });
    const P = this.pP;
    const ints: [number, number][] = [
      [L.P_N, n], [L.P_ROWS, rowsAt], [L.P_SPECIES, speciesAt], [L.P_OUTPUT_SIZE, OUTPUT_SIZE], [L.P_AGING, aging ? 1 : 0], [L.P_EMPTY, terrain.empty ? 1 : 0],
      [L.P_ROCKS, terrain.rockCount], [L.P_ROCK_COLS, terrain.cols], [L.P_ROCK_ROWS, terrain.rows], [L.P_ROCK_START, this.rRock[0]!.ptr],
      [L.P_ROCK_ORDER, this.rRock[1]!.ptr], [L.P_ROCK_XYR, this.rRock[2]!.ptr], [L.P_NEAR_COLS, terrain.nearCols], [L.P_NEAR_ROWS, terrain.nearRows],
    ];
    for (const [off, v] of ints) i32[(P + off) >> 2] = v;
    const doubles: [number, number][] = [
      [L.P_MAX_ROCK_R, terrain.maxRockR], [L.P_INV_ROCK_CELL, 1 / ROCK_CELL], [L.P_CLEAR_CELL, CLEAR_CELL],
      [L.P_AGING_START, aging?.startTicks ?? 0], [L.P_AGING_PER_TICK, aging?.perTick ?? 0],
    ];
    for (const [off, v] of doubles) f64[(P + off) >> 3] = v;
    this.exports.step(P);
  }
}
