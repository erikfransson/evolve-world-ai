// Node entry of an RL helper (worker_threads).
import { parentPort } from "node:worker_threads";
import { rlHelper, rlTransferList } from "./rlPool.ts";
import type { RlJob } from "./rlPool.ts";

const help = rlHelper();
parentPort!.on("message", (job: RlJob) => {
  const done = help(job);
  if (done) parentPort!.postMessage(done, rlTransferList(done));
});
