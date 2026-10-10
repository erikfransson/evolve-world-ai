// Browser entry of an evaluation worker, spawned by the sim worker's pool.
import { createEvalHandler } from "./evalWorkerCore.ts";
import type { EvalDone, EvalIn } from "./evalProtocol.ts";

const handle = createEvalHandler();

self.onmessage = (e: MessageEvent<EvalIn>) => {
  const done: EvalDone | null = handle(e.data);
  if (done) self.postMessage(done, { transfer: [done.fitness.buffer] });
};
