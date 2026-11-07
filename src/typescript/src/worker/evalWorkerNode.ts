// Node entry of an evaluation worker (worker_threads).
import { parentPort } from "node:worker_threads";
import { evalJob, heartbeat, transferList } from "./evalPool.ts";
import type { EvalJob } from "./evalPool.ts";

parentPort!.on("message", (msg: EvalJob) => {
  const done = evalJob(msg, heartbeat(msg.job, (m) => parentPort!.postMessage(m)));
  parentPort!.postMessage(done, transferList(done));
});
