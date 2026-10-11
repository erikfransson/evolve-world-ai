import { Worker } from "node:worker_threads";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";

// Unzips, parses and checks a save on a worker thread with its own small heap, so a crafted save (deep or many tiny JSON values)
// can at worst kill that worker, never the server. Resolves with a state restoreState accepted there, rejects with the reason otherwise.
export const PARSE_HEAP_MB = 384;
const PARSE_TIMEOUT_MS = 120_000;
const WORKER = new URL("./saveParseWorker.ts", import.meta.url);

export function parseSave(gz: Uint8Array, maxJsonBytes: number): Promise<EcoState> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { gz, maxJsonBytes }, resourceLimits: { maxOldGenerationSizeMb: PARSE_HEAP_MB, maxYoungGenerationSizeMb: 32 }, stdout: false, stderr: false });
    let settled = false;
    const finish = (err: Error | null, state?: EcoState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (err) reject(err);
      else resolve(state!);
    };
    const timer = setTimeout(() => finish(new Error("parsing the save took too long")), PARSE_TIMEOUT_MS);
    worker.on("message", (m: { ok: true; state: EcoState } | { ok: false; reason: string }) => finish(m.ok ? null : new Error(m.reason), m.ok ? m.state : undefined));
    worker.on("error", (e: Error) => finish(new Error(`save parser failed: ${e.message}`)));
    worker.on("exit", (code) => finish(new Error(`save parser stopped (exit ${code})`)));
  });
}
