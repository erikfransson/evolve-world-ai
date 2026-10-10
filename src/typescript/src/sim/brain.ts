import type { EngineConfig } from "./config.ts";
import { OUTPUT_SIZE, inputSize } from "./sensors.ts";
import type { Genome, Rng } from "./types.ts";

// Genome layout, per layer in order: weights row-major [out][in], then biases [out].

export function layerSizes(config: EngineConfig): number[] {
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
  readonly genome: Genome; // the constructor's buffer, which weights and biases view
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
  // First-layer weights stored input-major [in][out] as doubles, so one input's weights are contiguous.
  private readonly firstLayerByInput: Float64Array;

  constructor(sizes: number[], genome: Genome) {
    if (genome.length !== genomeLength(sizes)) {
      throw new Error(`genome length ${genome.length} does not match expected ${genomeLength(sizes)}`);
    }
    this.sizes = sizes.slice();
    this.genome = genome;
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
    this.firstLayerByInput = new Float64Array(sizes[0] * sizes[1]);
    this.transposeFirstLayer();
    this.activations = [new Float32Array(sizes[0]), ...this.hidden, new Float32Array(sizes[sizes.length - 1])];
  }

  // Copies genome into this brain's buffer, so a brain can be reused for another creature.
  load(genome: Genome): void {
    if (genome.length !== this.genome.length) throw new Error(`genome length ${genome.length} does not match expected ${this.genome.length}`);
    this.genome.set(genome);
    this.transposeFirstLayer();
  }

  private transposeFirstLayer(): void {
    const nIn = this.fanIn[0];
    const nOut = this.fanOut[0];
    for (let j = 0; j < nOut; j++) {
      for (let i = 0; i < nIn; i++) this.firstLayerByInput[i * nOut + j] = this.weights[0][j * nIn + i];
    }
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
    const wt = this.firstLayerByInput;
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
    // Four outputs at a time keep the running sums in registers; each sum still adds in input order.
    let j = 0;
    for (; j + 4 <= nOut; j += 4) {
      let s0 = b[j];
      let s1 = b[j + 1];
      let s2 = b[j + 2];
      let s3 = b[j + 3];
      for (let k = 0; k < n; k++) {
        const p = idx[k] * nOut + j;
        const v = val[k];
        s0 += wt[p] * v;
        s1 += wt[p + 1] * v;
        s2 += wt[p + 2] * v;
        s3 += wt[p + 3] * v;
      }
      dst[j] = fastTanh(s0);
      dst[j + 1] = fastTanh(s1);
      dst[j + 2] = fastTanh(s2);
      dst[j + 3] = fastTanh(s3);
    }
    for (; j < nOut; j++) {
      let s = b[j];
      for (let k = 0; k < n; k++) s += wt[idx[k] * nOut + j] * val[k];
      dst[j] = fastTanh(s);
    }
  }

  private denseLayer(l: number, src: Float32Array, dst: Float32Array): void {
    const w = this.weights[l];
    const b = this.biases[l];
    const nIn = this.fanIn[l];
    const nOut = this.fanOut[l];
    // Two outputs at a time overlap their dependent add chains; each sum still adds in input order.
    let j = 0;
    for (; j + 2 <= nOut; j += 2) {
      let s0 = b[j];
      let s1 = b[j + 1];
      const row = j * nIn;
      for (let i = 0; i < nIn; i++) {
        const v = src[i];
        s0 += w[row + i] * v;
        s1 += w[row + nIn + i] * v;
      }
      dst[j] = fastTanh(s0);
      dst[j + 1] = fastTanh(s1);
    }
    for (; j < nOut; j++) {
      let sum = b[j];
      const row = j * nIn;
      for (let i = 0; i < nIn; i++) sum += w[row + i] * src[i];
      dst[j] = fastTanh(sum);
    }
  }
}
