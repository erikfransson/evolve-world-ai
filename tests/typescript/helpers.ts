import type { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { Rng } from "../../src/typescript/src/sim/types.ts";
import { EXTRA_TERRAIN, energySignal } from "../../src/typescript/src/sim/sensors.ts";
import { Terrain } from "../../src/typescript/src/sim/terrain.ts";
import { F, I } from "../../src/typescript/src/sim/wasm/resident.ts";
import type { ResidentStore } from "../../src/typescript/src/sim/wasm/resident.ts";

// Small deterministic Rng for tests, independent of src/sim/rng.ts.
export function testRng(seed = 1): Rng {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (n) => Math.floor(next() * n),
    normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  };
}

export interface Call {
  name: string;
  args: unknown[];
}

export interface FakeCtx {
  ctx: CanvasRenderingContext2D;
  calls: Call[];
  props: Record<string, unknown>; // last value assigned to each property
}

const COORD_CALLS = new Set(["moveTo", "lineTo", "arc", "rect", "fillRect", "strokeRect", "clearRect", "setTransform", "fillText", "createLinearGradient"]);

// Recording stand-in for CanvasRenderingContext2D: any method is accepted and logged, any property can be set.
// measureText gives 6 per character and gradients accept addColorStop.
export function fakeCtx(width = 800, height = 600): FakeCtx {
  const calls: Call[] = [];
  const props: Record<string, unknown> = {};
  const canvas = { width, height };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key === "canvas") return canvas;
      if (key in props) return props[key];
      if (key === "measureText") return (text: string) => ({ width: 6 * text.length });
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return key === "createLinearGradient" ? { addColorStop() {} } : undefined;
      };
    },
    set(_t, key: string, value) {
      props[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, props };
}

// Names of coordinate calls that received a non-finite number.
export function badCoordinateCalls(calls: readonly Call[]): string[] {
  return calls.filter((c) => COORD_CALLS.has(c.name) && c.args.some((a) => typeof a === "number" && !Number.isFinite(a))).map((c) => c.name);
}

// Minimal canvas element with a fixed CSS size, a recording 2d context and click listeners.
export function fakeCanvas(cssWidth = 300, cssHeight = 100) {
  const fc = fakeCtx(cssWidth, cssHeight);
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const canvas = {
    width: cssWidth,
    height: cssHeight,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    getContext: () => fc.ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: cssHeight }),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, click: (clientX: number) => listeners.click?.forEach((fn) => fn({ clientX })), ...fc };
}

const keptKernels = new WeakMap<Ecosystem, { crowd: unknown; members: unknown }>();
// Gives an Ecosystem its WebAssembly crowd grid and member scans (true) or takes them away (false), so the same steps run as JS on the creature objects.
// Works between any two ticks; a field left out stays as it is. Reaches into private fields.
export function useKernels(eco: Ecosystem, use: { crowd?: boolean; members?: boolean }): void {
  const e = eco as unknown as { wasmCrowd: unknown; wasmMembers: unknown };
  let own = keptKernels.get(eco);
  if (!own) keptKernels.set(eco, (own = { crowd: e.wasmCrowd, members: e.wasmMembers }));
  if (use.crowd !== undefined) e.wasmCrowd = use.crowd ? own.crowd : null;
  if (use.members !== undefined) e.wasmMembers = use.members ? own.members : null;
}

// Fingerprint of the pinned 300-tick WebAssembly run of ecoPool.test.ts; re-pinned for the terrain input (#34), was 116543125. Change it only on purpose.
export const WASM_RUN_FINGERPRINT = 81047108;

// The oracle of the fill kernel's prepare: Creature.writeBodyInputs for resident rows, the same arithmetic in the same order, into the rows' brain input extras
// (the energy signal f32 rounded, as the kernel stores it) and the ground factor the step moves by. Without signal the first extra is left as it is.
export function prepareRows(store: ResidentStore, rows: Int32Array, n: number, terrain: Terrain, signal = true): void {
  const f = store.f64;
  const i32 = store.i32;
  const empty = terrain.empty;
  for (let k = 0; k < n; k++) {
    const o = rows[k]! >> 3;
    const c = store.species[i32[(o << 1) + I.species]!]!.creature;
    const cos = f[o + F.cos]!;
    const sin = f[o + F.sin]!;
    const vx = f[o + F.vx]!;
    const vy = f[o + F.vy]!;
    const e = o + F.extras;
    if (signal) f[e] = Math.fround(energySignal(f[o + F.energy]!, c.startEnergy));
    f[e + 1] = ((vx * cos + vy * sin) * c.drag) / c.maxThrust;
    f[e + 2] = ((vy * cos - vx * sin) * c.drag) / c.maxThrust;
    f[e + 3] = f[o + F.turn]! / c.maxTurnRate;
    const ground = empty ? 0 : terrain.valueAt(f[o + F.x]!, f[o + F.y]!);
    f[e + EXTRA_TERRAIN] = ground;
    f[o + F.groundFactor] = empty ? 1 : Terrain.factor(ground);
  }
}
