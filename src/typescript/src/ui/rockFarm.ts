import type { RockFarm, RockJob, RockPixels } from "./abyssRock.ts";
import type { RockIn, RockOut } from "../worker/rockWorker.ts";

type RockWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
const newWorker = (): RockWorker => new Worker(new URL("../worker/rockWorker.ts", import.meta.url), { type: "module" });

// Rock images built on a few workers, started on the first request, jobs dealt to the least busy one. A worker that fails rejects its
// jobs, and abyssRock then builds on the page's thread.
export function rockFarm(size = 2, makeWorker: () => RockWorker = newWorker): RockFarm {
  const workers: { w: RockWorker; busy: number }[] = [];
  const jobs = new Map<number, { resolve: (p: RockPixels | null) => void; reject: (e: unknown) => void; at: number }>();
  let next = 0;
  const fail = (at: number): void => {
    for (const [n, j] of jobs) {
      if (j.at !== at) continue;
      jobs.delete(n);
      j.reject(new Error("rock worker failed"));
    }
  };
  return {
    build(job: RockJob, cell: number, halo: boolean): Promise<RockPixels | null> {
      return new Promise((resolve, reject) => {
        try {
          if (workers.length < size) {
            const at = workers.length;
            const w = makeWorker();
            const slot = { w, busy: 0 };
            w.onmessage = (e: MessageEvent<RockOut>) => {
              const j = jobs.get(e.data.n);
              if (!j) return;
              jobs.delete(e.data.n);
              slot.busy--;
              j.resolve(e.data.pixels);
            };
            w.onerror = () => fail(at);
            workers.push(slot);
          }
          let at = 0;
          for (let i = 1; i < workers.length; i++) if (workers[i]!.busy < workers[at]!.busy) at = i;
          const n = next++;
          jobs.set(n, { resolve, reject, at });
          workers[at]!.busy++;
          workers[at]!.w.postMessage({ n, job, cell, halo } satisfies RockIn);
        } catch (err) {
          reject(err);
        }
      });
    },
  };
}
