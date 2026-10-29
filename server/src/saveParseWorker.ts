import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { otherWorldReason } from "./saveParse.ts";
import { oldestInState } from "./carry.ts";
import type { Home } from "./saveParse.ts";

// See saveParse.ts. Building the world once here runs every check of restoreState inside this worker's heap cap.
// A real save is a few long base64 texts and some 15 000 commas and brackets (at most about 520 000 for 20 000 creatures), while a crafted one
// of millions of tiny values ("[{},{},...]") makes JSON.parse allocate far more than its size and grind near the heap cap; it is refused unparsed.
const MAX_JSON_TOKENS = 1_000_000;
const { gz, maxJsonBytes, verifyOnly, home, carryFrom } = workerData as { gz: Uint8Array; maxJsonBytes: number; verifyOnly: boolean; home: Home | null; carryFrom: string | null };
// Its own function, so the gunzipped bytes and their text are garbage before restoreState builds the world.
// A collection once restoreState has decoded the base64 columns, so the 40 MB of column text and of parse input is gone before the world is built.
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
function parseJson(): EcoState {
  const json = gunzipSync(gz, { maxOutputLength: maxJsonBytes, chunkSize: maxJsonBytes + 1 }); // one chunk, so no second copy is made to join them
  let tokens = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if ((c === 0x2c || c === 0x5b || c === 0x7b) && ++tokens > MAX_JSON_TOKENS) throw new Error("save has too many JSON values");
  }
  const text = json.toString("utf8");
  // The bytes are freed here, not at some later GC: the text and the parsed values are alive together next. Own buffers only, never the shared pool.
  if (json.byteOffset === 0 && json.buffer.byteLength >= 1 << 20) (json.buffer as ArrayBuffer & { transfer(length: number): ArrayBuffer }).transfer(0);
  return JSON.parse(text) as EcoState;
}
try {
  const state = parseJson();
  const other = home ? otherWorldReason(state, home) : null;
  // A reset's carry: only the oldest creature, read from the columns without building the world, so a save of an older map version works too.
  if (carryFrom !== null) parentPort!.postMessage({ ok: true, carried: oldestInState(state, carryFrom) });
  else if (other) parentPort!.postMessage({ ok: false, other: true, reason: other });
  else {
    // Post the state rebuilt from the checked world, so unknown keys and junk in the file never reach the main heap.
    const world = restoreState(state, null, { decoded: collect });
    parentPort!.postMessage({ ok: true, state: verifyOnly ? null : saveState(world) });
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, reason: e instanceof Error ? e.message : String(e) });
}
