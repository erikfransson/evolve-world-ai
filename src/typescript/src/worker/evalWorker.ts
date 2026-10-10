// Browser entry of an evaluation worker, spawned by the sim worker's pool.
import { evalJob, transferList } from "./evalPool.ts";
import type { EvalJob } from "./evalPool.ts";

self.onmessage = (e: MessageEvent<EvalJob>) => {
  const done = evalJob(e.data);
  self.postMessage(done, { transfer: transferList(done) });
};
