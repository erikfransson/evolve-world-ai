import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { packState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoSnapshot } from "../../src/typescript/src/sim/ecoState.ts";

// See packSave in saveParse.ts: the base64 packing, JSON text and gzip of a save, off the tick loop.
// The JSON is never held as a string: the text around the columns is stringified with a marker per column, and that text and each column's
// base64 (a piece at a time) are written into one Buffer of the exact size. The bytes equal gzipSync(JSON.stringify(packState(snap))).
const { snap, maxJsonBytes } = workerData as { snap: EcoSnapshot; maxJsonBytes: number };
const PIECE = 3 << 18; // bytes of a column per base64 piece, a multiple of 3 so the pieces join to the column's base64
try {
  const columns: Uint8Array[] = [];
  const mark = randomUUID(); // a visitor's text cannot contain it
  const parts = JSON.stringify(packState(snap, (a) => mark + (columns.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) - 1))).split(new RegExp(`${mark}(\\d+)`));
  if (parts.length !== 2 * columns.length + 1) throw new Error("save columns not found in the JSON");
  const bytes = parts.reduce((n, p, i) => n + (i % 2 ? 4 * Math.ceil(columns[i >> 1]!.length / 3) : Buffer.byteLength(p)), 0); // exact, known before any gzip work
  if (bytes > maxJsonBytes) parentPort!.postMessage({ ok: false, tooBig: bytes });
  else {
    const json = Buffer.allocUnsafe(bytes);
    let at = 0;
    for (let i = 0; i < parts.length; i += 2) {
      at += json.write(parts[i]!, at);
      const col = columns[i >> 1];
      if (!col) continue;
      for (let from = 0; from < col.length; from += PIECE) at += json.write(Buffer.from(col.buffer, col.byteOffset + from, Math.min(PIECE, col.length - from)).toString("base64"), at, "latin1");
      columns[i >> 1] = new Uint8Array(0); // written
    }
    if (at !== bytes) throw new Error("save JSON size mismatch");
    const gz = new Uint8Array(gzipSync(json)); // its own buffer, so the transfer moves nothing else
    parentPort!.postMessage({ ok: true, gz, bytes }, [gz.buffer]);
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, reason: e instanceof Error ? e.message : String(e) });
}
