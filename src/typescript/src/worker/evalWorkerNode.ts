// Node entry of an evaluation worker (worker_threads).
import { parentPort } from "node:worker_threads";
import { runJob } from "./evalPool.ts";
import type { PoolJob } from "./evalPool.ts";

parentPort!.on("message", (msg: PoolJob) => {
  const { done, transfer } = runJob(msg);
  parentPort!.postMessage(done, transfer);
});
