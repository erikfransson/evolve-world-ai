import { Worker } from "node:worker_threads";
import type { SimConfig } from "../sim/config.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import type { PoolWorker } from "./evalPool.ts";
import { PoolEvaluator } from "./evalPool.ts";

function wrap(worker: Worker): PoolWorker {
  return {
    post: (msg, transfer) => worker.postMessage(msg, transfer),
    onMessage: (callback) => { worker.on("message", callback); },
    onError: (callback) => { worker.on("error", callback); },
    terminate: () => { void worker.terminate(); },
  };
}

// Pool of worker_threads, or the serial evaluator for one thread. Call close() so the process can exit.
export function createNodeEvaluator(config: SimConfig, threads: number): Evaluator {
  if (threads <= 1) return new SerialEvaluator(config);
  const workers: PoolWorker[] = [];
  for (let i = 0; i < threads; i++) workers.push(wrap(new Worker(new URL("./evalWorkerNode.ts", import.meta.url))));
  return new PoolEvaluator(config, workers);
}
