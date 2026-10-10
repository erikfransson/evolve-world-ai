// Node entry of an evaluation worker (worker_threads).
import { parentPort } from "node:worker_threads";
import { evalJob, transferList } from "./evalPool.ts";
import type { EvalJob } from "./evalPool.ts";

parentPort!.on("message", (msg: EvalJob) => {
  const done = evalJob(msg);
  parentPort!.postMessage(done, transferList(done));
});
