import { generatedSource } from "../../src/typescript/scripts/wasmAssemble.ts";
import { Brain, genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Crowd } from "../../src/typescript/src/sim/crowd.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { EXTRA_INPUTS, EXTRA_TERRAIN, INPUT_EXTRA_LABELS, inputLayout, planOf } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_CREATURE, HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import { LAYOUT as L } from "../../src/typescript/src/sim/wasm/layout.ts";
import { WasmBrainBank } from "../../src/typescript/src/sim/wasm/brainKernel.ts";
import { setWasmDisabled, wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { speciesEngine, speciesList } from "../../src/typescript/src/sim/species.ts";
import { prepareRows } from "../../src/typescript/src/sim/wasm/residentStep.ts";
import { rockLowerBound } from "../../src/typescript/src/sim/wasm/senser.ts";
import { SenseKernels } from "../../src/typescript/src/sim/wasm/senseKernels.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { Creature, SenseBatch } from "../../src/typescript/src/sim/creature.ts";
import { World } from "../../src/typescript/src/sim/world.ts";
import { readFileSync } from "node:fs";
import { testRng } from "./helpers.ts";

afterEach(() => setWasmDisabled(false));

describe("wasm toolchain", () => {
  it("kernels.generated.ts matches the .wat sources (run `npm run wasm` after editing them)", async () => {
    const committed = readFileSync(new URL("../../src/typescript/src/sim/wasm/kernels.generated.ts", import.meta.url), "utf8");
    expect(await generatedSource()).toBe(committed);
  });

  it("the layout fits the sense record, the brain input extras and the row", () => {
    const f64 = [L.REC_X, L.REC_Y, L.REC_COS, L.REC_SIN, L.REC_RAY_LENGTH];
    const i32 = [L.REC_SELF, L.REC_RAYS, L.REC_OFFSETS, L.REC_INPUT, L.REC_DETAIL];
    expect(L.REC_BYTES).toBe(1 << L.REC_SHIFT);
    expect(f64.map((o, i) => o - 8 * i)).toEqual([0, 0, 0, 0, 0]); // consecutive f64
    expect(i32[0]).toBeGreaterThanOrEqual(8 * f64.length);
    expect(i32.map((o, i) => o - 4 * i - i32[0]!)).toEqual([0, 0, 0, 0, 0]);
    expect(L.REC_DETAIL + 4).toBeLessThanOrEqual(L.REC_BYTES);
    // fill.wat copies a row's x, y and cos, sin as f64x2 and its rays, offsets, input and slot as one v128
    expect([L.R_Y - L.R_X, L.R_SIN - L.R_COS]).toEqual([8, 8]);
    expect([L.R_OFFSETS, L.R_INPUT, L.R_SLOT].map((o) => o - L.R_RAYS)).toEqual([4, 8, 12]);
    expect(L.R_RAYS + 16).toBeLessThanOrEqual(L.ROW_BYTES);
    expect(L.EXTRAS).toBe(EXTRA_INPUTS);
    expect(L.UNITS_AT).toBe(4 * EXTRA_INPUTS); // the memory units follow the f32 extras
    expect([L.R_EXTRA_SPEED, L.R_EXTRA_SIDE, L.R_EXTRA_TURN, L.R_EXTRA_GROUND]).toEqual([1, 2, 3, 4].map((i) => L.R_EXTRAS + 8 * i));
    expect(INPUT_EXTRA_LABELS.slice(1)).toEqual(["speed", "lateral", "turn", "terrain"]);
    expect(L.R_OUT).toBe(L.R_EXTRAS + 8 * EXTRA_INPUTS); // the f64 extras end where the i32 fields begin
    expect(EXTRA_TERRAIN).toBe(EXTRA_INPUTS - 1);
    const sense = Object.entries(L).filter(([k]) => k.startsWith("S_") && k !== "S_BYTES").map(([k, v]) => [k, v] as const);
    const size = (k: string): number => (/_(WORLD_W|WORLD_H|ITEM_R|INV_ITEM_CELL|ROCK_MAX_R|INV_ROCK_CELL)$/.test(k) ? 8 : 4);
    for (const [k, v] of sense) expect(v % size(k), k).toBe(0); // naturally aligned
    for (const [k, v] of sense) expect(v + size(k), k).toBeLessThanOrEqual(L.S_BYTES);
    const spans = sense.map(([k, v]) => [v, v + size(k)] as const).sort((a, b) => a[0] - b[0]);
    spans.slice(1).forEach(([from], i) => expect(from).toBeGreaterThanOrEqual(spans[i]![1])); // no two fields overlap
  });

  it("detects WebAssembly SIMD here", () => {
    expect(wasmAvailable()).toBe(true);
  });
});

describe("fallback", () => {
  it("create returns null when WebAssembly is disabled", async () => {
    setWasmDisabled(true);
    expect(wasmAvailable()).toBe(false);
    expect(WasmBrainBank.createSync()).toBeNull();
    expect(SenseKernels.create(DEFAULT_ECO_CONFIG)).toBeNull();
    setWasmDisabled(false);
    expect(WasmBrainBank.createSync()).not.toBeNull();
  });
});

// Runs slots 0 .. n-1.
const runFirst = (bank: WasmBrainBank, n: number): void => bank.forwardSlots(Int32Array.from({ length: n }, (_, i) => i), n);

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
    const bank = WasmBrainBank.createSync()!;
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
      runFirst(bank, brains.length);
      for (let slot = 0; slot < brains.length; slot++) {
        const got = bank.f32.subarray(bank.outputAt(slot), bank.outputAt(slot) + outs[slot]!.length);
        for (let k = 0; k < got.length; k++) maxAbs = Math.max(maxAbs, Math.abs(got[k]! - outs[slot]![k]!));
      }
    }
    expect(maxAbs).toBeLessThan(2e-6);
  });

  it("sums only the non-zero inputs for any input length, zero pattern and output width", async () => {
    const bank = WasmBrainBank.createSync()!;
    const rng = testRng(21);
    let slot = 0;
    let maxAbs = 0;
    for (let nIn = 1; nIn <= 70; nIn++) {
      for (const nOut of [1, 4, 5, 8, 13]) {
        const sizes = [nIn, 6, nOut];
        const g = randomGenome(sizes, rng);
        bank.set(slot, sizes, g);
        const input = new Float32Array(nIn);
        if (slot % 3 !== 0) for (let i = 0; i < nIn; i++) input[i] = rng.next() < (slot % 3 === 1 ? 0.3 : 0.04) ? rng.next() * 2 - 1 : rng.next() < 0.1 ? -0 : 0; // slot % 3 === 0: all zero, 2: sparse so whole groups of 16 are zero
        bank.f32.set(input, bank.inputAt(slot));
        const want = new Float32Array(nOut);
        new Brain(sizes, g).forward(input, want);
        bank.forwardSlots(Int32Array.of(slot), 1);
        const got = bank.f32.subarray(bank.outputAt(slot), bank.outputAt(slot) + nOut);
        for (let k = 0; k < nOut; k++) maxAbs = Math.max(maxAbs, Math.abs(got[k]! - want[k]!));
        slot++;
      }
    }
    expect(maxAbs).toBeLessThan(2e-6);
  });

  it("holds a brain with the eight hidden layers a save may carry, and no more (the descriptor's layer cap)", () => {
    const bank = WasmBrainBank.createSync()!;
    const rng = testRng(34);
    const eight = [8, 5, 5, 5, 5, 5, 5, 5, 5, 3]; // 6 + 8 plan entries in ecoState's restore check
    bank.set(0, eight, randomGenome(eight, rng), 0);
    const nine = [...eight.slice(0, 9), 5, 3];
    expect(() => bank.set(1, nine, randomGenome(nine, rng), 0)).toThrow(/layer sizes/);
  });

  it("gives the same output bits wherever the first layer is split between the ray rows and the rest", async () => {
    const bank = WasmBrainBank.createSync()!;
    const rng = testRng(33);
    const run = (slot: number, sizes: number[], g: Float32Array, rays: number, input: Float32Array): number[] => {
      bank.set(slot, sizes, g, rays);
      bank.f32.set(input, bank.inputAt(slot));
      bank.forwardSlots(Int32Array.of(slot), 1);
      return Array.from(bank.f32.subarray(bank.outputAt(slot), bank.outputAt(slot) + sizes[sizes.length - 1]!));
    };
    for (const sizes of SIZE_SETS) {
      const g = randomGenome(sizes, rng);
      const nIn = sizes[0]!;
      for (let round = 0; round < 4; round++) {
        const input = new Float32Array(nIn);
        fillInput(input, rng);
        if (round === 3) input.fill(0);
        const want = run(0, sizes, g, 0, input);
        for (const rays of new Set([1, nIn >> 1, nIn - 1, nIn])) if (rays >= 1 && rays <= nIn) expect(run(1, sizes, g, rays, input)).toEqual(want);
        for (const rays of [nIn, 0, 1]) expect(run(1, sizes, g, rays, input)).toEqual(want); // the same slot set again with a bigger, smaller and no ray region
      }
    }
  });

  it("saturates large sums to exactly +-1 like the JS tanh", async () => {
    const bank = WasmBrainBank.createSync()!;
    const sizes = [2, 2];
    const g = Float32Array.of(100, 0, 0, -100, 0, 0);
    bank.set(0, sizes, g);
    bank.f32.set([1, 1], bank.inputAt(0));
    runFirst(bank, 1);
    expect(Array.from(bank.f32.subarray(bank.outputAt(0), bank.outputAt(0) + 2))).toEqual([1, -1]);
  });

  it("keeps results correct while linear memory grows, and reuses a slot of the same size", async () => {
    const bank = WasmBrainBank.createSync()!;
    const sizes = SIZE_SETS[0]!;
    const rng = testRng(8);
    const startBytes = bank.memory.buffer.byteLength;
    const genomes: Float32Array[] = [];
    const n = 3000;
    for (let slot = 0; slot < n; slot++) {
      genomes.push(randomGenome(sizes, rng));
      bank.set(slot, sizes, genomes[slot]!);
    }
    expect(bank.memory.buffer.byteLength).toBeGreaterThan(startBytes + 5_000_000);
    const input = new Float32Array(sizes[0]!);
    fillInput(input, rng);
    for (let slot = 0; slot < n; slot++) bank.f32.set(input, bank.inputAt(slot));
    runFirst(bank, n);
    const want = new Float32Array(sizes[sizes.length - 1]!);
    for (const slot of [0, 1, 1500, n - 1]) {
      new Brain(sizes, genomes[slot]!).forward(input, want);
      const got = bank.f32.subarray(bank.outputAt(slot), bank.outputAt(slot) + want.length);
      for (let k = 0; k < want.length; k++) expect(got[k]).toBeCloseTo(want[k]!, 5);
    }
    const grown = bank.memory.buffer.byteLength;
    bank.set(5, sizes, genomes[7]!);
    expect(bank.memory.buffer.byteLength).toBe(grown);
    bank.set(5, SIZE_SETS[3]!, randomGenome(SIZE_SETS[3]!, rng)); // another shape moves the slot
    bank.f32.set(new Float32Array(SIZE_SETS[3]![0]!), bank.inputAt(5));
    runFirst(bank, 6);
    expect(Array.from(bank.f32.subarray(bank.outputAt(5), bank.outputAt(5) + 2)).every(Number.isFinite)).toBe(true);
  });

  it("compact() closes the holes of released blocks, keeps every output, and reports the moved slots", async () => {
    const bank = WasmBrainBank.createSync()!;
    const rng = testRng(12);
    const n = 600;
    const run = (slots: number[]): Map<number, number[]> => {
      for (const s of slots) {
        const a = new Float32Array(SIZE_SETS[s % SIZE_SETS.length]![0]!);
        fillInput(a, testRng(s));
        bank.f32.set(a, bank.inputAt(s));
      }
      bank.forwardSlots(Int32Array.from(slots), slots.length);
      return new Map(slots.map((s) => [s, Array.from(bank.f32.subarray(bank.outputAt(s), bank.outputAt(s) + SIZE_SETS[s % SIZE_SETS.length]!.at(-1)!))]));
    };
    for (let slot = 0; slot < n; slot++) bank.set(slot, SIZE_SETS[slot % SIZE_SETS.length]!, randomGenome(SIZE_SETS[slot % SIZE_SETS.length]!, rng));
    const kept: number[] = [];
    for (let slot = 0; slot < n; slot++) if (slot % 3 === 0 || slot % 7 === 0) bank.release(slot); else kept.push(slot);
    const before = run(kept);
    const moved = new Set<number>();
    bank.onMove = (slot) => moved.add(slot);
    const span = (): number => Math.max(...kept.map((s) => bank.inputAt(s))) - Math.min(...kept.map((s) => bank.inputAt(s)));
    const spanBefore = span();
    for (let i = 0; i < 20; i++) bank.compact();
    expect(moved.size).toBeGreaterThan(0);
    expect(span()).toBeLessThan(spanBefore);
    expect(run(kept)).toEqual(before);
    const settled = moved.size;
    bank.compact();
    expect(moved.size).toBe(settled); // nothing left to move
    for (let slot = 0; slot < n; slot += 3) if (!kept.includes(slot)) bank.set(slot, SIZE_SETS[2]!, randomGenome(SIZE_SETS[2]!, rng)); // refills the holes at the end
    expect(run(kept)).toEqual(before);
  });

  it("readGenome rebuilds the stored genome bit for bit, for every size set, with and without a ray region, and after blocks moved", async () => {
    const bank = WasmBrainBank.createSync()!;
    const rng = testRng(31);
    const genomes = new Map<number, Float32Array>();
    const rays = (sizes: readonly number[], k: number): number => [0, 1, sizes[0]!, Math.floor(sizes[0]! / 2)][k % 4]!;
    const n = 400;
    for (let slot = 0; slot < n; slot++) {
      const sizes = SIZE_SETS[slot % SIZE_SETS.length]!;
      const g = randomGenome(sizes, rng);
      genomes.set(slot, g);
      bank.set(slot, sizes, g, rays(sizes, slot));
    }
    const same = (slot: number): void => {
      const sizes = SIZE_SETS[slot % SIZE_SETS.length]!;
      const out = new Float32Array(genomeLength(sizes));
      bank.readGenome(slot, out);
      expect(Buffer.from(out.buffer).equals(Buffer.from(genomes.get(slot)!.buffer))).toBe(true);
    };
    for (let slot = 0; slot < n; slot++) same(slot);
    const kept: number[] = [];
    for (let slot = 0; slot < n; slot++) if (slot % 3 === 0 || slot % 7 === 0) bank.release(slot); else kept.push(slot);
    for (let i = 0; i < 20; i++) bank.compact();
    for (const slot of kept) same(slot);
    for (let slot = 0; slot < n; slot += 3) { // refilled holes and a changed layout in a used slot
      const sizes = SIZE_SETS[(slot + 1) % SIZE_SETS.length]!;
      const g = randomGenome(sizes, rng);
      bank.set(slot, sizes, g, rays(sizes, slot + 1));
      genomes.set(slot, g);
      const out = new Float32Array(g.length);
      bank.readGenome(slot, out);
      expect(Buffer.from(out.buffer).equals(Buffer.from(g.buffer))).toBe(true);
    }
    for (const slot of kept) same(slot);
  });

  it("rejects bad shapes", async () => {
    const bank = WasmBrainBank.createSync()!;
    expect(() => bank.set(0, [3], new Float32Array(0))).toThrow(/layer sizes/);
    expect(() => bank.set(0, [3, 2], new Float32Array(3))).toThrow(/genome length/);
    expect(() => bank.set(0, [3, 2000], new Float32Array(genomeLength([3, 2000])))).toThrow(/exceeds/);
    expect(inputLayout(DEFAULT_ECO_CONFIG).size).toBeGreaterThan(0);
    runFirst(bank, 0);
  });

  it("never runs an unset or released slot", async () => {
    const bank = WasmBrainBank.createSync()!;
    const sizes = SIZE_SETS[4]!;
    const rng = testRng(9);
    bank.set(0, sizes, randomGenome(sizes, rng));
    bank.set(2, sizes, randomGenome(sizes, rng));
    expect(() => runFirst(bank, 3)).toThrow(/slot 1 holds no brain/);
    expect(() => bank.forwardSlots(Int32Array.of(2, 1), 2)).toThrow(/slot 1 holds no brain/);
  });

  it("forwardSlots runs the listed slots in any order, as running the first n in order does", async () => {
    const bank = WasmBrainBank.createSync()!;
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
    runFirst(bank, n);
    list.forEach((s, k) => expect(Array.from(bank.f32.slice(bank.outputAt(s), bank.outputAt(s) + 2))).toEqual(Array.from(viaList[k]!)));
  });
});

