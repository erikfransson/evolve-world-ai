// Browser entry of an evaluation worker, spawned by the sim worker's pool.
import { evalJob, heartbeat, transferList } from "./evalPool.ts";
import type { EvalJob } from "./evalPool.ts";
import { Pacer, gentleController } from "./pacer.ts";
import type { DutyController } from "./pacer.ts";

const pacer = new Pacer();
let controller: DutyController | null = null; // created with the first gentle job
let queue: Promise<void> = Promise.resolve(); // jobs run in order, each after the idle time of the one before

self.onmessage = (e: MessageEvent<EvalJob>) => {
  const job = e.data;
  queue = queue.then(async () => {
    try {
    const wait = pacer.wait();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    pacer.began();
    const t0 = performance.now();
    const done = evalJob(job, heartbeat(job.job, (m) => self.postMessage(m)));
    self.postMessage(done, { transfer: transferList(done) });
    if (!job.gentle) return;
    controller ??= gentleController();
    pacer.finished(t0, controller.duty());
    } catch (error) {
      // Rethrown outside the chain it surfaces as the worker's error event, which breaks the pool visibly; the chain itself stays alive.
      setTimeout(() => { throw error; });
    }
  });
};
