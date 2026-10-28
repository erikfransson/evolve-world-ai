import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import { createGzip } from "node:zlib";
import { packState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoSnapshot } from "../../src/typescript/src/sim/ecoState.ts";

// See packSave in saveParse.ts: the base64 packing, JSON text and gzip of a save, off the tick loop.
// The JSON is never held whole: the text around the columns is stringified with a marker per column, and the gzip stream gets that text and
// each column's base64 a piece at a time. The bytes equal gzipSync(JSON.stringify(packState(snap))): zlib output does not depend on how the input is split, and nothing here flushes.
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
    async function* text(): AsyncGenerator<Buffer | string> {
      for (let i = 0; i < parts.length; i += 2) {
        yield parts[i]!;
        const col = columns[i >> 1];
        if (!col) continue;
        for (let at = 0; at < col.length; at += PIECE) yield Buffer.from(col.buffer, col.byteOffset + at, Math.min(PIECE, col.length - at)).toString("base64");
        columns[i >> 1] = new Uint8Array(0); // written
      }
    }
    const out: Buffer[] = [];
    for await (const c of Readable.from(text(), { objectMode: false }).pipe(createGzip())) out.push(c as Buffer);
    const gz = new Uint8Array(Buffer.concat(out)); // its own buffer, so the transfer moves nothing else
    parentPort!.postMessage({ ok: true, gz, bytes }, [gz.buffer]);
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, reason: e instanceof Error ? e.message : String(e) });
}
