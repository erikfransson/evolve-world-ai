| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Idea 69: trim the transient copies in the save workers (Buffer base64, one JSON Buffer for length and gzip, parse in a helper) | pack worker +182..231 MB, verify +240 MB; bench peak median 549 MB (3300), 594 MB (4900) | pack +168 MB, verify +205 MB; bench peak median 518 MB, 564 MB | none on the tick; the pack worker itself 3x faster (18-24 s to 6-7 s wall under load) | Yes (gzip bytes sha256 and fingerprints equal) | -31 MB (-6%) at 3300, -30 MB at 4900 | 8 code, 20 test | Merge (server code: 3-review push gate) |

## What changed

- `pack()` (ecoState.ts): `Buffer.from(bytes).toString("base64")` when `Buffer` exists, the old `btoa` loop otherwise. Same text, no rope of 32 KB chunks.
- `saveWriteWorker.ts`: `Buffer.from(JSON.stringify(...))` once, `json.length` for the size and `gzipSync(buffer)`, instead of `Buffer.byteLength(string)` and `gzipSync(string)` each converting the 41 MB string again.
- `saveParseWorker.ts`: gunzip, token count and `JSON.parse` moved into `parseJson()`, so the 41 MB Buffer and its text are unreachable before `restoreState` runs.
- Blanking the base64 columns after `unpack` (a `consume` option of `restoreState`) was tried and gave no change (281 MB both ways), because the verify worker's peak is the `JSON.parse` stage (rss 201 after gunzip, 279 after parse, 275 after `restoreState`), not the restore. Dropped.
- Caps (384 MB workers, 10 s pack, 40 s verify) unchanged.

## Measured

Worker peaks: `/proc/self/status` VmHWM reset (`clear_refs`) just before `packSave` / `parseSave(..., true)` in a fresh process holding only the snapshot (30.7 MB) or the 3.7 MB gzip; world of 3318 creatures, JSON 40 743 837 bytes; 3 runs each (added = peak minus start RSS, MB).

| Worker        | Base added       | New added        |
|---------------|------------------|------------------|
| pack          | 182, 231, 231    | 168, 168, 168    |
| verify (parse)| 240, 237, 241    | 205, 205, 206    |

The gzip file is byte-identical (sha256 prefix 434e7922e428149a both) and so is the gunzipped JSON (aa35892a508c4e07).

Process peak: `node src/liveBench.ts --seconds 120 --copies 800 --save 30` (4 saves per run), alternating pairs, `peakRssMB`:

| Pair | Base | New | Fingerprint (all runs) |
|------|------|-----|------------------------|
| 1    | 530  | 518 | 979232171              |
| 2    | 549  | 512 | 979232171              |
| 3    | 584  | 522 | 979232171              |

Median 549 vs 518 MB (-31). Cap case `--only juggernaut --copies 4900`, one pair: 594 vs 564 MB, fingerprint 989001190 both.
The machine ran at load 15-20, so both sides ran from throwaway copies with the pack and verify timeouts raised to 300 s: at the real 10 s pack cap the base's rope packer timed out on this loaded machine ("not saved: packing the save took too long" on every save of one run, peak 313 MB with no completed save), the new one finished all four.

## Tests

`npx vitest run liveSaves live --testTimeout=180000 --maxWorkers=1`: 293 passed, exit 0 (all `live*` test files in `tests/typescript`). New test in `liveSaves.test.ts`: every packed column equals `btoa` over its bytes (the old path). `npx tsc --noEmit` exit 0.
