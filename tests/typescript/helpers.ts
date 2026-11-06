import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { serveHelper } from "../../src/typescript/src/worker/ecoPool.ts";
import type { HelperIn, HelperOut, HelperPort } from "../../src/typescript/src/worker/ecoPool.ts";
import type { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { Rng } from "../../src/typescript/src/sim/types.ts";

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
  alpha?: unknown; // globalAlpha at the time of the call
}

export interface FakeCtx {
  ctx: CanvasRenderingContext2D;
  calls: Call[];
  props: Record<string, unknown>; // last value assigned to each property
}

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
        calls.push({ name: key, args, alpha: props.globalAlpha });
        return key === "createLinearGradient" ? { addColorStop() {} } : undefined;
      };
    },
    set(_t, key: string, value) {
      props[key] = value;
      if (typeof value === "number" && !Number.isFinite(value)) calls.push({ name: `set ${key}`, args: [value] }); // recorded only when bad
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, props };
}

// Names of calls (any method, plus "set <property>" for property writes) that received a non-finite number, and arcs with a negative radius.
export function badCoordinateCalls(calls: readonly Call[]): string[] {
  const bad = (c: Call) => c.args.some((a) => typeof a === "number" && !Number.isFinite(a)) || (c.name === "arc" && !((c.args[2] as number) >= 0));
  return calls.filter(bad).map((c) => c.name);
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

// A small crowded world with varied plans and structural mutations, so creatures are born and die within a few hundred ticks.
export function crowdedConfig(seed = 5, eco: Partial<EcoConfig["eco"]> = {}): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    seed,
    world: { ...d.world, width: 900, height: 900 },
    creature: { ...d.creature, startEnergy: 60 },
    eco: { ...d.eco, initialPopulation: 60, foundersVary: true, structuralRate: 0.3, birthEnergyRange: [76, 76], birthCostRange: [75, 75], birthCooldownRange: [10, 10], ...eco },
  };
}

// In-process helpers over cloned messages; failAt: the tick message on which a helper reports an error instead, or never answers with hang.
export function fakePorts(n: number, failAt = Infinity, hang = false): HelperPort[] {
  return Array.from({ length: n }, () => {
    let reply: (msg: HelperOut) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    let ticks = 0;
    const handle = serveHelper((msg, transfer) => queueMicrotask(() => reply(structuredClone(msg, { transfer: transfer as ArrayBuffer[] }))));
    return {
      post: (msg: HelperIn, transfer?: Transferable[]) => {
        if (msg.type === "tick" && ++ticks >= failAt) return hang ? undefined : queueMicrotask(() => fail(new Error("helper lost")));
        const copy = structuredClone(msg, { transfer: (transfer ?? []) as ArrayBuffer[] });
        queueMicrotask(() => handle(copy));
      },
      onMessage: (callback) => { reply = callback; },
      onError: (callback) => { fail = callback; },
      terminate: () => {},
    };
  });
}
