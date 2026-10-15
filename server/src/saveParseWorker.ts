import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { otherWorldReason } from "./saveParse.ts";
import type { Home } from "./saveParse.ts";

// See saveParse.ts. Building the world once here runs every check of restoreState inside this worker's heap cap.
// A real save is a few long base64 texts and some 15 000 commas and brackets (at most about 520 000 for 20 000 creatures), while a crafted one
// of millions of tiny values ("[{},{},...]") makes JSON.parse allocate far more than its size and grind near the heap cap; it is refused unparsed.
const MAX_JSON_TOKENS = 1_000_000;
const { gz, maxJsonBytes, verifyOnly, home } = workerData as { gz: Uint8Array; maxJsonBytes: number; verifyOnly: boolean; home: Home | null };
try {
  const json = gunzipSync(gz, { maxOutputLength: maxJsonBytes });
  let tokens = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if ((c === 0x2c || c === 0x5b || c === 0x7b) && ++tokens > MAX_JSON_TOKENS) throw new Error("save has too many JSON values");
  }
  const state = JSON.parse(json.toString("utf8")) as EcoState;
  const other = home ? otherWorldReason(state, home) : null;
  if (other) parentPort!.postMessage({ ok: false, other: true, reason: other });
  else {
    // Post the state rebuilt from the checked world, so unknown keys and junk in the file never reach the main heap.
    const world = restoreState(state, null);
    parentPort!.postMessage({ ok: true, state: verifyOnly ? null : saveState(world) });
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, reason: e instanceof Error ? e.message : String(e) });
}
