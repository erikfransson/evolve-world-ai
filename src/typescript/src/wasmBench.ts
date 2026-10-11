// Benchmark: JS vs WebAssembly SIMD brain kernel, per-call time for a batch of creatures, plus the largest difference between them.
// Usage: node src/wasmBench.ts [--sizes 1000,3000,10000] [--reps 20]

import { parseArgs } from "node:util";
import { Brain, layerSizes, randomGenome } from "./sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "./sim/ecoConfig.ts";
import { createRng } from "./sim/rng.ts";
import { planOf } from "./sim/sensors.ts";
import { WasmBrainBank } from "./sim/wasm/brainKernel.ts";

// parameters
const { values } = parseArgs({ options: { sizes: { type: "string", default: "1000,3000,10000" }, reps: { type: "string", default: "20" } } });
const counts = values.sizes!.split(",").map(Number);
const reps = Number(values.reps);
const plans = {
  default: { rayCount: 8, raySpread: 1.5, rayLength: 100, hidden: [16], memory: 0.25 },
  large: { rayCount: 16, raySpread: 3.1, rayLength: 160, hidden: [32, 32, 32, 32], memory: 1 },
};

const median = (f: () => void): number => {
  f();
  f();
  const t: number[] = [];
  for (let r = 0; r < reps; r++) {
    const a = performance.now();
    f();
    t.push(performance.now() - a);
  }
  return t.sort((x, y) => x - y)[t.length >> 1]!;
};

const bank = WasmBrainBank.createSync()!;
if (!bank) throw new Error("WebAssembly SIMD is not available");
const rng = createRng(1);
console.log("kernel   plan     creatures  JS ms   wasm ms  speedup  max abs diff");

for (const [name, p] of Object.entries(plans)) {
  const cfg = {
    ...DEFAULT_ECO_CONFIG,
    creature: { ...DEFAULT_ECO_CONFIG.creature, rayCount: p.rayCount, raySpread: p.raySpread, rayLength: p.rayLength },
    brain: { ...DEFAULT_ECO_CONFIG.brain, hiddenLayers: p.hidden, memory: p.memory },
  };
  const sizes = layerSizes(cfg, planOf(cfg));
  for (const n of counts) {
    const slots = Int32Array.from({ length: n }, (_, i) => i);
    const brains: Brain[] = [];
    const ins: Float32Array[] = [];
    const outs: Float32Array[] = [];
    for (let c = 0; c < n; c++) {
      const g = randomGenome(sizes, rng);
      brains.push(new Brain(sizes, g));
      bank.set(c, sizes, g);
      const input = new Float32Array(sizes[0]!);
      for (let r = 0; r < p.rayCount; r++) if (rng.next() < 0.5) (input[r * 6] = rng.next()), (input[r * 6 + 1 + rng.int(5)] = 1);
      input.fill(0.3, sizes[0]! - 4 - Math.round(16 * p.memory), sizes[0]!);
      ins.push(input);
      outs.push(new Float32Array(sizes.at(-1)!));
      bank.f32.set(input, bank.inputAt(c));
    }
    const jsMs = median(() => {
      for (let c = 0; c < n; c++) brains[c]!.forward(ins[c]!, outs[c]!);
    });
    const wasmMs = median(() => bank.forwardSlots(slots, n));
    let diff = 0;
    for (let c = 0; c < n; c++) {
      const got = bank.f32.subarray(bank.outputAt(c), bank.outputAt(c) + outs[c]!.length);
      for (let k = 0; k < got.length; k++) diff = Math.max(diff, Math.abs(got[k]! - outs[c]![k]!));
    }
    console.log(`brain    ${name.padEnd(8)} ${String(n).padStart(8)}  ${jsMs.toFixed(2).padStart(6)}  ${wasmMs.toFixed(2).padStart(7)}  ${(jsMs / wasmMs).toFixed(2).padStart(6)}x  ${diff.toExponential(1)}`);

  }
}
