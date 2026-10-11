import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { SimConfig } from "../sim/config.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import type { PoolWorker } from "./evalPool.ts";
import { PoolEvaluator, defaultThreads } from "./evalPool.ts";
import { ThinkPool, canShare } from "./ecoPool.ts";
import type { HelperPort } from "./ecoPool.ts";

function wrap(worker: Worker): PoolWorker {
  return {
    post: (msg, transfer) => worker.postMessage(msg, transfer),
    onMessage: (callback) => { worker.on("message", callback); },
    onError: (callback) => {
      worker.on("error", callback);
      worker.on("exit", (code) => callback(new Error(`evaluation worker exited with code ${code}`)));
    },
    terminate: () => { void worker.terminate(); },
  };
}

// The --threads value: undefined gives the default, otherwise a positive integer (throws on anything else).
export function parseThreads(value: string | undefined): number {
  if (value === undefined) return defaultThreads(availableParallelism());
  const threads = Number(value);
  if (!Number.isInteger(threads) || threads <= 0) throw new Error("--threads must be a positive integer");
  return threads;
}

// Ecosystem helper threads; shared uses shared memory. Call close() so the process can exit.
export function createNodeThinkPool(helpers: number, shared: boolean): ThinkPool {
  return new ThinkPool(nodeHelperPorts(helpers), shared && canShare(globalThis, true));
}

// Ports to n new helper worker_threads.
export function nodeHelperPorts(helpers: number): HelperPort[] {
  const ports: HelperPort[] = [];
  for (let i = 0; i < helpers; i++) {
    const worker = new Worker(new URL("./ecoHelperNode.ts", import.meta.url));
    worker.unref(); // a blocked helper never keeps the process alive
    ports.push({
      post: (msg, transfer) => worker.postMessage(msg, (transfer ?? []) as ArrayBuffer[]),
      onMessage: (callback) => { worker.on("message", callback); },
      onError: (callback) => {
        worker.on("error", callback);
        worker.on("exit", (code) => callback(new Error(`helper thread exited with code ${code}`)));
      },
      terminate: () => { void worker.terminate(); },
    });
  }
  return ports;
}

// Pool of worker_threads, or the serial evaluator for one thread. Call close() so the process can exit.
export function createNodeEvaluator(config: SimConfig, threads: number): Evaluator {
  if (threads <= 1) return new SerialEvaluator(config);
  const workers: PoolWorker[] = [];
  for (let i = 0; i < threads; i++) workers.push(wrap(new Worker(new URL("./evalWorkerNode.ts", import.meta.url))));
  return new PoolEvaluator(config, workers);
}
