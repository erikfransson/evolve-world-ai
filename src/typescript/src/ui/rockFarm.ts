import type { RockFarm, RockJob, RockPixels } from "./abyssRock.ts";
import type { RockIn, RockOut } from "../worker/rockWorker.ts";

type RockWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
const newWorker = (): RockWorker => new Worker(new URL("../worker/rockWorker.ts", import.meta.url), { type: "module" });

// Rock images built on a few workers, started on the first request, jobs dealt to the least busy one. A worker that fails rejects its
// jobs, and abyssRock then builds on the page's thread.
export function rockFarm(size = 2, makeWorker: () => RockWorker = newWorker): RockFarm & { close(): void } {
  type Slot = { w: RockWorker; busy: number; dead: boolean };
  const workers: Slot[] = [];
  const jobs = new Map<number, { resolve: (p: RockPixels | null) => void; reject: (e: unknown) => void; slot: Slot }>();
  let next = 0;
  // A failed slot is retired for good (never picked again) and its jobs rejected.
  const fail = (slot: Slot, why = "rock worker failed"): void => {
    slot.dead = true;
    try {
      slot.w.terminate();
    } catch {
      /* already gone */
    }
    for (const [n, j] of jobs) {
      if (j.slot !== slot) continue;
      jobs.delete(n);
      j.reject(new Error(why));
    }
  };
  return {
    close(): void {
      for (const s of workers) fail(s, "rock farm closed");
    },
    build(job: RockJob, cell: number, halo: boolean): Promise<RockPixels | null> {
      return new Promise((resolve, reject) => {
        try {
          if (workers.length < size) {
            const slot: Slot = { w: makeWorker(), busy: 0, dead: false };
            slot.w.onmessage = (e: MessageEvent<RockOut>) => {
              const j = jobs.get(e.data.n);
              if (!j) return;
              jobs.delete(e.data.n);
              slot.busy--;
              j.resolve(e.data.pixels);
            };
            slot.w.onerror = () => fail(slot);
            workers.push(slot);
          }
          let best: Slot | undefined;
          for (const s of workers) if (!s.dead && (!best || s.busy < best.busy)) best = s;
          if (!best) throw new Error("no rock worker left");
          const n = next++;
          jobs.set(n, { resolve, reject, slot: best });
          best.busy++;
          best.w.postMessage({ n, job, cell, halo } satisfies RockIn);
        } catch (err) {
          reject(err);
        }
      });
    },
  };
}
