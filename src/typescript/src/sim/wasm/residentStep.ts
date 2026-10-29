import type { Aging } from "../physics.ts";
import type { World } from "../world.ts";
import { refit } from "../brain.ts";
import { thinksNow } from "../creature.ts";
import type { Creature } from "../creature.ts";
import type { Crowd } from "../crowd.ts";
import type { PhaseTimer } from "../profile.ts";
import { F } from "./resident.ts";
import type { SenseKernels } from "./senseKernels.ts";

// Resident bodies on the rows' arrays. The batch is a list of row byte addresses; row r is the f64 element r / 8 and its i32 fields start at r / 4.
// The step itself is WebAssembly (WasmStepper), whose reference is Creature.remember and steer.

// Scratch for senseThinkRows: the thinking part of its batch.
let thinkRows = new Int32Array(0);
let thinkSelves = new Int32Array(0);

// The body inputs of the batch (the step needs every ground factor; the fill kernel's prepare writes them, Creature.writeBodyInputs is its reference), then sense and think for those of it that think this tick (thinksNow); idOf gives the id
// of crowd index self. detail gets its rays and input read back only when it thought, else they stay as of its last think.
export function senseThinkRows(kernels: SenseKernels, world: World, crowd: Crowd, rows: Int32Array, selves: Int32Array, n: number, tick: number, every: number,
  idOf: (self: number) => number, detail: Creature | null, prof: PhaseTimer | null = null): void {
  const store = kernels.store;
  kernels.prepareRows(rows, n, world.terrain, crowd);
  if (every <= 1) return kernels.runRows(world, crowd, rows, selves, n, detail, prof);
  if (thinkRows.length < n) {
    thinkRows = new Int32Array(2 * n);
    thinkSelves = new Int32Array(2 * n);
  }
  const f = store.f64;
  const detailRow = detail ? detail.resident!.ptr : -1;
  let thinkingDetail = false;
  let m = 0;
  for (let k = 0; k < n; k++) {
    const row = rows[k]!;
    if (!thinksNow(tick, every, idOf(selves[k]!), f[(row >> 3) + F.ticks]!)) continue;
    if (row === detailRow) thinkingDetail = true;
    thinkRows[m] = row;
    thinkSelves[m++] = selves[k]!;
  }
  kernels.runRows(world, crowd, thinkRows, thinkSelves, m, thinkingDetail ? detail : null, prof);
}

// Scratch for advanceBodies, shared by all callers: safe because the call is synchronous and nothing keeps the arrays.
let px = new Float64Array(0);
let py = new Float64Array(0);

// The step for helper threads, then the item each of these bodies touches (what Creature.touched returns) into touched[selves[k]].
export function advanceBodies(kernels: SenseKernels, rows: Int32Array, selves: Int32Array, n: number, aging: Aging | null, world: World, radius: number, touched: Int32Array): void {
  kernels.stepper.step(rows, n, aging, world.terrain);
  const store = kernels.store;
  px = refit(px, n);
  py = refit(py, n);
  const f = store.f64;
  for (let k = 0; k < n; k++) {
    const o = rows[k]! >> 3;
    px[k] = f[o + F.x]!;
    py[k] = f[o + F.y]!;
  }
  world.touchedBatch(px, py, selves, n, radius, touched);
}
