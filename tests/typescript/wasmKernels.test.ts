import { generatedSource } from "../../src/typescript/scripts/wasmAssemble.ts";
import { Brain, genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Crowd } from "../../src/typescript/src/sim/crowd.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { inputLayout, planOf, rayAngleOffsets } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_CREATURE, HIT_FOOD, HIT_NONE, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import type { CreatureState, RayHit } from "../../src/typescript/src/sim/types.ts";
import { WasmBrainBank } from "../../src/typescript/src/sim/wasm/brainKernel.ts";
import { setWasmDisabled, wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { WasmRayCaster } from "../../src/typescript/src/sim/wasm/rayKernel.ts";
import { readFileSync } from "node:fs";
import { testRng } from "./helpers.ts";

afterEach(() => setWasmDisabled(false));

describe("wasm toolchain", () => {
  it("kernels.generated.ts matches the .wat sources (run `npm run wasm` after editing them)", async () => {
    const committed = readFileSync(new URL("../../src/typescript/src/sim/wasm/kernels.generated.ts", import.meta.url), "utf8");
    expect(await generatedSource()).toBe(committed);
  });

  it("detects WebAssembly SIMD here", () => {
    expect(wasmAvailable()).toBe(true);
  });
});

describe("fallback", () => {
  it("create returns null when WebAssembly is disabled", async () => {
    setWasmDisabled(true);
    expect(wasmAvailable()).toBe(false);
    expect(await WasmBrainBank.create()).toBeNull();
    expect(await WasmRayCaster.create()).toBeNull();
    setWasmDisabled(false);
    expect(await WasmBrainBank.create()).not.toBeNull();
  });
});

const ecoPlanSizes = (rayCount: number, hidden: number[], memory: number): number[] => {
  const c = { ...DEFAULT_ECO_CONFIG, creature: { ...DEFAULT_ECO_CONFIG.creature, rayCount }, brain: { ...DEFAULT_ECO_CONFIG.brain, hiddenLayers: hidden, memory } };
  return layerSizes(c, planOf(c));
};

// Mostly-zero inputs like the real ones (one-hot ray flags), plus some dense values.
function fillInput(a: Float32Array, rng: ReturnType<typeof testRng>): void {
  for (let i = 0; i < a.length; i++) a[i] = rng.next() < 0.6 ? 0 : rng.next() < 0.5 ? 1 : rng.range(-1.5, 1.5);
}

const SIZE_SETS: number[][] = [
  ecoPlanSizes(8, [16], 0.25),
  ecoPlanSizes(8, [16], 0),
  ecoPlanSizes(5, [9, 4], 0.5),
  ecoPlanSizes(16, [32, 32, 32, 32], 1),
  ecoPlanSizes(3, [4], 0.0625),
  [7, 5, 3, 2],
  [1, 1],
];

describe("WasmBrainBank", () => {
  it("matches Brain.forward within f32 rounding over varied plans", async () => {
    const bank = (await WasmBrainBank.create())!;
    const rng = testRng(5);
    const brains: Brain[] = [];
    const ins: Float32Array[] = [];
    const outs: Float32Array[] = [];
    for (let slot = 0; slot < 70; slot++) {
      const sizes = SIZE_SETS[slot % SIZE_SETS.length]!;
      const g = randomGenome(sizes, rng);
      brains.push(new Brain(sizes, g));
      bank.set(slot, sizes, g);
      ins.push(new Float32Array(sizes[0]!));
      outs.push(new Float32Array(sizes[sizes.length - 1]!));
    }
    let maxAbs = 0;
    for (let round = 0; round < 3; round++) {
      for (let slot = 0; slot < brains.length; slot++) {
        fillInput(ins[slot]!, rng);
        bank.f32.set(ins[slot]!, bank.inputAt(slot));
        brains[slot]!.forward(ins[slot]!, outs[slot]!);
      }
      bank.forward(brains.length);
      for (let slot = 0; slot < brains.length; slot++) {
        const got = bank.f32.subarray(bank.outputAt(slot), bank.outputAt(slot) + outs[slot]!.length);
        for (let k = 0; k < got.length; k++) maxAbs = Math.max(maxAbs, Math.abs(got[k]! - outs[slot]![k]!));
      }
    }
    expect(maxAbs).toBeLessThan(2e-6);
  });

  it("saturates large sums to exactly +-1 like the JS tanh", async () => {
    const bank = (await WasmBrainBank.create())!;
    const sizes = [2, 2];
    const g = Float32Array.of(100, 0, 0, -100, 0, 0);
    bank.set(0, sizes, g);
    bank.f32.set([1, 1], bank.inputAt(0));
    bank.forward(1);
    expect(Array.from(bank.f32.subarray(bank.outputAt(0), bank.outputAt(0) + 2))).toEqual([1, -1]);
  });

  it("keeps results correct while linear memory grows, and reuses released slots", async () => {
    const bank = (await WasmBrainBank.create())!;
    const sizes = SIZE_SETS[0]!;
    const rng = testRng(8);
    const startBytes = bank.memoryBytes;
    const genomes: Float32Array[] = [];
    const n = 3000;
    for (let slot = 0; slot < n; slot++) {
      genomes.push(randomGenome(sizes, rng));
      bank.set(slot, sizes, genomes[slot]!);
    }
    expect(bank.memoryBytes).toBeGreaterThan(startBytes + 5_000_000);
    const input = new Float32Array(sizes[0]!);
    fillInput(input, rng);
    for (let slot = 0; slot < n; slot++) bank.f32.set(input, bank.inputAt(slot));
    bank.forward(n);
    const want = new Float32Array(sizes[sizes.length - 1]!);
    for (const slot of [0, 1, 1500, n - 1]) {
      new Brain(sizes, genomes[slot]!).forward(input, want);
      const got = bank.f32.subarray(bank.outputAt(slot), bank.outputAt(slot) + want.length);
      for (let k = 0; k < want.length; k++) expect(got[k]).toBeCloseTo(want[k]!, 5);
    }
    const grown = bank.memoryBytes;
    bank.release(5);
    bank.set(5, sizes, genomes[7]!);
    expect(bank.memoryBytes).toBe(grown);
    bank.set(5, SIZE_SETS[3]!, randomGenome(SIZE_SETS[3]!, rng)); // another shape moves the slot
    bank.f32.set(new Float32Array(SIZE_SETS[3]![0]!), bank.inputAt(5));
    bank.forward(6);
    expect(Array.from(bank.f32.subarray(bank.outputAt(5), bank.outputAt(5) + 2)).every(Number.isFinite)).toBe(true);
  });

  it("rejects bad shapes", async () => {
    const bank = (await WasmBrainBank.create())!;
    expect(() => bank.set(0, [3], new Float32Array(0))).toThrow(/layer sizes/);
    expect(() => bank.set(0, [3, 2], new Float32Array(3))).toThrow(/genome length/);
    expect(() => bank.set(0, [3, 2000], new Float32Array(genomeLength([3, 2000])))).toThrow(/exceeds/);
    expect(inputLayout(DEFAULT_ECO_CONFIG).size).toBeGreaterThan(0);
    bank.release(99); // never set: nothing to free
    bank.forward(0);
  });

  it("never runs an unset or released slot", async () => {
    const bank = (await WasmBrainBank.create())!;
    const sizes = SIZE_SETS[4]!;
    const rng = testRng(9);
    bank.set(0, sizes, randomGenome(sizes, rng));
    bank.set(2, sizes, randomGenome(sizes, rng));
    expect(() => bank.forward(3)).toThrow(/slot 1 holds no brain/);
    expect(() => bank.forwardSlots(Int32Array.of(2, 1), 2)).toThrow(/slot 1 holds no brain/);
    bank.release(2);
    expect(bank.isSet(2)).toBe(false);
    expect(() => bank.forwardSlots(Int32Array.of(0, 2), 2)).toThrow(/slot 2 holds no brain/);
  });

  it("forwardSlots runs the listed slots in any order, as forward does", async () => {
    const bank = (await WasmBrainBank.create())!;
    const rng = testRng(10);
    const n = 200;
    const sizes = (s: number) => SIZE_SETS[s % 4]!;
    for (let s = 0; s < n; s++) bank.set(s, sizes(s), randomGenome(sizes(s), rng));
    const list = Int32Array.from({ length: 150 }, (_, k) => (k * 37) % n);
    const inputs = Array.from(list, (s) => {
      const a = new Float32Array(sizes(s)[0]!);
      fillInput(a, rng);
      bank.f32.set(a, bank.inputAt(s));
      return a;
    });
    bank.forwardSlots(list, list.length);
    const viaList = Array.from(list, (s) => bank.f32.slice(bank.outputAt(s), bank.outputAt(s) + 2));
    list.forEach((s, k) => bank.f32.set(inputs[k]!, bank.inputAt(s)));
    bank.forward(n);
    list.forEach((s, k) => expect(Array.from(bank.f32.slice(bank.outputAt(s), bank.outputAt(s) + 2))).toEqual(Array.from(viaList[k]!)));
  });
});

describe("WasmRayCaster", () => {
  const world = { width: 1500, height: 1000 };
  const cfg = { ...DEFAULT_ECO_CONFIG, world: { ...DEFAULT_ECO_CONFIG.world, ...world } };

  function scene(seed: number, n: number) {
    const rng = createRng(seed);
    const states: CreatureState[] = Array.from({ length: n }, () => ({
      x: rng.range(0, world.width),
      y: rng.range(0, world.height),
      heading: rng.range(0, 7),
      vx: 0,
      vy: 0,
      turnRate: 0,
      energy: rng.range(0.5, 200),
      alive: true,
      ticksAlive: 0,
    }));
    const crowd = new Crowd(cfg);
    crowd.rebuild(states, n);
    return { rng, states, crowd };
  }

  const randomHits = (rays: number, L: number, rng: ReturnType<typeof createRng>): RayHit[] =>
    Array.from({ length: rays }, () => {
      const u = rng.next();
      if (u < 0.5) return { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
      return { closeness: rng.next(), kind: u < 0.8 ? HIT_FOOD : HIT_WALL, energy: 0, species: 0 };
    });

  it("matches Crowd.castRays over varied plans and starting hits", async () => {
    const caster = (await WasmRayCaster.create())!;
    const { rng, states, crowd } = scene(3, 600);
    caster.loadCrowd(crowd);
    const jobs = [];
    for (let v = 0; v < states.length; v += 2) {
      const rays = [1, 3, 8, 9, 16][v % 5]!;
      const spread = v % 7 === 0 ? 2 * Math.PI : rng.range(0.4, 3.5);
      const L = rng.range(50, 160);
      const offsets = rayAngleOffsets({ rayCount: rays, raySpread: spread });
      const dirX = Float64Array.from(offsets, (o) => Math.cos(states[v]!.heading + o));
      const dirY = Float64Array.from(offsets, (o) => Math.sin(states[v]!.heading + o));
      const start = randomHits(rays, L, rng);
      jobs.push({ v, L, dirX, dirY, js: start.map((h) => ({ ...h })), wasm: start.map((h) => ({ ...h })) });
    }
    for (const j of jobs) {
      crowd.castRays(states[j.v]!.x, states[j.v]!.y, j.dirX, j.dirY, j.js, j.v, j.L);
      caster.queue(states[j.v]!.x, states[j.v]!.y, j.dirX, j.dirY, j.wasm, j.v, j.L);
    }
    caster.run();
    caster.apply();
    let creatureHits = 0;
    let rays = 0;
    let maxDiff = 0;
    for (const j of jobs) {
      for (let i = 0; i < j.js.length; i++) {
        rays++;
        const a = j.js[i]!;
        const b = j.wasm[i]!;
        expect(b.kind).toBe(a.kind);
        maxDiff = Math.max(maxDiff, Math.abs(a.closeness - b.closeness));
        if (a.kind === HIT_CREATURE) {
          creatureHits++;
          expect(b.energy).toBe(a.energy);
        }
      }
    }
    expect(rays).toBeGreaterThan(2000);
    expect(creatureHits).toBeGreaterThan(100);
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it("grows its memory with the crowd and can be reused across ticks", async () => {
    const caster = (await WasmRayCaster.create())!;
    const before = caster.memoryBytes;
    for (const n of [50, 4000, 200]) {
      const { states, crowd } = scene(n, n);
      caster.loadCrowd(crowd);
      const js: RayHit[][] = [];
      const wasm: RayHit[][] = [];
      const offsets = rayAngleOffsets({ rayCount: 8, raySpread: 1.5 });
      for (let v = 0; v < n; v++) {
        const dirX = Float64Array.from(offsets, (o) => Math.cos(states[v]!.heading + o));
        const dirY = Float64Array.from(offsets, (o) => Math.sin(states[v]!.heading + o));
        js.push(Array.from({ length: 8 }, () => ({ closeness: 0, kind: HIT_NONE, energy: 0, species: 0 })));
        wasm.push(js[v]!.map((h) => ({ ...h })));
        crowd.castRays(states[v]!.x, states[v]!.y, dirX, dirY, js[v]!, v, 100);
        caster.queue(states[v]!.x, states[v]!.y, dirX, dirY, wasm[v]!, v, 100);
      }
      caster.run();
      caster.apply();
      let bad = 0;
      for (let v = 0; v < n; v++) for (let i = 0; i < 8; i++) if (js[v]![i]!.kind !== wasm[v]![i]!.kind || Math.abs(js[v]![i]!.closeness - wasm[v]![i]!.closeness) > 1e-4) bad++;
      expect(bad).toBe(0);
    }
    expect(caster.memoryBytes).toBeGreaterThan(before);
  });

  it("finds nothing for a creature far outside the world, without reading outside the grid", async () => {
    const caster = (await WasmRayCaster.create())!;
    const { crowd } = scene(5, 300);
    caster.loadCrowd(crowd);
    const offsets = rayAngleOffsets({ rayCount: 8, raySpread: 2 });
    const dirX = Float64Array.from(offsets, (o) => Math.cos(o));
    const dirY = Float64Array.from(offsets, (o) => Math.sin(o));
    const far = [[-5000, 500], [9000, 500], [700, -5000], [700, 9000], [-5000, -5000], [9000, 9000]];
    const outs = far.map((): RayHit[] => Array.from({ length: 8 }, () => ({ closeness: 0, kind: HIT_NONE, energy: 0, species: 0 })));
    far.forEach(([x, y], v) => caster.queue(x!, y!, dirX, dirY, outs[v]!, -1, 150));
    caster.run();
    caster.apply();
    for (const out of outs) for (const ray of out) expect(ray.kind).toBe(HIT_NONE);
  });

  it("needs a crowd first", async () => {
    const caster = (await WasmRayCaster.create())!;
    expect(() => caster.run()).toThrow(/loadCrowd/);
  });
});
