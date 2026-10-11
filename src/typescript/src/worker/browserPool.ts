import type { SimConfig } from "../sim/config.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluation, Evaluator } from "../sim/evaluator.ts";
import type { Population } from "../sim/population.ts";
import type { RecordOptions } from "../sim/trajectory.ts";
import type { EvalDone, EvalJob, EvalPort } from "./evalPool.ts";
import { PoolEvaluator, defaultThreads } from "./evalPool.ts";
import { gentleController, idleMs } from "./pacer.ts";
import type { DutyController } from "./pacer.ts";
import { ThinkPool } from "./ecoPool.ts";
import type { HelperIn, HelperOut } from "./ecoPool.ts";
import type { Port } from "./port.ts";
import { RlPool, inlineRlPort } from "./rlPool.ts";
import type { RlDone, RlJob, RlSetup } from "./rlPool.ts";

// n new web workers as ports; on a failed spawn the ones already started are terminated and the error rethrown.
function browserPorts<In, Out>(n: number, spawn: () => Worker, what: string): Port<In, Out>[] {
  const ports: Port<In, Out>[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const worker = spawn();
      ports.push({
        post: (msg, transfer) => worker.postMessage(msg, transfer ?? []),
        onMessage: (callback) => { worker.onmessage = (e) => callback(e.data); },
        onError: (callback) => {
          worker.onerror = (e) => {
            e.preventDefault?.(); // the pool handles it; unhandled, it would also surface as an error without text in the worker that owns the pool
            callback(e.error ?? new Error(e.message || `${what} failed to load`));
          };
          worker.onmessageerror = () => callback(new Error(`${what} could not read a message`));
        },
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
  private gentle: DutyController | null = null;
  private started = false;
  private closed = false;

  // pool null: evaluate on this thread.
  constructor(config: SimConfig, pool: PoolEvaluator | null) {
    this.config = config;
    this.pool = pool;
    if (!pool) this.serial = new SerialEvaluator(config);
  }

  // On this thread the generation is the slice of work: idle after it, as the pooled workers do between jobs.
  private async evaluateSerial(population: Population, layoutSeed: number, record?: RecordOptions): Promise<Evaluation> {
    const t0 = performance.now();
    const evaluation = await this.serial!.evaluate(population, layoutSeed, record);
    this.gentle?.maybeProbe(performance.now());
    const work = performance.now() - t0;
    const idle = this.gentle ? idleMs(work, this.gentle.duty()) : 0;
    if (idle > 0) await new Promise((resolve) => setTimeout(resolve, idle));
    return evaluation;
  }

  async evaluate(population: Population, layoutSeed: number, record?: RecordOptions): Promise<Evaluation> {
    const pool = this.pool;
    if (!pool) return this.evaluateSerial(population, layoutSeed, record);
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
      return this.evaluateSerial(population, layoutSeed, record);
    }
  }

  setGentle(on: boolean): void {
    this.gentle = on ? (this.gentle ?? gentleController()) : null;
    if (this.pool) this.pool.gentle = on;
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
export function createBrowserEvaluator(config: SimConfig, gentle = false, threads = defaultThreads(navigator.hardwareConcurrency || 2, gentle)): Evaluator & { setGentle(on: boolean): void } {
  const evaluator = makeBrowserEvaluator(config, threads);
  evaluator.setGentle(gentle);
  return evaluator;
}

function makeBrowserEvaluator(config: SimConfig, threads: number): BrowserEvaluator {
  if (threads <= 1 || typeof Worker === "undefined") return new BrowserEvaluator(config, null);
  let workers: EvalPort[];
  try {
    workers = browserPorts<EvalJob, EvalDone>(threads, () => new Worker(new URL("./evalWorker.ts", import.meta.url), { type: "module" }), "evaluation worker");
  } catch (error) {
    console.warn("Nested workers unavailable, evaluating serially:", error);
    return new BrowserEvaluator(config, null);
  }
  return new BrowserEvaluator(config, new PoolEvaluator(config, workers));
}

// Pool of nested RL helper workers, or the worker's own thread when one is wanted or nested workers cannot be spawned or loaded.
export function createBrowserRlPool(setup: RlSetup, threads = defaultThreads(navigator.hardwareConcurrency || 2)): RlPool {
  let ports = [inlineRlPort()];
  if (threads > 1 && typeof Worker !== "undefined") {
    try {
      ports = browserPorts<RlJob, RlDone>(threads, () => new Worker(new URL("./rlHelperWorker.ts", import.meta.url), { type: "module" }), "RL helper");
    } catch (error) {
      console.warn("Nested workers unavailable, running serially:", error);
    }
  }
  return new RlPool(ports, setup);
}
