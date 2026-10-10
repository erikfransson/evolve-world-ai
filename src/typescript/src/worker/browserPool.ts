import type { SimConfig } from "../sim/config.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
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

// Pool of nested dedicated workers, or the serial evaluator when one thread is wanted or workers cannot be spawned.
export function createBrowserEvaluator(config: SimConfig, threads = defaultThreads(navigator.hardwareConcurrency || 2)): Evaluator {
  if (threads <= 1 || typeof Worker === "undefined") return new SerialEvaluator(config);
  try {
    const workers: PoolWorker[] = [];
    for (let i = 0; i < threads; i++) {
      workers.push(wrap(new Worker(new URL("./evalWorker.ts", import.meta.url), { type: "module" })));
    }
    return new PoolEvaluator(config, workers);
  } catch {
    return new SerialEvaluator(config);
  }
}
