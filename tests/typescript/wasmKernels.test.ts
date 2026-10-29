import { generatedSource } from "../../src/typescript/scripts/wasmAssemble.ts";
import { expandTemplates } from "../../src/typescript/scripts/watTemplate.ts";
import { Brain, genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { EXTRA_INPUTS, EXTRA_TERRAIN, INPUT_EXTRA_LABELS, inputLayout, planOf } from "../../src/typescript/src/sim/sensors.ts";
import { LAYOUT as L } from "../../src/typescript/src/sim/wasm/layout.ts";
import { WasmBrainBank } from "../../src/typescript/src/sim/wasm/brainKernel.ts";
import { setWasmDisabled, wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { SenseKernels } from "../../src/typescript/src/sim/wasm/senseKernels.ts";
import { readFileSync } from "node:fs";
import { testRng } from "./helpers.ts";

afterEach(() => setWasmDisabled(false));

describe("wasm toolchain", () => {
  it("kernels.generated.ts matches the .wat sources (run `npm run wasm` after editing them)", async () => {
    const committed = readFileSync(new URL("../../src/typescript/src/sim/wasm/kernels.generated.ts", import.meta.url), "utf8");
    expect(await generatedSource()).toBe(committed);
  });

  it("expands def, for and if templates and leaves layout names alone", () => {
    const text = "{{def reg i o}}(a@i @o){{end}}{{def grp n pf}}{{for i @n}}{{reg @i @o}}{{end}}{{if @pf}}P{{end}}{{end}}{{grp 3 1}}|{{grp 2 0}}|{{OFF}}";
    expect(expandTemplates(text, "t.wat", (n) => n === "OFF")).toBe("(a0 0)(a1 16)(a2 32)P|(a0 0)(a1 16)|{{OFF}}");
    expect(() => expandTemplates("{{nope}}", "t.wat", () => false)).toThrow(/unknown template/);
    expect(() => expandTemplates("{{for i 2}}x", "t.wat", () => false)).toThrow(/unclosed/);
    expect(() => expandTemplates("{{def m a}}{{end}}{{m}}", "t.wat", () => false)).toThrow(/takes 1/);
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

  it("rejects a run list on an empty bank with the usual error", () => {
    const bank = WasmBrainBank.createSync()!;
    new Int32Array(bank.memory.buffer).set([0], bank.runRegion(1) >> 2);
    expect(() => bank.forwardRun(1)).toThrow(/without a brain/);
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

describe("WasmBrainBank forwardRun", () => {
  it("runs a scrambled slot list by block address as forwardSlots does, across growth, reshapes, releases and stamp wraps", async () => {
    const bank = WasmBrainBank.createSync()!;
    const rng = testRng(21);
    const sizes = (s: number) => SIZE_SETS[s % 4]!;
    const outs = (list: number[]): number[][] => list.map((s) => Array.from(bank.f32.slice(bank.outputAt(s), bank.outputAt(s) + 2)));
    const inputs = new Map<number, Float32Array>();
    const feed = (list: number[]): void => {
      for (const s of list) {
        const a = new Float32Array(sizes(s)[0]!);
        fillInput(a, rng);
        inputs.set(s, a);
        bank.f32.set(a, bank.inputAt(s));
      }
    };
    const alive = new Set<number>();
    const idle = 999; // run in the first call only, so a stamp reused after the wrap would list it wrongly if the marks were not cleared
    for (let round = 0; round < 600; round++) {
      // births in new slots (growing the slot tables), reshapes of old ones and releases
      if (round === 0) { bank.set(idle, sizes(idle), randomGenome(sizes(idle), rng)); alive.add(idle); }
      const born = round < 5 ? 40 : 1 + (round % 3);
      for (let k = 0; k < born; k++) {
        const s = round < 5 ? alive.size - 1 : (round * 7 + k) % 300;
        bank.set(s, sizes(s + round), randomGenome(sizes(s + round), rng));
        alive.add(s);
      }
      if (round % 5 === 4) { const s = [...alive].filter((x) => x !== idle)[round % (alive.size - 1)]!; bank.release(s); alive.delete(s); }
      const list = [...alive].filter((s) => (s + round) % 4 !== 0 && (s !== idle || round === 0)).sort((a, b) => ((a * 7919 + round) % 101) - ((b * 7919 + round) % 101));
      feed(list);
      const slots = Int32Array.from(list);
      new Int32Array(bank.memory.buffer).set(slots, bank.runRegion(list.length) >> 2);
      bank.forwardRun(list.length);
      const viaRun = outs(list);
      list.forEach((s) => bank.f32.set(inputs.get(s)!, bank.inputAt(s)));
      bank.forwardSlots(slots, list.length);
      expect(outs(list)).toEqual(viaRun);
    }
  });

  it("rejects a run list with a slot that holds no brain or one that is listed twice", async () => {
    const bank = WasmBrainBank.createSync()!;
    const sizes = SIZE_SETS[4]!;
    const rng = testRng(22);
    for (const s of [0, 1, 3]) bank.set(s, sizes, randomGenome(sizes, rng));
    const run = (list: number[]): void => {
      new Int32Array(bank.memory.buffer).set(list, bank.runRegion(list.length) >> 2);
      bank.forwardRun(list.length);
    };
    run([3, 0, 1]);
    expect(() => run([3, 2, 1])).toThrow(/without a brain/); // slot 2 was never set
    expect(() => run([3, 3, 1])).toThrow(/or one twice/);
    expect(() => run([3, 900, 1])).toThrow(/without a brain/); // beyond the slot table
    bank.release(1);
    expect(() => run([3, 0, 1])).toThrow(/without a brain/);
    run([3, 0]);
  });
});
