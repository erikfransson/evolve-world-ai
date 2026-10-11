import type { SimConfig } from "../sim/config.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluation, Evaluator } from "../sim/evaluator.ts";
import type { Population } from "../sim/population.ts";
import type { RecordOptions } from "../sim/trajectory.ts";
import type { EvalDone, EvalJob, EvalPort } from "./evalPool.ts";
import { PoolEvaluator, defaultThreads } from "./evalPool.ts";
import { ThinkPool } from "./ecoPool.ts";
import type { HelperIn, HelperOut } from "./ecoPool.ts";
import type { Port } from "./port.ts";

// n new web workers as ports; on a failed spawn the ones already started are terminated and the error rethrown.
function browserPorts<In, Out>(n: number, spawn: () => Worker, what: string): Port<In, Out>[] {
  const ports: Port<In, Out>[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const worker = spawn();
      ports.push({
        post: (msg, transfer) => worker.postMessage(msg, transfer ?? []),
        onMessage: (callback) => { worker.onmessage = (e) => callback(e.data); },
        onError: (callback) => { worker.onerror = (e) => callback(e.error ?? new Error(e.message || `${what} failed to load`)); },
        terminate: () => worker.terminate(),
      });
    }
  } catch (error) {
    for (const port of ports) port.terminate();
    throw error;
  }
  return ports;
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

  async evaluate(population: Population, layoutSeed: number, record?: RecordOptions): Promise<Evaluation> {
    const pool = this.pool;
    if (!pool) return this.serial!.evaluate(population, layoutSeed, record);
    try {
      const evaluation = await pool.evaluate(population, layoutSeed, record);
      this.started = true;
      return evaluation;
    } catch (error) {
      if (this.started || this.closed) throw error;
      console.warn("Nested workers failed to start, evaluating serially:", error);
      pool.close();
      this.pool = null;
      this.serial = new SerialEvaluator(this.config);
      return this.serial.evaluate(population, layoutSeed, record);
    }
  }

  close(): void {
    this.closed = true;
    this.pool?.close();
  }
}

// Ecosystem helper threads as nested workers.
// Throws when workers cannot be created; a helper that fails to load shows up as a rejected ThinkPool.start.
export function createBrowserThinkPool(helpers: number): ThinkPool {
  const ports = browserPorts<HelperIn, HelperOut>(helpers, () => new Worker(new URL("./ecoHelperWorker.ts", import.meta.url), { type: "module" }), "helper thread");
  return new ThinkPool(ports);
}

// Pool of nested dedicated workers, or the serial evaluator when one thread is wanted or workers cannot be spawned.
export function createBrowserEvaluator(config: SimConfig, threads = defaultThreads(navigator.hardwareConcurrency || 2)): Evaluator {
  if (threads <= 1 || typeof Worker === "undefined") return new SerialEvaluator(config);
  let workers: EvalPort[];
  try {
    workers = browserPorts<EvalJob, EvalDone>(threads, () => new Worker(new URL("./evalWorker.ts", import.meta.url), { type: "module" }), "evaluation worker");
  } catch (error) {
    console.warn("Nested workers unavailable, evaluating serially:", error);
    return new SerialEvaluator(config);
  }
  return new BrowserEvaluator(config, new PoolEvaluator(config, workers));
}
