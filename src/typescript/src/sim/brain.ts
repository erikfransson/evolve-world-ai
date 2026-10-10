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

// Padé (7,6) tanh, clamped to [-1, 1]; max abs error about 1e-4.
export function fastTanh(x: number): number {
  if (x >= 4.97) return 1;
  if (x <= -4.97) return -1;
  const x2 = x * x;
  const r = (x * (135135 + x2 * (17325 + x2 * (378 + x2)))) / (135135 + x2 * (62370 + x2 * (3150 + 28 * x2)));
  return r > 1 ? 1 : r < -1 ? -1 : r;
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
  // Scratch for the nonzero inputs of the first layer.
  private readonly activeIndex: Int32Array;
  private readonly activeValue: Float64Array;

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
    this.activeIndex = new Int32Array(sizes[0]);
    this.activeValue = new Float64Array(sizes[0]);
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
      if (l === 0) this.sparseLayer(input, dst);
      else this.denseLayer(l, src, dst);
      src = dst;
    }
  }

  // First layer: skips zero inputs (mostly one-hot ray flags). Adding w * 0 leaves a finite sum unchanged, so results are identical.
  private sparseLayer(input: Float32Array, dst: Float32Array): void {
    const w = this.weights[0];
    const b = this.biases[0];
    const nIn = this.fanIn[0];
    const nOut = this.fanOut[0];
    const idx = this.activeIndex;
    const val = this.activeValue;
    let n = 0;
    for (let i = 0; i < nIn; i++) {
      const v = input[i];
      if (v !== 0) {
        idx[n] = i;
        val[n++] = v;
      }
    }
    for (let j = 0; j < nOut; j++) {
      let sum = b[j];
      const row = j * nIn;
      for (let k = 0; k < n; k++) sum += w[row + idx[k]] * val[k];
      dst[j] = fastTanh(sum);
    }
  }

  private denseLayer(l: number, src: Float32Array, dst: Float32Array): void {
    const w = this.weights[l];
    const b = this.biases[l];
    const nIn = this.fanIn[l];
    const nOut = this.fanOut[l];
    for (let j = 0; j < nOut; j++) {
      let sum = b[j];
      const row = j * nIn;
      for (let i = 0; i < nIn; i++) sum += w[row + i] * src[i];
      dst[j] = fastTanh(sum);
    }
  }
}
