import { genomeLength, layerSizes } from "../sim/brain.ts";
import { remapWeights } from "../sim/planMutation.ts";
import { createRng } from "../sim/rng.ts";
import { layoutConfig } from "../sim/rl/env.ts";
import { OUTPUT_SIZE, inputLayout } from "../sim/sensors.ts";
import type { BodyPlan } from "../sim/sensors.ts";

// The add panel's tuning: a forager genome carried over to a new plan with the same number of hidden layers.
// Kept: each old ray's weights on the new ray nearest it in angle (other new rays start blind, zero weights), the body inputs,
// the memory units both plans have, and the hidden neurons both have. A new neuron gets small random input weights and zero output
// weights, so the brain computes as before until training uses it (planMutation.remapWeights). Spread and length need no change.
export function reshapeGenome(from: BodyPlan, genome: Float32Array, to: BodyPlan, seed = 1): Float32Array {
  if (from.hiddenLayers.length !== to.hiddenLayers.length) throw new Error("the number of hidden layers must stay the same");
  const config = layoutConfig("ecosystem");
  const a = inputLayout(config, from);
  const b = inputLayout(config, to);
  const F = b.rayFeatures;
  const inputs = new Int32Array(b.size).fill(-1);
  const used = new Set<number>();
  for (let r = 0; r < b.rays; r++) {
    const old = b.rays === 1 ? Math.floor((a.rays - 1) / 2) : Math.round((r * (a.rays - 1)) / (b.rays - 1));
    if (used.has(old)) continue;
    used.add(old);
    for (let f = 0; f < F; f++) inputs[r * F + f] = old * F + f;
  }
  const extras = a.memoryAt - a.rays * F; // body and terrain inputs between the rays and the memory
  for (let k = 0; k < extras; k++) inputs[b.rays * F + k] = a.rays * F + k;
  const memory = (n: number, oldStart: number, newStart: number, out: Int32Array, oldN: number): void => {
    for (let k = 0; k < Math.min(n, oldN); k++) out[newStart + k] = oldStart + k;
  };
  memory(to.memoryShort, a.memoryAt, b.memoryAt, inputs, from.memoryShort);
  memory(to.memoryLong, a.memoryAt + from.memoryShort, b.memoryAt + to.memoryShort, inputs, from.memoryLong);
  const outputs = new Int32Array(b.outputs).fill(-1);
  for (let k = 0; k < OUTPUT_SIZE; k++) outputs[k] = k;
  memory(to.memoryShort, OUTPUT_SIZE, OUTPUT_SIZE, outputs, from.memoryShort);
  memory(to.memoryLong, OUTPUT_SIZE + from.memoryShort, OUTPUT_SIZE + to.memoryShort, outputs, from.memoryLong);
  const hidden = to.hiddenLayers.map((n, l) => Int32Array.from({ length: n }, (_, j) => (j < from.hiddenLayers[l]! ? j : -1)));
  const oldSizes = layerSizes(config, from);
  if (genome.length !== genomeLength(oldSizes)) throw new Error("the genome does not fit its plan");
  const out = new Float32Array(genomeLength(layerSizes(config, to)));
  remapWeights(oldSizes, genome, [inputs, ...hidden, outputs], out, createRng(seed));
  return out;
}
