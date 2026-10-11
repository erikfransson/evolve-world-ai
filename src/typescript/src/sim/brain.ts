import type { EngineConfig } from "./config.ts";
import { inputLayout, planOf } from "./sensors.ts";
import type { PlanView } from "./sensors.ts";
import type { Genome, Rng } from "./types.ts";

// Genome layout, per layer in order: weights row-major [out][in], then biases [out].

export function layerSizes(config: EngineConfig, plan: PlanView = planOf(config)): number[] {
  const layout = inputLayout(config, plan);
  return [layout.size, ...plan.hiddenLayers, layout.outputs];
}

type Typed = Float32Array | Float64Array | Int32Array;

// A length-n array on a's buffer when it is large enough, else a new one. Only for arrays that own their buffer.
export function refit<T extends Typed>(a: T, n: number): T {
  if (a.length === n) return a;
  const make = a.constructor as { new (buffer: ArrayBufferLike, offset: number, length: number): T; new (length: number): T };
  return a.buffer.byteLength >= n * a.BYTES_PER_ELEMENT ? new make(a.buffer, 0, n) : new make(n);
}

export function genomeLength(sizes: readonly number[]): number {
  let total = 0;
  for (let l = 0; l + 1 < sizes.length; l++) {
    total += sizes[l] * sizes[l + 1] + sizes[l + 1];
  }
  return total;
}

export function randomGenome(sizes: readonly number[], rng: Rng): Genome {
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
  private shape: readonly number[];
  private weightsGenome: Genome; // the brain's own copy; weights and biases view it
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
  private activeIndex = new Int32Array(0);
  private activeValue = new Float64Array(0);
  // First-layer weights stored input-major [in][out] as doubles, so one input's weights are contiguous.
  private firstLayerByInput = new Float64Array(0);

  constructor(sizes: readonly number[], genome: Genome) {
    if (genome.length !== genomeLength(sizes)) {
      throw new Error(`genome length ${genome.length} does not match expected ${genomeLength(sizes)}`);
    }
    this.shape = sizes.slice();
    this.weightsGenome = genome.slice();
    this.build();
  }

  get sizes(): readonly number[] {
    return this.shape;
  }

  get genome(): Readonly<Genome> {
    return this.weightsGenome;
  }

  // Lays out views and scratch for this.sizes over this.genome.
  private build(): void {
    const sizes = this.shape;
    const genome = this.weightsGenome;
    const layers = sizes.length - 1;
    this.weights.length = this.biases.length = this.fanIn.length = this.fanOut.length = 0;
    let offset = 0;
    for (let l = 0; l < layers; l++) {
      const inSize = sizes[l];
      const outSize = sizes[l + 1];
      this.weights.push(genome.subarray(offset, offset + inSize * outSize));
      offset += inSize * outSize;
      this.biases.push(genome.subarray(offset, offset + outSize));
      offset += outSize;
      this.fanIn.push(inSize);
      this.fanOut.push(outSize);
      if (l + 1 < layers) this.hidden[l] = refit(this.hidden[l] ?? new Float32Array(0), outSize);
    }
    this.hidden.length = layers - 1;
    this.activeIndex = refit(this.activeIndex, sizes[0]);
    this.activeValue = refit(this.activeValue, sizes[0]);
    this.firstLayerByInput = refit(this.firstLayerByInput, sizes[0] * sizes[1]);
    this.transposeFirstLayer();
    this.activations.length = 0;
    this.activations.push(new Float32Array(sizes[0]), ...this.hidden, new Float32Array(sizes[layers]));
  }

  // Copies genome into this brain's buffer, so a brain can be reused for another creature.
  // When sizes differ from the current ones, the brain takes the new layout first, reusing its buffers when they are large enough.
  load(sizes: readonly number[], genome: Genome): void {
    const length = genomeLength(sizes);
    if (genome.length !== length) throw new Error(`genome length ${genome.length} does not match expected ${length}`);
    if (sizes.length === this.shape.length && sizes.every((n, i) => n === this.shape[i])) {
      this.weightsGenome.set(genome);
      this.transposeFirstLayer();
      return;
    }
    this.shape = sizes.slice();
    this.weightsGenome = refit(this.weightsGenome, length);
    this.weightsGenome.set(genome);
    this.build();
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

  // Records input as the last forward's input, for a caller that runs this brain elsewhere (WASM); the other layers go stale.
  showInput(input: Float32Array): void {
    this.activations[0] = input;
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
