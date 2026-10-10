import type { SimConfig } from "../sim/config.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import type { Population } from "../sim/population.ts";
import type { PoolWorker } from "./evalPool.ts";
import { PoolEvaluator, defaultThreads } from "./evalPool.ts";

function wrap(worker: Worker): PoolWorker {
  return {
    post: (msg, transfer) => worker.postMessage(msg, transfer),
    onMessage: (callback) => { worker.onmessage = (e) => callback(e.data); },
    onError: (callback) => { worker.onerror = (e) => callback(e.error ?? new Error(e.message)); },
    terminate: () => worker.terminate(),
  };
}

// A pool of nested workers that switches itself to serial if it fails before completing its first generation,
// e.g. because the browser cannot start nested workers. Later failures are real errors and propagate.
class BrowserEvaluator implements Evaluator {
  private readonly config: SimConfig;
  private pool: PoolEvaluator | null;
  private serial: SerialEvaluator | null = null;
  private started = false;
  private closed = false;

  constructor(config: SimConfig, pool: PoolEvaluator) {
    this.config = config;
    this.pool = pool;
  }

  async evaluate(population: Population, layoutSeed: number): Promise<Float64Array> {
    const pool = this.pool;
    if (!pool) return this.serial!.evaluate(population, layoutSeed);
    try {
      const fitness = await pool.evaluate(population, layoutSeed);
      this.started = true;
      return fitness;
    } catch (error) {
      if (this.started || this.closed) throw error;
      console.warn("Nested workers failed to start, evaluating serially:", error);
      pool.close();
      this.pool = null;
      this.serial = new SerialEvaluator(this.config);
      return this.serial.evaluate(population, layoutSeed);
    }
  }

  close(): void {
    this.closed = true;
    this.pool?.close();
  }
}

// Pool of nested dedicated workers, or the serial evaluator when one thread is wanted or workers cannot be spawned.
export function createBrowserEvaluator(config: SimConfig, threads = defaultThreads(navigator.hardwareConcurrency || 2)): Evaluator {
  if (threads <= 1 || typeof Worker === "undefined") return new SerialEvaluator(config);
  const workers: PoolWorker[] = [];
  try {
    for (let i = 0; i < threads; i++) {
      workers.push(wrap(new Worker(new URL("./evalWorker.ts", import.meta.url), { type: "module" })));
    }
  } catch (error) {
    console.warn("Nested workers unavailable, evaluating serially:", error);
    for (const worker of workers) worker.terminate();
    return new SerialEvaluator(config);
  }
  return new BrowserEvaluator(config, new PoolEvaluator(config, workers));
}
