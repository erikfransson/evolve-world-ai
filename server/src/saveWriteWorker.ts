import { parentPort, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { packState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoSnapshot } from "../../src/typescript/src/sim/ecoState.ts";

// See packSave in saveParse.ts: the base64 packing, JSON.stringify and gzip of a save, off the tick loop.
const { snap, maxJsonBytes } = workerData as { snap: EcoSnapshot; maxJsonBytes: number };
try {
  const json = JSON.stringify(packState(snap));
  const bytes = Buffer.byteLength(json);
  if (bytes > maxJsonBytes) parentPort!.postMessage({ ok: false, tooBig: bytes });
  else {
    const gz = new Uint8Array(gzipSync(json)); // its own buffer, so the transfer moves nothing else
    parentPort!.postMessage({ ok: true, gz, bytes }, [gz.buffer]);
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, reason: e instanceof Error ? e.message : String(e) });
}
