import type { SimConfig } from "../sim/config.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import type { Population } from "../sim/population.ts";
import type { EvalDone, EvalIn } from "./evalProtocol.ts";

// What the pool needs from a worker, implemented for web workers and for node worker_threads.
export interface PoolWorker {
  post(msg: EvalIn, transfer: ArrayBuffer[]): void;
  onMessage(callback: (msg: EvalDone) => void): void;
  onError(callback: (error: unknown) => void): void;
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
  population: Population;
  layoutSeed: number;
  job: number;
  resolve: (fitness: Float64Array) => void;
  reject: (error: unknown) => void;
}

// Splits the creatures into index chunks, hands them to idle workers and gathers the fitness.
export class PoolEvaluator implements Evaluator {
  private readonly workers: PoolWorker[];
  private pending: Pending | null = null;
  private jobCounter = 0;

  constructor(config: SimConfig, workers: PoolWorker[]) {
    this.workers = workers;
    for (const worker of workers) {
      worker.onMessage((msg) => this.handleDone(worker, msg));
      worker.onError((error) => this.fail(error));
      worker.post({ type: "init", config }, []);
    }
  }

  evaluate(population: Population, layoutSeed: number): Promise<Float64Array> {
    if (this.pending) return Promise.reject(new Error("evaluation already running"));
    const n = population.size;
    if (n === 0) return Promise.resolve(new Float64Array(0));
    return new Promise((resolve, reject) => {
      const chunk = Math.max(1, Math.ceil(n / (this.workers.length * CHUNKS_PER_WORKER)));
      this.pending = { fitness: new Float64Array(n), next: 0, chunk, remaining: n, population, layoutSeed, job: ++this.jobCounter, resolve, reject };
      for (const worker of this.workers) this.dispatch(worker);
    });
  }

  close(): void {
    for (const worker of this.workers) worker.terminate();
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
    worker.post({ type: "eval", job: p.job, start, end, layoutSeed: p.layoutSeed, genomeLength, genomes }, [genomes.buffer as ArrayBuffer]);
  }

  private handleDone(worker: PoolWorker, msg: EvalDone): void {
    const p = this.pending;
    if (!p || msg.job !== p.job) return;
    p.fitness.set(msg.fitness, msg.start);
    p.remaining -= msg.fitness.length;
    if (p.remaining === 0) {
      this.pending = null;
      p.resolve(p.fitness);
    } else {
      this.dispatch(worker);
    }
  }

  private fail(error: unknown): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(error);
  }
}
