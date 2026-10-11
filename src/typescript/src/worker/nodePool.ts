import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { SimConfig } from "../sim/config.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import type { EvalDone, EvalJob } from "./evalPool.ts";
import { PoolEvaluator, defaultThreads } from "./evalPool.ts";
import { ThinkPool, canShare } from "./ecoPool.ts";
import type { HelperIn, HelperOut, HelperPort } from "./ecoPool.ts";
import type { Port } from "./port.ts";
import { RlPool, inlineRlPort } from "./rlPool.ts";
import type { RlDone, RlJob, RlSetup } from "./rlPool.ts";

// n new worker_threads as ports; with unref a blocked worker never keeps the process alive.
function nodePorts<In, Out>(n: number, spawn: () => Worker, what: string, unref = false): Port<In, Out>[] {
  const ports: Port<In, Out>[] = [];
  for (let i = 0; i < n; i++) {
    const worker = spawn();
    if (unref) worker.unref();
    ports.push({
      post: (msg, transfer) => worker.postMessage(msg, (transfer ?? []) as ArrayBuffer[]),
      onMessage: (callback) => { worker.on("message", callback); },
      onError: (callback) => {
        worker.on("error", callback);
        worker.on("exit", (code) => callback(new Error(`${what} exited with code ${code}`)));
      },
      terminate: () => { void worker.terminate(); },
    });
  }
  return ports;
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
  return nodePorts<HelperIn, HelperOut>(helpers, () => new Worker(new URL("./ecoHelperNode.ts", import.meta.url)), "helper thread", true);
}

// Pool of worker_threads, or the serial evaluator for one thread. Call close() so the process can exit.
export function createNodeEvaluator(config: SimConfig, threads: number): Evaluator {
  if (threads <= 1) return new SerialEvaluator(config);
  const workers = nodePorts<EvalJob, EvalDone>(threads, () => new Worker(new URL("./evalWorkerNode.ts", import.meta.url)), "evaluation worker");
  return new PoolEvaluator(config, workers);
}

// Pool of RL helper threads, or the caller's own thread for one. Call close() so the process can exit.
export function createNodeRlPool(setup: RlSetup, threads: number): RlPool {
  const ports = threads <= 1 ? [inlineRlPort()] : nodePorts<RlJob, RlDone>(threads, () => new Worker(new URL("./rlHelperNode.ts", import.meta.url)), "RL helper");
  return new RlPool(ports, setup);
}
