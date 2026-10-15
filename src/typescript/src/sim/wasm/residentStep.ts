import type { Aging } from "../physics.ts";
import { EXTRA_TERRAIN, energySignal } from "../sensors.ts";
import { Terrain } from "../terrain.ts";
import type { World } from "../world.ts";
import { refit } from "../brain.ts";
import { F, I } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";
import type { SenseKernels } from "./senseKernels.ts";

// Resident bodies in JS on the rows' arrays. The batch is a list of row byte addresses; row r is the f64 element r / 8 and its i32 fields start at r / 4.
// The step itself is WebAssembly (WasmStepper), whose reference is Creature.remember and steer.

// Twin of Creature.writeBodyInputs, the same arithmetic in the same order (parity test: tests/typescript/residentBodies.test.ts). Writes each row's brain input extras
// (energy signal, forward and sideways speed, turn rate, ground value; the fill kernel copies them as f32) and the ground factor the step moves by.
export function prepareRows(store: ResidentStore, rows: Int32Array, n: number, terrain: Terrain): void {
  const f = store.f64;
  const i32 = store.i32;
  const configs = store.species;
  const empty = terrain.empty;
  for (let k = 0; k < n; k++) {
    const o = rows[k]! >> 3;
    const c = configs[i32[(o << 1) + I.species]!]!.creature;
    const cos = f[o + F.cos]!;
    const sin = f[o + F.sin]!;
    const vx = f[o + F.vx]!;
    const vy = f[o + F.vy]!;
    const e = o + F.extras;
    f[e] = energySignal(f[o + F.energy]!, c.startEnergy);
    f[e + 1] = ((vx * cos + vy * sin) * c.drag) / c.maxThrust;
    f[e + 2] = ((vy * cos - vx * sin) * c.drag) / c.maxThrust;
    f[e + 3] = f[o + F.turn]! / c.maxTurnRate;
    const ground = empty ? 0 : terrain.valueAt(f[o + F.x]!, f[o + F.y]!);
    f[e + EXTRA_TERRAIN] = ground;
    f[o + F.groundFactor] = empty ? 1 : Terrain.factor(ground);
  }
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
