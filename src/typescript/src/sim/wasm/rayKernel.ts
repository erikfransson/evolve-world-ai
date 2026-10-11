import type { Crowd } from "../crowd.ts";
import { HIT_CREATURE } from "../types.ts";
import type { RayHit } from "../types.ts";
import { Kernel, RAYS_BYTES } from "./loader.ts";

// Batched Crowd.castRays on f32x4 SIMD with the same wedge cull.
// Per tick: loadCrowd(crowd) after rebuild, queue() each creature (same arguments as Crowd.castRays), run(), apply().
// The crowd's positions become f32, so a ray that just grazes a creature at the edge of its range may differ from the JS result.

const REC_WORDS = 8;

interface RayExports extends WebAssembly.Exports {
  cast(n: number, cols: number, rows: number, inv: number, r: number, start: number, sx: number, sy: number, own: number, rec: number, dX: number, dY: number, best: number, hit: number, cand: number): void;
}

const align = (n: number): number => (n + 15) & ~15;

export class WasmRayCaster {
  private readonly kernel: Kernel<RayExports>;
  private crowd: Crowd | undefined;
  private n = 0;
  private rayTotal = 0;
  // Staging, copied into linear memory by run(). rec is shared as floats and ints.
  private recBuffer = new ArrayBuffer(64 * REC_WORDS * 4);
  private recF = new Float32Array(this.recBuffer);
  private recI = new Int32Array(this.recBuffer);
  private dirX = new Float32Array(256);
  private dirY = new Float32Array(256);
  private best = new Float32Array(256);
  private outs: (readonly RayHit[])[] = [];
  // Results of the last run, views into linear memory.
  private resBest = new Float32Array(0);
  private resHit = new Int32Array(0);

  private constructor(kernel: Kernel<RayExports>) {
    this.kernel = kernel;
  }

  // Null when WebAssembly SIMD is unavailable (or disabled); keep using Crowd.castRays then.
  static async create(): Promise<WasmRayCaster | null> {
    const kernel = await Kernel.create<RayExports>(RAYS_BYTES);
    return kernel ? new WasmRayCaster(kernel) : null;
  }

  static createSync(): WasmRayCaster | null {
    const kernel = Kernel.createSync<RayExports>(RAYS_BYTES);
    return kernel ? new WasmRayCaster(kernel) : null;
  }

  get memoryBytes(): number {
    return this.kernel.memory.buffer.byteLength;
  }

  // Takes the crowd's cell-sorted arrays for the following queue and run calls; call after crowd.rebuild.
  loadCrowd(crowd: Crowd): void {
    this.crowd = crowd;
    this.n = 0;
    this.rayTotal = 0;
    this.outs.length = 0;
  }

  // Queues one creature; the arguments are those of Crowd.castRays. Returns its index for apply order.
  queue(x: number, y: number, dirX: Float64Array, dirY: Float64Array, out: readonly RayHit[], self: number, L: number): number {
    const j = this.n++;
    const rays = out.length;
    const at = this.rayTotal;
    const padded = (rays + 3) & ~3;
    this.rayTotal += padded;
    if (j * REC_WORDS >= this.recF.length) this.growRec();
    if (this.rayTotal > this.dirX.length) this.growRays(this.rayTotal);
    const r = j * REC_WORDS;
    this.recF[r] = x;
    this.recF[r + 1] = y;
    this.recF[r + 2] = L;
    this.recI[r + 3] = self;
    this.recI[r + 4] = rays;
    this.recI[r + 5] = at;
    for (let i = 0; i < rays; i++) {
      this.dirX[at + i] = dirX[i]!;
      this.dirY[at + i] = dirY[i]!;
      const ray = out[i]!;
      this.best[at + i] = ray.kind === 0 ? L : (1 - ray.closeness) * L;
    }
    for (let i = rays; i < padded; i++) {
      this.dirX[at + i] = 0;
      this.dirY[at + i] = 0;
      this.best[at + i] = L;
    }
    this.outs[j] = out;
    return j;
  }

  // Runs the kernel over the queued creatures.
  run(): void {
    const crowd = this.crowd;
    if (!crowd) throw new Error("loadCrowd first");
    const cells = crowd.cols * crowd.rows;
    const count = crowd.count;
    let o = 0;
    const take = (bytes: number): number => {
      const p = o;
      o += align(bytes);
      return p;
    };
    const pStart = take((cells + 1) * 4);
    const pSx = take(count * 4);
    const pSy = take(count * 4);
    const pOwn = take(count * 4);
    const pRec = take(this.n * REC_WORDS * 4);
    const pDX = take(this.rayTotal * 4);
    const pDY = take(this.rayTotal * 4);
    const pBest = take(this.rayTotal * 4);
    const pHit = take(this.rayTotal * 4);
    const pCand = take(count * 16 + 16);
    this.kernel.ensure(o);
    const buffer = this.kernel.memory.buffer;
    new Int32Array(buffer, pStart, cells + 1).set(crowd.cellStart);
    const sx = new Float32Array(buffer, pSx, count);
    const sy = new Float32Array(buffer, pSy, count);
    const own = new Int32Array(buffer, pOwn, count);
    for (let k = 0; k < count; k++) {
      sx[k] = crowd.xs[k]!;
      sy[k] = crowd.ys[k]!;
      own[k] = crowd.owners[k]!;
    }
    new Float32Array(buffer, pRec, this.n * REC_WORDS).set(this.recF.subarray(0, this.n * REC_WORDS));
    new Float32Array(buffer, pDX, this.rayTotal).set(this.dirX.subarray(0, this.rayTotal));
    new Float32Array(buffer, pDY, this.rayTotal).set(this.dirY.subarray(0, this.rayTotal));
    new Float32Array(buffer, pBest, this.rayTotal).set(this.best.subarray(0, this.rayTotal));
    this.kernel.exports.cast(this.n, crowd.cols, crowd.rows, 1 / crowd.cell, crowd.radius, pStart, pSx, pSy, pOwn, pRec, pDX, pDY, pBest, pHit, pCand);
    this.resBest = new Float32Array(buffer, pBest, this.rayTotal);
    this.resHit = new Int32Array(buffer, pHit, this.rayTotal);
  }

  // Overwrites each queued ray whose nearest creature is nearer than what it held, as Crowd.castRays does.
  apply(): void {
    const crowd = this.crowd!;
    for (let j = 0; j < this.n; j++) {
      const r = j * REC_WORDS;
      const at = this.recI[r + 5]!;
      const L = this.recF[r + 2]!;
      const out = this.outs[j]!;
      for (let i = 0; i < out.length; i++) {
        const k = this.resHit[at + i]!;
        if (k < 0) continue;
        const ray = out[i]!;
        ray.closeness = 1 - this.resBest[at + i]! / L;
        ray.kind = HIT_CREATURE;
        ray.energy = crowd.energies[k]!;
      }
    }
  }

  private growRec(): void {
    const buffer = new ArrayBuffer(this.recBuffer.byteLength * 2);
    new Uint8Array(buffer).set(new Uint8Array(this.recBuffer));
    this.recBuffer = buffer;
    this.recF = new Float32Array(buffer);
    this.recI = new Int32Array(buffer);
  }

  private growRays(n: number): void {
    const size = Math.max(n, 2 * this.dirX.length);
    for (const key of ["dirX", "dirY", "best"] as const) {
      const grown = new Float32Array(size);
      grown.set(this[key]);
      this[key] = grown;
    }
  }
}
