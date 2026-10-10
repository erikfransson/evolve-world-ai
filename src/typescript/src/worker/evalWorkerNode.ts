// Node entry of an evaluation worker (worker_threads).
import { parentPort } from "node:worker_threads";
import { createEvalHandler } from "./evalWorkerCore.ts";
import type { EvalIn } from "./evalProtocol.ts";

const handle = createEvalHandler();

parentPort!.on("message", (msg: EvalIn) => {
  const done = handle(msg);
  if (done) parentPort!.postMessage(done, [done.fitness.buffer as ArrayBuffer]);
});
