import { parentPort, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { packState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoSnapshot } from "../../src/typescript/src/sim/ecoState.ts";

// See packSave in saveParse.ts: the base64 packing, JSON.stringify and gzip of a save, off the tick loop.
const { snap, maxJsonBytes } = workerData as { snap: EcoSnapshot; maxJsonBytes: number };
try {
  const json = Buffer.from(JSON.stringify(packState(snap))); // converted once, then the length and the gzip read it as it is
  const bytes = json.length;
  if (bytes > maxJsonBytes) parentPort!.postMessage({ ok: false, tooBig: bytes });
  else {
    const gz = new Uint8Array(gzipSync(json)); // its own buffer, so the transfer moves nothing else
    parentPort!.postMessage({ ok: true, gz, bytes }, [gz.buffer]);
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, reason: e instanceof Error ? e.message : String(e) });
}
