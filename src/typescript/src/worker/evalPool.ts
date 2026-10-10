import type { SimConfig } from "../sim/config.ts";
import { evaluateRange } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import type { Population } from "../sim/population.ts";
import { FRAME_FLOATS, gatherGenomes, recordRange } from "../sim/trajectory.ts";
import type { RecordPlan } from "../sim/trajectory.ts";

// Creatures [start, end) of one generation; genomes holds only those creatures (transferred).
export interface EvalJob {
  type: "eval";
  job: number;
  config: SimConfig;
  start: number;
  end: number;
  layoutSeed: number;
  genomeLength: number;
  genomes: Float32Array;
}

export interface EvalDone {
  type: "done";
  job: number;
  start: number;
  fitness: Float64Array; // transferred, one per creature of the job
}

// Plan slots [start, start + indices.length) of one generation; genomes follow the slots, offsets start at 0.
export interface RecordJob {
  type: "record";
  job: number;
  config: SimConfig;
  start: number;
  layoutSeed: number;
  genomeLength: number;
  genomes: Float32Array;
  indices: Int32Array;
  offsets: Uint32Array;
}

export interface RecordDone {
  type: "recorded";
  job: number;
  start: number;
  count: number; // plan slots covered
  frames: Float32Array; // transferred, laid out by the job's offsets
}

export type PoolJob = EvalJob | RecordJob;
export type PoolDone = EvalDone | RecordDone;

// Body of an evaluation worker, shared by the browser and Node entries.
export function evalJob(msg: EvalJob): EvalDone {
  const fitness = new Float64Array(msg.end - msg.start);
  evaluateRange(msg.config, msg.genomes, msg.genomeLength, msg.layoutSeed, msg.start, msg.end, fitness, msg.start);
  return { type: "done", job: msg.job, start: msg.start, fitness };
}

export function recordJob(msg: RecordJob): RecordDone {
  const frames = new Float32Array(msg.offsets[msg.indices.length]! * FRAME_FLOATS);
  recordRange(msg.config, msg.genomes, msg.genomeLength, msg.layoutSeed, msg.indices, msg.offsets, frames);
  return { type: "recorded", job: msg.job, start: msg.start, count: msg.indices.length, frames };
}

// What a worker entry does with a message: the reply and the buffer to transfer with it.
export function runJob(msg: PoolJob): { done: PoolDone; transfer: ArrayBuffer[] } {
  if (msg.type === "eval") {
    const done = evalJob(msg);
    return { done, transfer: [done.fitness.buffer as ArrayBuffer] };
  }
  const done = recordJob(msg);
  return { done, transfer: [done.frames.buffer as ArrayBuffer] };
}

// What the pool needs from a worker, implemented for web workers and for node worker_threads.
export interface PoolWorker {
  post(msg: PoolJob, transfer: ArrayBuffer[]): void;
  onMessage(callback: (msg: PoolDone) => void): void;
  onError(callback: (error: unknown) => void): void; // any error or unexpected exit
  terminate(): void;
}

const CHUNKS_PER_WORKER = 8; // small chunks balance the load, since lifetimes differ a lot between creatures

// Default worker count: leave one core for the caller, at most 8.
export function defaultThreads(cores: number): number {
  return Math.max(1, Math.min(cores - 1, 8));
}

// One batch of items split into index chunks; make builds the job of a chunk, accept stores a reply.
interface Pending {
  count: number;
  next: number; // first item not yet handed out
  chunk: number;
  remaining: number; // items not yet returned
  job: number;
  make(start: number, end: number, job: number): { msg: PoolJob; transfer: ArrayBuffer[] };
  accept(done: PoolDone): number; // returns the number of items the reply covered
  finish(): void; // resolves the caller's promise once all items are in
  reject(error: unknown): void;
}

// Splits the creatures into index chunks, hands them to idle workers and gathers the results.
// After any worker error or close() the pool is broken for good: workers are terminated and every call rejects.
export class PoolEvaluator implements Evaluator {
  private readonly config: SimConfig;
  private readonly workers: PoolWorker[];
  private pending: Pending | null = null;
  private broken: { error: unknown } | null = null;
  private jobCounter = 0;

  constructor(config: SimConfig, workers: PoolWorker[]) {
    this.config = config;
    this.workers = workers;
    for (const worker of workers) {
      worker.onMessage((msg) => this.handleDone(worker, msg));
      worker.onError((error) => this.fail(error));
    }
  }

  evaluate(population: Population, layoutSeed: number): Promise<Float64Array> {
    const fitness = new Float64Array(population.size);
    const { genomeLength, data } = population;
    return this.submit(
      population.size,
      fitness,
      (start, end, job) => {
        const genomes = data.slice(start * genomeLength, end * genomeLength); // copy, so the caller keeps its buffer
        return { msg: { type: "eval", job, config: this.config, start, end, layoutSeed, genomeLength, genomes }, transfer: [genomes.buffer as ArrayBuffer] };
      },
      (done) => {
        if (done.type !== "done") return 0;
        fitness.set(done.fitness, done.start);
        return done.fitness.length;
      },
    );
  }

  record(population: Population, layoutSeed: number, plan: RecordPlan): Promise<Float32Array> {
    const count = plan.indices.length;
    const frames = new Float32Array(plan.offsets[count]! * FRAME_FLOATS);
    return this.submit(
      count,
      frames,
      (start, end, job) => {
        const indices = plan.indices.slice(start, end);
        const base = plan.offsets[start]!;
        const offsets = plan.offsets.slice(start, end + 1).map((o) => o - base);
        const genomes = gatherGenomes(population, indices);
        return {
          msg: { type: "record", job, config: this.config, start, layoutSeed, genomeLength: population.genomeLength, genomes, indices, offsets },
          transfer: [genomes.buffer as ArrayBuffer],
        };
      },
      (done) => {
        if (done.type !== "recorded") return 0;
        frames.set(done.frames, plan.offsets[done.start]! * FRAME_FLOATS);
        return done.count;
      },
    );
  }

  close(): void {
    this.fail(new Error("evaluator closed"));
  }

  private submit<T>(count: number, result: T, make: Pending["make"], accept: Pending["accept"]): Promise<T> {
    if (this.broken) return Promise.reject(this.broken.error);
    if (this.pending) return Promise.reject(new Error("evaluation already running"));
    if (count === 0) return Promise.resolve(result);
    return new Promise((resolve, reject) => {
      const chunk = Math.max(1, Math.ceil(count / (this.workers.length * CHUNKS_PER_WORKER)));
      this.pending = { count, next: 0, chunk, remaining: count, job: ++this.jobCounter, make, accept, finish: () => resolve(result), reject };
      for (const worker of this.workers) this.dispatch(worker);
    });
  }

  private dispatch(worker: PoolWorker): void {
    const p = this.pending;
    if (!p || p.next >= p.count) return;
    const start = p.next;
    const end = Math.min(p.count, start + p.chunk);
    p.next = end;
    const { msg, transfer } = p.make(start, end, p.job);
    worker.post(msg, transfer);
  }

  private handleDone(worker: PoolWorker, msg: PoolDone): void {
    const p = this.pending;
    if (!p || msg.job !== p.job) return;
    p.remaining -= p.accept(msg);
    if (p.remaining === 0) {
      this.pending = null;
      p.finish();
    } else {
      this.dispatch(worker);
    }
  }

  private fail(error: unknown): void {
    if (this.broken) return;
    this.broken = { error };
    for (const worker of this.workers) worker.terminate();
    const p = this.pending;
    this.pending = null;
    p?.reject(error);
  }
}
