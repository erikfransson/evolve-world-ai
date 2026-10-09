import type { SimConfig } from "./config.ts";
import { OUTPUT_SIZE, inputSize } from "./sensors.ts";
import type { Genome, Rng } from "./types.ts";

// Genome layout, per layer in order: weights row-major [out][in], then biases [out].

export function layerSizes(config: SimConfig): number[] {
  return [inputSize(config), ...config.brain.hiddenLayers, OUTPUT_SIZE];
}

export function genomeLength(sizes: number[]): number {
  let total = 0;
  for (let l = 0; l + 1 < sizes.length; l++) {
    total += sizes[l] * sizes[l + 1] + sizes[l + 1];
  }
  return total;
}

export function randomGenome(sizes: number[], rng: Rng): Genome {
  const genome = new Float32Array(genomeLength(sizes));
  let offset = 0;
  for (let l = 0; l + 1 < sizes.length; l++) {
    const fanIn = sizes[l];
    const count = sizes[l] * sizes[l + 1];
    const scale = 1 / Math.sqrt(fanIn);
    for (let k = 0; k < count; k++) genome[offset + k] = rng.normal() * scale;
    offset += count + sizes[l + 1]; // biases stay at 0
  }
  return genome;
}

export class Brain {
  readonly sizes: readonly number[];
  // Per layer views into the genome: weights row-major [out][in], biases [out].
  readonly weights: Float32Array[] = []; // treat as read-only
  readonly biases: Float32Array[] = [];
  private readonly fanIn: number[] = [];
  private readonly fanOut: number[] = [];
  // Hidden activations only; the output layer writes straight into the caller's buffer.
  private readonly hidden: Float32Array[] = [];
  // [input, ...hidden, output] of the last forward call; the ends are the caller's buffers.
  private readonly activations: Float32Array[] = [];

  constructor(sizes: number[], genome: Genome) {
    if (genome.length !== genomeLength(sizes)) {
      throw new Error(`genome length ${genome.length} does not match expected ${genomeLength(sizes)}`);
    }
    this.sizes = sizes.slice();
    let offset = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      const inSize = sizes[l];
      const outSize = sizes[l + 1];
      this.weights.push(genome.subarray(offset, offset + inSize * outSize));
      offset += inSize * outSize;
      this.biases.push(genome.subarray(offset, offset + outSize));
      offset += outSize;
      this.fanIn.push(inSize);
      this.fanOut.push(outSize);
      if (l + 2 < sizes.length) this.hidden.push(new Float32Array(outSize));
    }
    this.activations = [new Float32Array(sizes[0]), ...this.hidden, new Float32Array(sizes[sizes.length - 1])];
  }

  // Valid after forward; before that the input and output are zeros. The array is reused, not a copy.
  layerActivations(): readonly Float32Array[] {
    return this.activations;
  }

  forward(input: Float32Array, output: Float32Array): void {
    const layers = this.fanIn.length;
    this.activations[0] = input;
    this.activations[layers] = output;
    let src = input;
    for (let l = 0; l < layers; l++) {
      const dst = l === layers - 1 ? output : this.hidden[l];
      const w = this.weights[l];
      const b = this.biases[l];
      const nIn = this.fanIn[l];
      const nOut = this.fanOut[l];
      for (let j = 0; j < nOut; j++) {
        let sum = b[j];
        const row = j * nIn;
        for (let i = 0; i < nIn; i++) sum += w[row + i] * src[i];
        dst[j] = Math.tanh(sum);
      }
      src = dst;
    }
  }
}
