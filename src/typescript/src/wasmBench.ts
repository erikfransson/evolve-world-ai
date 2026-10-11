// Benchmark: JS vs WebAssembly SIMD kernels, per-call time for a batch of creatures, plus the largest difference between them.
// Usage: node src/wasmBench.ts [--sizes 1000,3000,10000] [--reps 20]

import { parseArgs } from "node:util";
import { Brain, layerSizes, randomGenome } from "./sim/brain.ts";
import { Crowd } from "./sim/crowd.ts";
import { DEFAULT_ECO_CONFIG } from "./sim/ecoConfig.ts";
import { createRng } from "./sim/rng.ts";
import { planOf, rayAngleOffsets } from "./sim/sensors.ts";
import { HIT_NONE } from "./sim/types.ts";
import type { CreatureState, RayHit } from "./sim/types.ts";
import { WasmBrainBank } from "./sim/wasm/brainKernel.ts";
import { WasmRayCaster } from "./sim/wasm/rayKernel.ts";

// parameters
const { values } = parseArgs({ options: { sizes: { type: "string", default: "1000,3000,10000" }, reps: { type: "string", default: "20" } } });
const counts = values.sizes!.split(",").map(Number);
const reps = Number(values.reps);
const plans = {
  default: { rayCount: 8, raySpread: 1.5, rayLength: 100, hidden: [16], memory: 0.25 },
  large: { rayCount: 16, raySpread: 3.1, rayLength: 160, hidden: [32, 32, 32, 32], memory: 1 },
};
const SQUARE_PER_CREATURE = 5000; // world area per creature, as in the 2000-creature ecosystem profile

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

const bank = (await WasmBrainBank.create())!;
const caster = (await WasmRayCaster.create())!;
if (!bank || !caster) throw new Error("WebAssembly SIMD is not available");
const rng = createRng(1);
console.log("kernel   plan     creatures  JS ms   wasm ms  speedup  max abs diff   (rays: wasm = queue + run + apply, split in brackets)");

for (const [name, p] of Object.entries(plans)) {
  const cfg = {
    ...DEFAULT_ECO_CONFIG,
    creature: { ...DEFAULT_ECO_CONFIG.creature, rayCount: p.rayCount, raySpread: p.raySpread, rayLength: p.rayLength },
    brain: { ...DEFAULT_ECO_CONFIG.brain, hiddenLayers: p.hidden, memory: p.memory },
  };
  const sizes = layerSizes(cfg, planOf(cfg));
  for (const n of counts) {
    // Brain
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
    const wasmMs = median(() => bank.forward(n));
    let diff = 0;
    for (let c = 0; c < n; c++) {
      const got = bank.f32.subarray(bank.outputAt(c), bank.outputAt(c) + outs[c]!.length);
      for (let k = 0; k < got.length; k++) diff = Math.max(diff, Math.abs(got[k]! - outs[c]![k]!));
    }
    console.log(`brain    ${name.padEnd(8)} ${String(n).padStart(8)}  ${jsMs.toFixed(2).padStart(6)}  ${wasmMs.toFixed(2).padStart(7)}  ${(jsMs / wasmMs).toFixed(2).padStart(6)}x  ${diff.toExponential(1)}`);

    // Rays: world sized for a fixed density
    const side = Math.sqrt(n * SQUARE_PER_CREATURE);
    const wcfg = { ...cfg, world: { ...cfg.world, width: side * 1.6, height: side / 1.6 } };
    const states: CreatureState[] = Array.from({ length: n }, () => ({
      x: rng.range(0, wcfg.world.width),
      y: rng.range(0, wcfg.world.height),
      heading: rng.range(0, 7),
      vx: 0,
      vy: 0,
      turnRate: 0,
      energy: rng.range(1, 100),
      alive: true,
      ticksAlive: 0,
    }));
    const crowd = new Crowd(wcfg);
    crowd.rebuild(states, n);
    const offsets = rayAngleOffsets({ rayCount: p.rayCount, raySpread: p.raySpread });
    const dirX = states.map((s) => Float64Array.from(offsets, (o) => Math.cos(s.heading + o)));
    const dirY = states.map((s) => Float64Array.from(offsets, (o) => Math.sin(s.heading + o)));
    const fresh = (): RayHit[][] => states.map(() => Array.from({ length: p.rayCount }, () => ({ closeness: 0, kind: HIT_NONE, energy: 0 })));
    const jsRays = fresh();
    const wasmRays = fresh();
    const jsRayMs = median(() => {
      for (let v = 0; v < n; v++) crowd.castRays(states[v]!.x, states[v]!.y, dirX[v]!, dirY[v]!, jsRays[v]!, v, p.rayLength);
    });
    const wasmRayMs = median(() => {
      caster.loadCrowd(crowd);
      for (let v = 0; v < n; v++) caster.queue(states[v]!.x, states[v]!.y, dirX[v]!, dirY[v]!, wasmRays[v]!, v, p.rayLength);
      caster.run();
      caster.apply();
    });
    const queueMs = median(() => {
      caster.loadCrowd(crowd);
      for (let v = 0; v < n; v++) caster.queue(states[v]!.x, states[v]!.y, dirX[v]!, dirY[v]!, wasmRays[v]!, v, p.rayLength);
    });
    const runMs = median(() => caster.run());
    const applyMs = median(() => caster.apply());
    let rayDiff = 0;
    for (let v = 0; v < n; v++) for (let i = 0; i < p.rayCount; i++) rayDiff = Math.max(rayDiff, Math.abs(jsRays[v]![i]!.closeness - wasmRays[v]![i]!.closeness) + (jsRays[v]![i]!.kind !== wasmRays[v]![i]!.kind ? 1 : 0));
    console.log(`rays     ${name.padEnd(8)} ${String(n).padStart(8)}  ${jsRayMs.toFixed(2).padStart(6)}  ${wasmRayMs.toFixed(2).padStart(7)}  ${(jsRayMs / wasmRayMs).toFixed(2).padStart(6)}x  ${rayDiff.toExponential(1)}  [queue ${queueMs.toFixed(2)}, run ${runMs.toFixed(2)}, apply ${applyMs.toFixed(2)}]`);
  }
}
