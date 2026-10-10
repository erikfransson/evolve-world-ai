// Browser entry of an evaluation worker, spawned by the sim worker's pool.
import { runJob } from "./evalPool.ts";
import type { PoolJob } from "./evalPool.ts";

self.onmessage = (e: MessageEvent<PoolJob>) => {
  const { done, transfer } = runJob(e.data);
  self.postMessage(done, { transfer });
};
