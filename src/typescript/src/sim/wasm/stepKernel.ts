import type { EngineConfig } from "../config.ts";
import type { Aging } from "../physics.ts";
import { decaysFor } from "../physics.ts";
import { OUTPUT_SIZE } from "../sensors.ts";
import { CLEAR_CELL, ROCK_CELL } from "../terrain.ts";
import type { Terrain } from "../terrain.ts";
import { STEP_BYTES, compiled } from "./loader.ts";
import { LAYOUT as L, f64At } from "./layout.ts";
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
    for (let s = 0; s < store.species.length; s++) {
      const radius = store.species[s]!.creature.radius;
      if (this.nearRadius[s] === radius) continue;
      const raster = terrain.nearFor(radius);
      const region = (this.nearRegions[s] ??= new Region());
      const at = store.grow(region, raster.length);
      new Uint8Array(store.i32.buffer, at, raster.length).set(raster);
      this.nearRadius[s] = radius;
    }
  }

  // The species block at byte address at: the config values the step reads and the decay factors; nearAt is the clear-of-rock raster of its radius.
  private writeSpecies(at: number, config: EngineConfig, nearAt: number, terrain: Terrain): void {
    const { dt, creature: c, world: w, brain } = config;
    const k = decaysFor(config);
    const { f64, i32 } = this.store;
    const q = at >> 3;
    f64[q + f64At(L.Q_DT)] = dt;
    f64[q + f64At(L.Q_MAX_THRUST)] = c.maxThrust;
    f64[q + f64At(L.Q_DRAG)] = c.drag;
    f64[q + f64At(L.Q_MAX_TURN)] = c.maxTurnRate;
    f64[q + f64At(L.Q_BRAKE_THRESHOLD)] = c.brakeThreshold;
    f64[q + f64At(L.Q_MAX_BRAKE)] = c.maxBrake;
    f64[q + f64At(L.Q_THRUST_COST)] = c.thrustCost;
    f64[q + f64At(L.Q_TURN_COST)] = c.turnCost;
    f64[q + f64At(L.Q_RADIUS)] = c.radius;
    f64[q + f64At(L.Q_WALL_BOUNCE)] = c.wallBounce;
    f64[q + f64At(L.Q_WIDTH)] = w.width;
    f64[q + f64At(L.Q_HEIGHT)] = w.height;
    f64[q + f64At(L.Q_SHORT_RATE)] = brain.shortRate;
    f64[q + f64At(L.Q_LONG_RATE)] = brain.longRate;
    f64[q + f64At(L.Q_DECAY_TURN)] = k.turn;
    f64[q + f64At(L.Q_DECAY_DRAG)] = k.drag;
    f64[q + f64At(L.Q_DECAY_SIDE)] = k.side;
    i32[(at + L.Q_NEAR) >> 2] = terrain.rockCount > 0 ? nearAt : 0;
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
    for (let s = 0; s < species.length; s++) this.writeSpecies(speciesAt + s * L.Q_BYTES, species[s]!, this.nearRegions[s]?.ptr ?? 0, terrain);
    const P = this.pP;
    i32[(P + L.P_N) >> 2] = n;
    i32[(P + L.P_ROWS) >> 2] = rowsAt;
    i32[(P + L.P_SPECIES) >> 2] = speciesAt;
    i32[(P + L.P_OUTPUT_SIZE) >> 2] = OUTPUT_SIZE;
    i32[(P + L.P_AGING) >> 2] = aging ? 1 : 0;
    i32[(P + L.P_EMPTY) >> 2] = terrain.empty ? 1 : 0;
    i32[(P + L.P_ROCKS) >> 2] = terrain.rockCount;
    i32[(P + L.P_ROCK_COLS) >> 2] = terrain.cols;
    i32[(P + L.P_ROCK_ROWS) >> 2] = terrain.rows;
    i32[(P + L.P_ROCK_START) >> 2] = this.rRock[0]!.ptr;
    i32[(P + L.P_ROCK_ORDER) >> 2] = this.rRock[1]!.ptr;
    i32[(P + L.P_ROCK_XYR) >> 2] = this.rRock[2]!.ptr;
    i32[(P + L.P_NEAR_COLS) >> 2] = terrain.nearCols;
    i32[(P + L.P_NEAR_ROWS) >> 2] = terrain.nearRows;
    f64[(P + L.P_MAX_ROCK_R) >> 3] = terrain.maxRockR;
    f64[(P + L.P_INV_ROCK_CELL) >> 3] = 1 / ROCK_CELL;
    f64[(P + L.P_CLEAR_CELL) >> 3] = CLEAR_CELL;
    f64[(P + L.P_AGING_START) >> 3] = aging?.startTicks ?? 0;
    f64[(P + L.P_AGING_PER_TICK) >> 3] = aging?.perTick ?? 0;
    this.exports.step(P);
  }
}
