import type { Aging, Body, Decays } from "../physics.ts";
import { agingFactor, decaysFor, keepInside } from "../physics.ts";
import { OUTPUT_SIZE, energySignal, thrustCommand } from "../sensors.ts";
import { Terrain } from "../terrain.ts";
import type { World } from "../world.ts";
import { refit } from "../brain.ts";
import { F, I } from "./resident.ts";
import { jsStepForced } from "./stepKernel.ts";
import type { ResidentStore } from "./resident.ts";

// The per-creature physics of resident bodies in JS, on the rows' arrays: the same arithmetic in the same order as Creature.writeBodyInputs
// (the brain input extras), Creature.remember and physics.stepBody, with this engine's Math.exp, sin and cos. The batch is a list of row
// byte addresses; row r is the f64 element r / 8 and its i32 fields start at r / 4.

const body: Body = { x: 0, y: 0, vx: 0, vy: 0 }; // keepInside and keepOut work on an object
const decays: Decays[] = []; // per species, refreshed each tick in place (a retune may change them)

// Twin of Creature.writeBodyInputs (parity test: tests/typescript/residentBodies.test.ts). Writes each row's brain input extras (energy signal, forward and sideways speed, turn rate, ground value; the fill kernel copies them as f32)
// and the ground factor the step moves by.
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
    f[e + 4] = ground;
    f[o + F.groundFactor] = empty ? 1 : Terrain.factor(ground);
  }
}

// Twin of Creature.remember and physics.stepBody (same parity test), and of step.wat (WasmStepper in stepKernel.ts), which stepResident prefers; this is its reference and fallback. Memory and motion for each row of the batch. The brain outputs are in f32, the bank's memory as floats.
export function stepRows(store: ResidentStore, f32: Float32Array, rows: Int32Array, n: number, aging: Aging | null, terrain: Terrain): void {
  const f = store.f64;
  const i32 = store.i32;
  const configs = store.species;
  for (let s = 0; s < configs.length; s++) decays[s] = decaysFor(configs[s]!);
  for (let k = 0; k < n; k++) {
    const o = rows[k]! >> 3;
    const b = o << 1;
    const config = configs[i32[b + I.species]!]!;
    const { dt, creature: c, world: w, brain } = config;
    const k2 = decays[i32[b + I.species]!]!;
    const out = i32[b + I.out]! >> 2;
    // remember
    const units = i32[b + I.units]! >> 3;
    const count = i32[b + I.unitCount]!;
    const short = i32[b + I.short]!;
    for (let u = 0; u < count; u++) f[units + u] += (u < short ? brain.shortRate : brain.longRate) * (f32[out + OUTPUT_SIZE + u]! - f[units + u]!);
    // steer: stepBody
    const thrust = thrustCommand(f32[out + 1]!, c.brakeThreshold);
    const targetTurn = f32[out]! * c.maxTurnRate;
    const turnRate = targetTurn + (f[o + F.turn]! - targetTurn) * k2.turn;
    f[o + F.turn] = turnRate;
    const heading = f[o + F.heading]! + turnRate * dt;
    f[o + F.heading] = heading;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    f[o + F.cos] = cos;
    f[o + F.sin] = sin;
    const vx0 = f[o + F.vx]!;
    const vy0 = f[o + F.vy]!;
    const v = vx0 * cos + vy0 * sin;
    let fwd: number;
    if (thrust >= 0) {
      const terminal = (thrust * c.maxThrust) / c.drag;
      fwd = terminal + (v - terminal) * k2.drag;
    } else {
      const slowed = Math.abs(v) * k2.drag + thrust * c.maxBrake * dt;
      fwd = slowed > 0 ? (v < 0 ? -slowed : slowed) : 0;
    }
    const side = (-vx0 * sin + vy0 * cos) * k2.side;
    body.vx = fwd * cos - side * sin;
    body.vy = fwd * sin + side * cos;
    const ground = terrain.empty ? 1 : f[o + F.groundFactor]!;
    body.x = f[o + F.x]! + body.vx * dt * ground;
    body.y = f[o + F.y]! + body.vy * dt * ground;
    keepInside(body, c.radius, w.width, w.height, c.wallBounce);
    terrain.keepOut(body, c.radius, c.wallBounce);
    f[o + F.x] = body.x;
    f[o + F.y] = body.y;
    f[o + F.vx] = body.vx;
    f[o + F.vy] = body.vy;
    const upkeep = f[o + F.upkeep]! * agingFactor(aging, f[o + F.ticks]!);
    f[o + F.energy] = f[o + F.energy]! - (upkeep + c.thrustCost * Math.max(0, thrust) + (c.turnCost * Math.abs(turnRate)) / c.maxTurnRate) * dt;
  }
}

// stepRows in WebAssembly when the store has the stepper, else in JS; the results are bit for bit the same (tests/typescript/wasmStep.test.ts).
export function stepResident(store: ResidentStore, f32: Float32Array, rows: Int32Array, n: number, aging: Aging | null, terrain: Terrain): void {
  if (store.stepper && !jsStepForced()) store.stepper.step(rows, n, aging, terrain);
  else stepRows(store, f32, rows, n, aging, terrain);
}

// Scratch for advanceBodies, shared by all callers: safe because the call is synchronous and nothing keeps the arrays.
let px = new Float64Array(0);
let py = new Float64Array(0);

// stepResident for helper threads, then the item each of these bodies touches (what Creature.touched returns) into touched[selves[k]].
export function advanceBodies(store: ResidentStore, f32: Float32Array, rows: Int32Array, selves: Int32Array, n: number, aging: Aging | null, world: World, radius: number, touched: Int32Array): void {
  stepResident(store, f32, rows, n, aging, world.terrain);
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
