import type { SimConfig } from "../sim/config.ts";
import type { Port } from "./port.ts";
import { evaluateRange } from "../sim/evaluator.ts";
import type { Evaluation, Evaluator } from "../sim/evaluator.ts";
import type { Population } from "../sim/population.ts";
import { gentleCount } from "./pacer.ts";
import { TopFrames } from "../sim/trajectory.ts";
import type { RecordOptions, Trajectories } from "../sim/trajectory.ts";

export type EvalPort = Port<EvalJob, EvalDone>;

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
  record?: RecordOptions; // also return every creature's frames
  gentle?: boolean; // the worker idles when the machine is busy, see pacer.ts
}

export interface EvalDone {
  type: "done";
  job: number;
  start: number;
  fitness: Float64Array; // transferred, one per creature of the job
  frames?: Trajectories; // transferred, when the job asked for it
}

// Body of an evaluation worker, shared by the browser and Node entries.
export function evalJob(msg: EvalJob): EvalDone {
  const fitness = new Float64Array(msg.end - msg.start);
  const frames = evaluateRange(msg.config, msg.genomes, msg.genomeLength, msg.layoutSeed, msg.start, msg.end, fitness, msg.start, msg.record);
  return { type: "done", job: msg.job, start: msg.start, fitness, frames };
}

// The buffers of a reply to hand over instead of copy.
export function transferList(done: EvalDone): ArrayBuffer[] {
  const buffers = [done.fitness.buffer as ArrayBuffer];
  if (done.frames) buffers.push(done.frames.offsets.buffer as ArrayBuffer, done.frames.data.buffer as ArrayBuffer);
  return buffers;
}

const CHUNKS_PER_WORKER = 8; // small chunks balance the load, since lifetimes differ a lot between creatures

// Default worker count: leave one core for the caller, at most 8.
// Gentle on CPU: one fewer, leaving at least 2 cores free.
export function defaultThreads(cores: number, gentle = false): number {
  const normal = Math.max(1, Math.min(cores - 1, 8));
  return gentle ? gentleCount(normal, cores) : normal;
}

interface Pending {
  fitness: Float64Array;
  next: number; // first creature not yet handed out
  chunk: number;
  remaining: number; // creatures not yet returned
  top?: TopFrames; // running top set, when recording
  record?: RecordOptions;
  population: Population;
  layoutSeed: number;
  job: number;
  resolve: (evaluation: Evaluation) => void;
  reject: (error: unknown) => void;
}

// Splits the creatures into index chunks, hands them to idle workers and gathers the fitness.
// After any worker error or close() the pool is broken for good: workers are terminated and every evaluate rejects.
export class PoolEvaluator implements Evaluator {
  private readonly config: SimConfig;
  private readonly workers: EvalPort[];
  private pending: Pending | null = null;
  private broken: { error: unknown } | null = null;
  private jobCounter = 0;
  gentle = false; // stamped on every job, see EvalJob; may change between jobs

  constructor(config: SimConfig, workers: EvalPort[]) {
    this.config = config;
    this.workers = workers;
    for (const worker of workers) {
      worker.onMessage((msg) => this.handleDone(worker, msg));
      worker.onError((error) => this.fail(error));
    }
  }

  evaluate(population: Population, layoutSeed: number, record?: RecordOptions): Promise<Evaluation> {
    if (this.broken) return Promise.reject(this.broken.error);
    if (this.pending) return Promise.reject(new Error("evaluation already running"));
    const n = population.size;
    if (n === 0) return Promise.resolve({ fitness: new Float64Array(0), frames: record && new TopFrames(record).result() });
    return new Promise((resolve, reject) => {
      const chunk = Math.max(1, Math.ceil(n / (this.workers.length * CHUNKS_PER_WORKER)));
      const top = record && new TopFrames(record);
      this.pending = { fitness: new Float64Array(n), next: 0, chunk, remaining: n, top, record, population, layoutSeed, job: ++this.jobCounter, resolve, reject };
      for (const worker of this.workers) this.dispatch(worker);
    });
  }

  close(): void {
    this.fail(new Error("evaluator closed"));
  }

  private dispatch(worker: EvalPort): void {
    const p = this.pending;
    if (!p || p.next >= p.population.size) return;
    const start = p.next;
    const end = Math.min(p.population.size, start + p.chunk);
    p.next = end;
    const { genomeLength, data } = p.population;
    const genomes = data.slice(start * genomeLength, end * genomeLength); // copy, so the caller keeps its buffer
    worker.post({ type: "eval", job: p.job, config: this.config, start, end, layoutSeed: p.layoutSeed, genomeLength, genomes, record: p.record, gentle: this.gentle }, [genomes.buffer as ArrayBuffer]);
  }

  private handleDone(worker: EvalPort, msg: EvalDone): void {
    const p = this.pending;
    if (!p || msg.job !== p.job) return;
    p.fitness.set(msg.fitness, msg.start);
    p.remaining -= msg.fitness.length;
    p.top?.add(msg.start, msg.fitness, msg.frames!); // the chunk is dropped right after
    if (p.remaining === 0) {
      this.pending = null;
      p.resolve({ fitness: p.fitness, frames: p.top?.result() });
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
