// Browser entry of an RL helper, spawned by the Arena worker's pool.
import { rlHelper, rlTransferList } from "./rlPool.ts";
import type { RlJob } from "./rlPool.ts";

const help = rlHelper();
self.onmessage = (e: MessageEvent<RlJob>) => {
  const done = help(e.data);
  if (done) self.postMessage(done, { transfer: rlTransferList(done) });
};