describe("sense.wat (SenseKernels)", () => {
  type Spot = [number, number, number]; // x, y, heading
  interface Setup {
    width?: number;
    height?: number;
    rays: number;
    spread: number;
    length?: number;
    itemRadius?: number;
    creatures: Spot[];
    items?: [number, number, number][]; // x, y, kind
    map?: Partial<SimConfig["world"]>; // stones, ridges and ground (terrain.ts) on top of the size
    species?: number; // species count; creature k is of species k % species, and rays carry one flag per species
  }

  function build(o: Setup) {
    const base = DEFAULT_ECO_CONFIG;
    const names = Array.from({ length: o.species ?? 0 }, (_, i) => `s${i}`);
    const cfg = {
      ...base,
      species: names.map((name) => ({ name, hue: -1, hueSpread: 360, plants: true, prey: [], eatEfficiency: 0, eatBaseline: 0 })),
      world: { ...base.world, width: o.width ?? 1200, height: o.height ?? 800, ...(o.itemRadius === undefined ? {} : { itemRadius: o.itemRadius }), ...o.map },
     creature: { ...base.creature, rayCount: o.rays, raySpread: o.spread, rayLength: o.length ?? 100 },
    };
    const eng = o.species ? speciesEngine(cfg, speciesList(cfg)[0]!) : cfg; // what a creature of the ecosystem runs on
    const world = new World(cfg, 400);
    (o.items ?? []).forEach(([x, y, kind], i) => world.setItem(i, x, y, kind as 1 | 2));
    const rng = createRng(3);
    const kernels = SenseKernels.create(cfg)!;
    kernels.store.species.push(eng); // the config the rows' species index 0 stands for
    const kernel = o.creatures.map(([x, y, h]) => {
      const g = randomGenome(layerSizes(cfg, planOf(cfg)), rng);
      const c = new Creature(eng, g, x, y, h, undefined, kernels); // resident, as in an Ecosystem
      return c;
    });
    const reference = o.creatures.map(([x, y, h], k) => new Creature(eng, kernel[k]!.brain.genome.slice(), x, y, h));
    const states = kernel.map((c) => c.state);
    states.forEach((s, k) => (s.energy = 10 + 37 * k));
    reference.forEach((c, k) => (c.state.energy = states[k]!.energy));
    return { cfg, world, kernels, kernel, reference, speciesOf: Int32Array.from(kernel, (_, k) => (o.species ? k % o.species : 0)) };
  }

  // The sense kernels on the batch of resident creatures, as Ecosystem.sensePhase runs them on its members.
  function run(kernels: SenseKernels, world: World, crowd: Crowd, batch: SenseBatch): void {
    const rows = Int32Array.from({ length: batch.count }, (_, k) => batch.creatures[k]!.resident!.ptr);
    prepareRows(kernels.store, rows, batch.count, world.terrain);
    kernels.runRows(world, crowd, rows, batch.selves, batch.count, kernels.detail);
  }

  // Runs the kernel with each creature in turn as the detail one and compares rays and brain input with the JS sense.
  // exact: no creature is in sight of another, so the f32 crowd path does not enter and every bit must agree.
  function check(o: Setup, exact: boolean) {
    const { cfg, world, kernels, kernel, reference, speciesOf } = build(o);
    const crowd = new Crowd(cfg);
    crowd.rebuild(kernel.map((c) => c.state), kernel.length, speciesOf);
    const batch = new SenseBatch();
    kernel.forEach((c, k) => batch.add(c, k));
    reference.forEach((c, k) => {
      c.sense(world, crowd, k);
      c.encode();
    });
    let bad = 0;
    const seen = new Set<number>();
    const species = new Set<number>();
    kernel.forEach((c, k) => {
      kernels.detail = c;
      run(kernels, world, crowd, batch);
      const ref = reference[k]!;
      c.rays.forEach((ray, i) => {
        seen.add(ray.kind);
        if (ray.kind === HIT_CREATURE) species.add(ray.species);
        const want = ref.rays[i]!;
        if (exact) {
          expect(ray.kind).toBe(want.kind);
          expect(ray.closeness).toBe(want.closeness);
        } else if (ray.kind !== want.kind || Math.abs(ray.closeness - want.closeness) > 1e-4 || (ray.kind === HIT_CREATURE && (ray.energy !== want.energy || ray.species !== want.species))) bad++;
      });
      const got = c.brain.layerActivations()[0]!;
      const want = ref.encode();
      expect(got.length).toBe(want.length);
      if (exact) expect(Array.from(got)).toEqual(Array.from(want));
      else for (let i = 0; i < got.length; i++) if (Math.abs(got[i]! - want[i]!) > 1e-4) bad++;
      expect(Array.from(c.outputs).every(Number.isFinite)).toBe(true);
    });
    return { bad, seen, species, world, crowd, kernels, batch, kernel, reference, rays: kernel.length * o.rays };
  }

  const items: [number, number, number][] = [];
  const itemRng = createRng(11);
  for (let i = 0; i < 300; i++) items.push([itemRng.range(4, 1196), itemRng.range(4, 796), 1 + (i % 3 === 0 ? 1 : 0)]);

  it("matches the JS rays bit for bit next to walls and in corners", () => {
    const r = 12;
    const spots: Spot[] = [[r, r, 5.5], [1200 - r, 800 - r, 2.4], [r, 800 - r, -1], [1200 - r, r, 3.5], [600, r, 1.6], [-300, 400, 0.7], [1300, 900, 4]];
    const { seen } = check({ rays: 9, spread: 1.5, creatures: spots, items }, true);
    expect(seen).toContain(HIT_WALL);
    expect(seen).toContain(HIT_FOOD);
    expect(seen).toContain(HIT_NONE);
  });

  it("matches with a full 360 degree fan, and with one ray", () => {
    check({ rays: 12, spread: 2 * Math.PI, creatures: [[300, 300, 0.3], [20, 400, 3], [1190, 790, 5]], items }, true);
    check({ rays: 1, spread: 0, creatures: [[300, 300, 0.3], [20, 400, 3]], items }, true);
  });

  it("matches the JS rays for items grazing the rays, where the cheap ray prefilter and the exact test meet", () => {
    const r = DEFAULT_ECO_CONFIG.world.itemRadius;
    const rng = createRng(21);
    const spots: Spot[] = [[600, 400, 0.9], [333.3, 222.2, 4.1], [900.7, 600.1, 2.2]];
    const graze: [number, number, number][] = [];
    spots.forEach(([x, y, h]) => {
      for (let i = 0; i < 90; i++) {
        const a = h + (i % 9 - 4) * 0.35; // near the direction of a 9 ray fan of spread 1.4
        const d = rng.range(5, 95);
        const side = (i % 2 ? 1 : -1) * r * (1 + (rng.range(0, 1) - 0.5) * 4e-3); // perpendicular offset within 0.2% of the radius
        graze.push([x + d * Math.cos(a) - side * Math.sin(a), y + d * Math.sin(a) + side * Math.cos(a), 1 + (i % 3 === 0 ? 1 : 0)]);
      }
    });
    const { seen } = check({ rays: 9, spread: 1.4, creatures: spots, items: graze }, true);
    expect(seen).toContain(HIT_FOOD);
  });

  it("matches the JS rays for items a few float steps either side of the exact-test boundary, for any item radius", () => {
    const ulp = 2 ** -15; // spacing of f32 values in [256, 512)
    check({ rays: 1, spread: 0, width: 6000, length: 5000, itemRadius: 0, creatures: [[500, 100, 0]], items: [[4500, 100 + 2.29e-5, 1]] }, true); // far item, rounding makes the discriminant 0
    for (const itemRadius of [4, 1e-4, 0]) {
      const items: [number, number, number][] = [];
      for (let i = 0; i < 10; i++) {
        for (let j = -3; j <= 3; j++) {
          if (j === 0 && itemRadius === 0) continue; // an item on the ray would hide the grazing ones behind it
          items.push([3000 + 200 * i, 400 + itemRadius + j * ulp, 1], [3100 + 200 * i, 400 - itemRadius + j * ulp, 2]);
        }
      }
      const rng = createRng(9);
      for (let i = 0; i < 40; i++) items.push([rng.range(3000, 5000), 400 + rng.range(-1, 1) * itemRadius, 1]);
      check({ rays: 1, spread: 0, width: 6000, length: 5000, itemRadius, creatures: [[600, 400, 0]], items }, true);
      check({ rays: 3, spread: 1e-3, width: 6000, length: 5000, itemRadius, creatures: [[600, 400, 0]], items }, true);
    }
  });

  it("handles a plan with zero rays", () => {
    const { kernel } = check({ rays: 0, spread: 0, creatures: [[300, 300, 0.3], [400, 300, 1]], items }, true);
    expect(kernel[0]!.rays.length).toBe(0);
  });

  it("agrees with JS on an item exactly at the ray length, and a hair either side", () => {
    const r = DEFAULT_ECO_CONFIG.world.itemRadius;
    for (const d of [0, -1e-3, 1e-3, -0.5, 0.5]) {
      const { rays } = check({ rays: 1, spread: 0, length: 100, creatures: [[200, 300, 0]], items: [[200 + 100 + r + d, 300, 1]] }, true);
      expect(rays).toBe(1);
    }
    check({ rays: 3, spread: 0.2, length: 100, creatures: [[200, 300, 0]], items: [[200 + 100 + r, 300, 2], [200 + 100, 300 + r, 1], [250, 300, 2]] }, true);
  });

  it("matches the JS rays bit for bit around rock, and sees the ground under each creature", () => {
    const map = { stoneDensity: 0.06, ridgeDensity: 0.05, slowDensity: 0.1, fastDensity: 0.1 };
    const t = terrainOf({ seed: DEFAULT_ECO_CONFIG.seed, world: { width: 3000, height: 2000, ...map } });
    const rng = createRng(21);
    const spots: Spot[] = [];
    for (let tries = 0; spots.length < 24 && tries < 20000; tries++) {
      const d = rng.int(t.rockCount);
      const near = t.rockR[d]! + rng.range(5, 220);
      const a = rng.range(0, 2 * Math.PI);
      const hug = tries % 2 === 0; // half the spots hug rock, half lie anywhere, so mud and firm ground are both under some
      const x = hug ? t.rockX[d]! + near * Math.cos(a) : rng.range(20, 2980);
      const y = hug ? t.rockY[d]! + near * Math.sin(a) : rng.range(20, 1980);
      const apart = spots.every(([sx, sy]) => Math.hypot(sx - x, sy - y) > 300); // out of each other's sight, so the f32 crowd path stays out of it
      if (apart && x > 12 && y > 12 && x < 2988 && y < 1988 && !t.touchesRock(x, y, 12)) spots.push([x, y, rng.range(0, 2 * Math.PI)]);
    }
    const some = items.map(([x, y, k]) => [x * 2.5, y * 2.5, k] as [number, number, number]);
    const { seen } = check({ width: 3000, height: 2000, rays: 10, spread: 3, length: 150, creatures: spots, items: some, map }, true);
    expect(seen).toContain(HIT_WALL);
    const grounds = new Set(spots.map(([x, y]) => t.valueAt(x, y)));
    expect(grounds.size).toBeGreaterThan(1);
    check({ width: 3000, height: 2000, rays: 6, spread: 2 * Math.PI, length: 250, creatures: spots, map }, true);
  });

  it("matches the JS rays for rock discs whose tangent lies on the edge ray of the fan, a hair inside and outside the widened wedge", () => {
    const map = { stoneDensity: 0.06, ridgeDensity: 0.05, slowDensity: 0.1, fastDensity: 0.1 };
    const t = terrainOf({ seed: DEFAULT_ECO_CONFIG.seed, world: { width: 3000, height: 2000, ...map } });
    for (const [rays, spread] of [[8, 1], [7, 2.5], [5, 0.4]] as const) {
      const rng = createRng(33);
      const spots: Spot[] = [];
      for (let tries = 0; spots.length < 30 && tries < 40000; tries++) {
        const d = rng.int(t.rockCount);
        const r = t.rockR[d]!;
        const dist = r + rng.range(5, 140);
        const a = rng.range(0, 2 * Math.PI);
        const x = t.rockX[d]! + dist * Math.cos(a);
        const y = t.rockY[d]! + dist * Math.sin(a);
        const eps = [0, 1e-9, -1e-9, 1e-6, -1e-6, 0.03, -0.03][tries % 7]!;
        const side = tries % 2 ? 1 : -1;
        const edge = (tries >> 1) % 2 ? 1 : -1;
        const heading = Math.atan2(t.rockY[d]! - y, t.rockX[d]! - x) + side * Math.asin(r / dist) + eps - (edge * spread) / 2; // the tangent ray of the disc along one edge ray
        const apart = spots.every(([sx, sy]) => Math.hypot(sx - x, sy - y) > 300);
        if (apart && x > 12 && y > 12 && x < 2988 && y < 1988 && !t.touchesRock(x, y, 12)) spots.push([x, y, heading]);
      }
      expect(spots.length).toBeGreaterThan(15);
      const { seen } = check({ width: 3000, height: 2000, rays, spread, length: 150, creatures: spots, map }, true);
      expect(seen).toContain(HIT_WALL);
    }
  });

  it("breaks exact ties between items in different cells and in one cell by grid order, as World.castRays does", () => {
    const r = DEFAULT_ECO_CONFIG.world.itemRadius;
    expect(r).toBe(4);
    // One ray along +x (dy is exactly 0), so items mirrored about its line have identical hit distances.
    // Ray length 100 makes the grid cell 100, so y = 300 is a row boundary: y 298 is the row before y 302.
    const across = (foodY: number, poisonY: number) =>
      check({ rays: 1, spread: 0, length: 100, creatures: [[200, 300, 0]], items: [[250, foodY, 1], [250, poisonY, 2]] }, true).kernel[0]!.rays[0]!.kind;
    expect(across(298, 302)).toBe(HIT_FOOD); // the earlier row's item wins
    expect(across(302, 298)).toBe(HIT_POISON);
    // Same cell (y 250 in row 2, rows are 100 tall): the last placed item heads the cell's list.
    const within = (items: [number, number, number][]) => check({ rays: 1, spread: 0, length: 100, creatures: [[200, 250, 0]], items }, true).kernel[0]!.rays[0]!.kind;
    expect(within([[250, 248, 1], [250, 252, 2]])).toBe(HIT_POISON);
    expect(within([[250, 248, 2], [250, 252, 1]])).toBe(HIT_FOOD);
  });

  it("sees item changes between runs, such as an item eaten or placed mid-tick", () => {
    const o: Setup = { rays: 5, spread: 1, creatures: [[300, 300, 0]], items: [[360, 300, 1], [380, 305, 2]] };
    const { world, crowd, kernels, batch, kernel, reference } = check(o, true);
    for (const step of [() => world.removeItem(0), () => world.setItem(0, 340, 295, 2), () => world.removeItem(1)]) {
      step();
      reference[0]!.sense(world, crowd, 0);
      kernels.detail = kernel[0]!;
      run(kernels, world, crowd, batch);
      kernel[0]!.rays.forEach((ray, i) => {
        expect(ray.kind).toBe(reference[0]!.rays[i]!.kind);
        expect(ray.closeness).toBe(reference[0]!.rays[i]!.closeness);
      });
    }
  });

  it("keeps matching while items move in and out of crowded cells, and when a row outgrows its packed run", () => {
    const o: Setup = { rays: 7, spread: 2, creatures: [[300, 250, 0.4], [700, 250, 3]], items };
    const { world, crowd, kernels, batch, kernel, reference } = check(o, true);
    const rng = createRng(5);
    const agree = () => {
      kernel.forEach((c, k) => {
        reference[k]!.sense(world, crowd, k);
        kernels.detail = c;
        run(kernels, world, crowd, batch);
        c.rays.forEach((ray, i) => {
          expect(ray.kind).toBe(reference[k]!.rays[i]!.kind);
          expect(ray.closeness).toBe(reference[k]!.rays[i]!.closeness);
        });
      });
    };
    for (let round = 0; round < 30; round++) {
      for (let k = 0; k < 20; k++) {
        const i = Math.floor(rng.range(0, 400));
        if (round < 20 && k % 3 === 0) world.removeItem(i);
        else world.setItem(i, rng.range(4, 1196), 230 + rng.range(0, 40), (1 + (k % 2)) as 1 | 2); // crowd the row of the creatures
      }
      agree();
    }
  });

  // Checks the packed item rows against the cell lists, item for item; returns the slots of a row's run (where row 1 starts).
  function expectPacked(kernels: SenseKernels, world: World): number {
    const t = kernels.itemTables(world)!;
    const buf = kernels.f32.buffer;
    const start = new Int32Array(buf, t.start, world.rows * (t.cols + 1));
    const ids = new Int32Array(buf, t.ids);
    const xy = new Float32Array(buf, t.xy);
    for (let row = 0; row < world.rows; row++) {
      for (let cx = 0; cx < t.cols; cx++) {
        let p = start[row * (t.cols + 1) + cx]!;
        for (let i = world.cellHead[row * t.cols + cx]!; i >= 0; i = world.nextItem[i]!, p++) {
          expect(ids[p]).toBe(i);
          expect(xy[2 * p]).toBe(world.xs[i]);
          expect(xy[2 * p + 1]).toBe(world.ys[i]);
        }
        expect(start[row * (t.cols + 1) + cx + 1]).toBe(p);
      }
    }
    return start[t.cols + 1]!;
  }

  it("keeps the packed item rows equal to the cell lists, item for item, over many changes in one row, repeated cells and rebuilds", () => {
    const o: Setup = { rays: 3, spread: 1, creatures: [[300, 250, 0.4]], items };
    const { world, crowd, kernels, batch } = check(o, true);
    const rng = createRng(9);
    const packed = () => {
      run(kernels, world, crowd, batch);
      expectPacked(kernels, world);
    };
    packed();
    for (let round = 0; round < 40; round++) {
      const n = round % 10 === 9 ? 400 : 1 + (round % 7) * 5; // every tenth round changes so many cells that the list is dropped and all is packed again
      for (let k = 0; k < n; k++) {
        const i = Math.floor(rng.range(0, 400));
        if (k % 3 === 0) world.removeItem(i);
        else world.setItem(i, rng.range(4, 1196), round % 2 ? 230 + rng.range(0, 40) : rng.range(4, 796), (1 + (k % 2)) as 1 | 2);
      }
      packed();
    }
  });

  it("packs the item rows again when more than 1024 cells changed or a row outgrew its run, and only then", () => {
    const rng = createRng(13);
    const spot = (y0: number): [number, number] => [rng.range(4, 3996), y0 < 0 ? rng.range(4, 3996) : y0 + rng.range(10, 90)];
    const own = Array.from({ length: 300 }, (_, i): [number, number, number] => [...spot(i < 60 ? 1200 : -1), 1 + (i % 2)]); // row 12 the widest
    const { world, crowd, kernels, batch } = check({ rays: 3, spread: 1, creatures: [[300, 250, 0.4]], items: own, width: 4000, height: 4000 }, true);
    expect(world.cols * world.rows).toBeGreaterThan(1024); // the dirty list can pass 1024 cells before it is dropped
    const sync = () => {
      run(kernels, world, crowd, batch);
      return expectPacked(kernels, world);
    };
    const place = (i: number, y0: number) => world.setItem(i, ...spot(y0), (1 + (i % 2)) as 1 | 2);
    let cap = sync();
    // A few changes a tick, the widest row growing within its run: patched in place, so the run keeps its length.
    for (let tick = 0; tick < 5; tick++) {
      place(60 + 2 * tick, 1200);
      place(61 + 2 * tick, 1200);
      for (let k = 0; k < 6; k++) place(100 + Math.floor(rng.range(0, 200)), -1);
      expect(sync()).toBe(cap);
    }
    // Every item moved twice: more than 1024 dirty cells, packed again whole with the run fitted to the new widest row.
    for (let i = 0; i < 300; i++) {
      place(i, -1);
      place(i, -1);
    }
    expect(world.dirtyCells!.length).toBeGreaterThan(1024);
    const whole = sync();
    expect(whole).not.toBe(cap);
    cap = whole;
    // Eight items a tick poured into row 20: patched until the row outgrows its run, then packed again with a longer one.
    let grew = 0;
    for (let tick = 0, next = 300; tick < 14; tick++) {
      for (let k = 0; k < 8; k++) place(next++ % 400, 2000);
      let n = 0;
      for (let c = 20 * world.cols; c < 21 * world.cols; c++) for (let i = world.cellHead[c]!; i >= 0; i = world.nextItem[i]!) n++;
      const now = sync();
      if (n <= cap) expect(now).toBe(cap);
      else {
        expect(now).toBeGreaterThan(n);
        grew++;
      }
      cap = now;
    }
    expect(grew).toBeGreaterThan(0);
  });

  it("sees other creatures with their energy, within f32 rounding of the JS crowd rays", () => {
    const rng = createRng(7);
    const spots: Spot[] = Array.from({ length: 120 }, () => [rng.range(0, 600), rng.range(0, 400), rng.range(0, 7)]);
    const { bad, rays } = check({ width: 600, height: 400, rays: 8, spread: 2, length: 120, creatures: spots, items: items.filter(([x, y]) => x < 600 && y < 400) }, false);
    expect(rays).toBe(960);
    expect(bad).toBeLessThanOrEqual(2);
  });

  it("writes one flag per species and the energy after them, as the JS encoding does", () => {
    const rng = createRng(21);
    const spots: Spot[] = Array.from({ length: 120 }, () => [rng.range(0, 600), rng.range(0, 400), rng.range(0, 7)]);
    const { bad, species, kernel } = check({ width: 600, height: 400, rays: 8, spread: 2, length: 120, creatures: spots, items: items.filter(([x, y]) => x < 600 && y < 400), species: 3 }, false);
    expect([...species].sort()).toEqual([0, 1, 2]);
    expect(kernel[0]!.brain.layerActivations()[0]!.length).toBe(8 * (5 + 3) + 5 + 4);
    expect(bad).toBeLessThanOrEqual(2);
    check({ rays: 6, spread: 2, creatures: [[300, 300, 0], [900, 600, 2]], items, species: 2 }, true); // no creature in sight: flags all zero, exact
    const one = check({ width: 600, height: 400, rays: 8, spread: 2, length: 120, creatures: spots, items: items.filter(([x, y]) => x < 600 && y < 400), species: 1 }, false); // one species: the single flag of a seen creature is 1
    expect([...one.species]).toEqual([0]);
    expect(one.kernel[0]!.brain.layerActivations()[0]!.length).toBe(8 * 6 + 5 + 4);
    expect(one.bad).toBeLessThanOrEqual(2);
  });

  it("reads the outputs in place across a kernel memory growth", () => {
    const { kernel, kernels } = check({ rays: 4, spread: 1, creatures: [[300, 300, 0], [320, 300, 3], [700, 500, 1]], items }, false);
    const before = kernel.map((c) => Array.from(c.outputs));
    const bank = (kernels as unknown as { brains: WasmBrainBank }).brains;
    const old = bank.memory.buffer;
    bank.alloc(20_000_000); // grows the memory, detaching the old buffer
    expect(old.byteLength).toBe(0);
    kernel.forEach((c, k) => {
      expect(Array.from(c.outputs)).toEqual(before[k]);
      expect(Number.isFinite(c.drain)).toBe(true);
    });
  });

  it("runs a creature reset with a new genome and plan as that one, without the caller attaching it again", () => {
    const { cfg, world, kernels, kernel } = build({ rays: 6, spread: 1.5, creatures: [[300, 300, 0.3]], items });
    const c = kernel[0]!;
    const plan = { ...c.plan, rayCount: 4, raySpread: 1, hiddenLayers: [5, 3] };
    const genome = randomGenome(layerSizes(cfg, plan), createRng(8));
    c.reset(genome, 320, 310, 1.1, 50, plan);
    const reference = new Creature(cfg, genome.slice(), 320, 310, 1.1, plan);
    reference.state.energy = 50;
    const crowd = new Crowd(cfg);
    crowd.rebuild([c.state], 1);
    const batch = new SenseBatch();
    batch.add(c, 0);
    run(kernels, world, crowd, batch);
    reference.senseThink(world, crowd, 0);
    expect(c.outputs.length).toBe(reference.outputs.length);
    c.outputs.forEach((v, i) => expect(Math.abs(v - reference.outputs[i]!)).toBeLessThan(1e-4));
  });

  it("shares ray offset tables between creatures with the same offsets, and frees a table when its last creature changes plan", () => {
    const { cfg, kernels, kernel } = build({ rays: 6, spread: 1.5, creatures: [[300, 300, 0], [400, 300, 1], [500, 300, 2], [600, 300, 3]], items });
    const tableOf = (c: Creature): number => new Int32Array(kernels.f32.buffer)[(c.resident!.ptr + L.R_OFFSETS) >> 2]!;
    const [a, b, c, d] = kernel as [Creature, Creature, Creature, Creature];
    expect(new Set(kernel.map(tableOf)).size).toBe(1);
    const reset = (cr: Creature, spread: number): void => {
      const plan = { ...cr.plan, raySpread: spread };
      cr.reset(randomGenome(layerSizes(cfg, plan), createRng(5)), 300, 300, 0, 50, plan);
    };
    const shared = tableOf(a);
    reset(d, 1.1);
    expect(tableOf(d)).not.toBe(shared);
    reset(c, 1.1);
    expect(tableOf(c)).toBe(tableOf(d));
    reset(a, 1.1);
    reset(b, 1.1); // the last holder of the first table lets go, and the next new table takes its block
    reset(a, 0.9);
    expect(tableOf(a)).toBe(shared);
    expect(tableOf(b)).toBe(tableOf(c));
  });

  it("bounds the distance to the nearest rock edge from below for every point of a cell", () => {
    const rng = createRng(21);
    const cols = 9;
    const rows = 7;
    const cell = 300;
    const n = 40;
    const x = Float64Array.from({ length: n }, () => rng.range(0, cols * cell));
    const y = Float64Array.from({ length: n }, () => rng.range(0, rows * cell));
    const r = Float64Array.from({ length: n }, () => rng.range(10, 380));
    const lb = rockLowerBound(cols, rows, cell, x, y, r, n);
    for (let t = 0; t < 4000; t++) {
      const px = rng.range(0, cols * cell);
      const py = rng.range(0, rows * cell);
      let edge = Infinity;
      for (let d = 0; d < n; d++) edge = Math.min(edge, Math.hypot(px - x[d]!, py - y[d]!) - r[d]!);
      const bound = lb[Math.floor(py / cell) * cols + Math.floor(px / cell)]!;
      expect(bound).toBeLessThanOrEqual(Math.max(0, edge));
    }
    expect(Math.max(...lb)).toBeGreaterThan(0);
  });

  it("writes the same brain input for creatures that see nothing (early-out) as the full path of the detail creature, over any species count", () => {
    for (const species of [0, 1, 3]) {
      const rng = createRng(40 + species);
      const spots: Spot[] = Array.from({ length: 60 }, () => [rng.range(-20, 1220), rng.range(-20, 820), rng.range(0, 7)]);
      for (let i = 0; i < 6; i++) spots.push([300 + 30 * i, 300, i]); // a clump, so some see each other
      const sparse = items.filter((_, i) => i % 6 === 0);
      const { kernel, world, crowd, kernels, batch } = check({ rays: 8, spread: 1.5, length: 100, creatures: spots, items: sparse, species }, false);
      const bank = (kernels as unknown as { brains: WasmBrainBank }).brains;
      const inputView = (c: Creature): Float32Array => bank.f32.subarray(bank.inputAt(c.kernelSlot), bank.inputAt(c.kernelSlot) + c.brain.layerActivations()[0]!.length);
      const inputOf = (c: Creature): number[] => Array.from(inputView(c));
      const blank = (): void => kernel.forEach((c) => inputView(c).fill(NaN)); // only the sense kernel writes the ray part after the fill kernel's body inputs
      let empty = 0;
      kernel.forEach((c, k) => {
        blank();
        kernels.detail = c; // the full path for this creature, the early-out for any other that sees nothing
        run(kernels, world, crowd, batch);
        const full = inputOf(c);
        blank();
        kernels.detail = null;
        run(kernels, world, crowd, batch);
        expect(inputOf(c)).toEqual(full);
        const rayPart = full.slice(0, c.rays.length * (5 + species));
        if (rayPart.every((v) => v === 0)) empty++;
        expect(Object.is(rayPart.find((v) => v === 0), -0)).toBe(false);
      });
      expect(empty).toBeGreaterThan(10);
      expect(empty).toBeLessThan(kernel.length);
    }
  });

  it("writes the same brain input for creatures that see items but no creature as the full path of the detail creature, over ray counts, species counts and walls", () => {
    for (const [rays, species] of [[7, 0], [8, 1], [9, 3], [1, 2]] as const) {
      const rng = createRng(60 + rays);
      const spots: Spot[] = Array.from({ length: 50 }, () => [rng.range(-20, 1220), rng.range(-20, 820), rng.range(0, 7)]);
      for (let i = 0; i < 4; i++) spots.push([6 + 3 * i, 400 + 9 * i, i], [1194 - 3 * i, 5 + 9 * i, 2 + i]); // against the left and right walls, a few in sight of each other
      const { kernel, world, crowd, kernels, batch } = check({ rays, spread: 1.5, length: 100, creatures: spots, items, species }, false);
      const bank = (kernels as unknown as { brains: WasmBrainBank }).brains;
      const inputOf = (c: Creature): number[] => Array.from(bank.f32.subarray(bank.inputAt(c.kernelSlot), bank.inputAt(c.kernelSlot) + c.brain.layerActivations()[0]!.length));
      const blank = (): void => kernel.forEach((c) => bank.f32.subarray(bank.inputAt(c.kernelSlot), bank.inputAt(c.kernelSlot) + c.brain.layerActivations()[0]!.length).fill(NaN));
      let itemsOnly = 0;
      kernel.forEach((c) => {
        blank();
        kernels.detail = c;
        run(kernels, world, crowd, batch);
        const full = inputOf(c);
        blank();
        kernels.detail = null;
        run(kernels, world, crowd, batch);
        expect(inputOf(c)).toEqual(full);
        if (c.rays.every((r) => r.kind !== HIT_CREATURE) && c.rays.some((r) => r.kind === HIT_FOOD || r.kind === HIT_POISON || r.kind === HIT_WALL)) itemsOnly++;
      });
      expect(itemsOnly).toBeGreaterThan(10);
    }
  });

  it("keeps the rays of non-detail creatures untouched and needs no detail", () => {
    const { kernel, world, crowd, kernels, batch } = check({ rays: 4, spread: 1, creatures: [[300, 300, 0], [320, 300, 3]], items }, false);
    kernel[1]!.rays[0]!.closeness = 0.123;
    kernels.detail = kernel[0]!;
    run(kernels, world, crowd, batch);
    expect(kernel[1]!.rays[0]!.closeness).toBe(0.123);
    kernels.detail = null;
    run(kernels, world, crowd, batch);
  });
});
