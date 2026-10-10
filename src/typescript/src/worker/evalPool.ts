import type { SimConfig } from "../sim/config.ts";
import { evaluateRange } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import type { Population } from "../sim/population.ts";
import { FrameRecorder, assembleFrames } from "../sim/trajectory.ts";
import type { ChunkFrames, RecordPlan } from "../sim/trajectory.ts";

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
  record: boolean; // also return every creature's frames
}

export interface EvalDone {
  type: "done";
  job: number;
  start: number;
  fitness: Float64Array; // transferred, one per creature of the job
  recorded?: ChunkFrames; // transferred, when the job asked for it
}

// Body of an evaluation worker, shared by the browser and Node entries.
export function evalJob(msg: EvalJob): EvalDone {
  const fitness = new Float64Array(msg.end - msg.start);
  const recorder = msg.record ? new FrameRecorder(msg.end - msg.start) : undefined;
  evaluateRange(msg.config, msg.genomes, msg.genomeLength, msg.layoutSeed, msg.start, msg.end, fitness, msg.start, recorder);
  return { type: "done", job: msg.job, start: msg.start, fitness, recorded: recorder?.result() };
}

// The buffers of a reply to hand over instead of copy.
export function transferList(done: EvalDone): ArrayBuffer[] {
  const buffers = [done.fitness.buffer as ArrayBuffer];
  if (done.recorded) buffers.push(done.recorded.ends.buffer as ArrayBuffer, done.recorded.frames.buffer as ArrayBuffer);
  return buffers;
}

// What the pool needs from a worker, implemented for web workers and for node worker_threads.
export interface PoolWorker {
  post(msg: EvalJob, transfer: ArrayBuffer[]): void;
  onMessage(callback: (msg: EvalDone) => void): void;
  onError(callback: (error: unknown) => void): void; // any error or unexpected exit
  terminate(): void;
}

const CHUNKS_PER_WORKER = 8; // small chunks balance the load, since lifetimes differ a lot between creatures

// Default worker count: leave one core for the caller, at most 8.
export function defaultThreads(cores: number): number {
  return Math.max(1, Math.min(cores - 1, 8));
}

interface Pending {
  fitness: Float64Array;
  next: number; // first creature not yet handed out
  chunk: number;
  remaining: number; // creatures not yet returned
  chunks: ChunkFrames[]; // recorded frames by chunk number, when recording
  population: Population;
  layoutSeed: number;
  job: number;
  resolve: (fitness: Float64Array) => void;
  reject: (error: unknown) => void;
}

// Splits the creatures into index chunks, hands them to idle workers and gathers the fitness.
// After any worker error or close() the pool is broken for good: workers are terminated and every evaluate rejects.
export class PoolEvaluator implements Evaluator {
  private readonly config: SimConfig;
  private readonly workers: PoolWorker[];
  private pending: Pending | null = null;
  private broken: { error: unknown } | null = null;
  private jobCounter = 0;
  private readonly recordFrames: boolean;
  private recorded: { chunkSize: number; chunks: ChunkFrames[] } | null = null; // the last finished generation

  constructor(config: SimConfig, workers: PoolWorker[], recordFrames = false) {
    this.config = config;
    this.workers = workers;
    this.recordFrames = recordFrames;
    for (const worker of workers) {
      worker.onMessage((msg) => this.handleDone(worker, msg));
      worker.onError((error) => this.fail(error));
    }
  }

  evaluate(population: Population, layoutSeed: number): Promise<Float64Array> {
    if (this.broken) return Promise.reject(this.broken.error);
    if (this.pending) return Promise.reject(new Error("evaluation already running"));
    const n = population.size;
    if (n === 0) return Promise.resolve(new Float64Array(0));
    this.recorded = null;
    return new Promise((resolve, reject) => {
      const chunk = Math.max(1, Math.ceil(n / (this.workers.length * CHUNKS_PER_WORKER)));
      this.pending = { fitness: new Float64Array(n), next: 0, chunk, remaining: n, chunks: [], population, layoutSeed, job: ++this.jobCounter, resolve, reject };
      for (const worker of this.workers) this.dispatch(worker);
    });
  }

  frames(plan: RecordPlan): Float32Array {
    if (!this.recorded) throw new Error("no recorded generation");
    return assembleFrames(plan, this.recorded.chunkSize, this.recorded.chunks);
  }

  close(): void {
    this.fail(new Error("evaluator closed"));
  }

  private dispatch(worker: PoolWorker): void {
    const p = this.pending;
    if (!p || p.next >= p.population.size) return;
    const start = p.next;
    const end = Math.min(p.population.size, start + p.chunk);
    p.next = end;
    const { genomeLength, data } = p.population;
    const genomes = data.slice(start * genomeLength, end * genomeLength); // copy, so the caller keeps its buffer
    worker.post({ type: "eval", job: p.job, config: this.config, start, end, layoutSeed: p.layoutSeed, genomeLength, genomes, record: this.recordFrames }, [genomes.buffer as ArrayBuffer]);
  }

  private handleDone(worker: PoolWorker, msg: EvalDone): void {
    const p = this.pending;
    if (!p || msg.job !== p.job) return;
    p.fitness.set(msg.fitness, msg.start);
    p.remaining -= msg.fitness.length;
    if (msg.recorded) p.chunks[msg.start / p.chunk] = msg.recorded;
    if (p.remaining === 0) {
      this.pending = null;
      if (this.recordFrames) this.recorded = { chunkSize: p.chunk, chunks: p.chunks };
      p.resolve(p.fitness);
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
