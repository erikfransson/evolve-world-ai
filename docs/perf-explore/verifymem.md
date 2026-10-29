# Idea 146: cut the save peak (verify worker, pack worker, worker young generation)

Branch `pl-verifymem` (from perf-live ee91a96). Server code (`server/src/saveParse.ts`, `saveParseWorker.ts`, `saveWriteWorker.ts`) and `restoreState` (an option), under the push gate.

## Where the verify worker's 125 MB sat (cap 4900 juggernauts, 40 MB JSON, one process, phase RSS)
| Stage | RSS over start (MB) |
|-------|--------------------:|
| gunzip (`gunzipSync` joins 16 kB chunks: 83 MB of ArrayBuffer for 40 MB of JSON) | +76 |
| `toString` (external one-byte string, 40 MB, beside the 40 MB Buffer) | +114 |
| `JSON.parse` (Buffer, text and parsed columns alive together) | +153 |
| `restoreState` end (columns 40 MB still in `state`, decoded arrays 30, wasm 48, genome copies 23) | +166 |
The world objects are about 60 of it (wasm and genome copies), the parsed JSON 40, the gunzipped buffer 40, the text 40, and they overlapped.
Floor for any in-memory parse: text 40 + parsed 40 = about +80. A custom column splitter or a streaming parse could go lower but changes the restore path; not built.

## What changed (bytes of the save unchanged)
1. Verify/parse worker: `gunzipSync` with one chunk (`chunkSize: maxJsonBytes + 1`, untouched pages are not resident); the Buffer is detached with `ArrayBuffer.transfer(0)` right after `toString` (own buffers only, never the shared pool); `restoreState(..., { decoded })` drops the base64 columns from `state` once decoded and calls a `gc()` (reached with `--expose-gc` set in the worker), so the 40 MB of text and column strings are gone before the world is built. Same parser, same checks, same world built; the restore path of the server is untouched.
2. Pack worker: idea 78's marker split (cherry-picked 0b33873), but the text and each column's base64 piece are written into one exact-size Buffer and gzipped in one `gzipSync` call instead of an async stream. Idea 78's stream lost 4 of 9 saves to the 10 s pack timeout under load 15 (async hops per piece under `chrt --idle`); this one is sync and was as fast or faster standalone (pack 1.2-1.4 s vs 1.4-2.8 s, cap and mixed).
3. `maxYoungGenerationSizeMb` 32 to 8 for the three save workers (`YOUNG_MB`): verify wall 6.1 to 6.3 s, no other change; the retained scavenge space was 25 to 40 MB of the peak.

Tried and dropped: verifying without building the world (weakens the guarantee: wasm build and `restoreMember` are where a bad save can still fail), releasing columns without the `gc()` (the garbage lived to the end of the restore; -17 instead of -38 in the phase run), a smaller young generation only on the verify worker (same gain as all three, kept uniform).

## Measured
Bytes: `sha.ts` restores each bench save with each tree's engine, snapshots, packs with that tree's `packSave`, verifies: gz sha256 prefix `13f1a94973f81135` (mixed, 3 183 070 B) and `fa23896d156007af` (cap, 2 211 129 B) equal on perf-live and this branch, and equal to the original file's sha256; gunzipped JSON hashes equal. The existing idea 78 test (sha equal to `gzipSync(JSON.stringify(packState(snap)))`, `TooBig` at `bytes - 1`) passes on the new pack.

Whole process, `liveBench --seconds 50 --save 15` (2 saves, ticks running, pinned, nice 19, load 14-16, a foreign bench running), `peakRssMB`, runs 1-3, order base / B (pack + verify, young 32) / C (B + young 8 = the commit):
| Case | base | B | C (final) | Fingerprint all |
|------|------|---|-----------|-----------------|
| mixed 3300 | 466, 439, 413 (median 439) | 414, 393, 363 (393) | 391, 378, 405 (391) | 303028926 |
| cap 4900   | 481, 488, 467 (481) | 474, 461, 468 (468) | 427, 428, 428 (428) | 10949528 |
Save peak over the steady footprint (RSS 195-200 mixed, 217 cap): about +240 base, +190 final at 3300; +265 base, +210 final at the cap. Median HWM -48 MB (3300) and -53 MB (cap), run spread at the final arm 27 (mixed) and 1 (cap), at base 53 and 21. cpuMsPerTick equal within load noise (24.4-28.2, all arms). All 12 saves of the final arm and all 12 of base went through at the real 10 s pack and 40 s verify timeouts; B lost 1 of 12 (mixed run 3). With idea 78's async stream instead of the sync pack, 7 of 13 saves in the first mixed campaign timed out (pack or verify) against 0 of 6 at base, which is why the pack is sync here.

Stage isolation (`stages.ts`: a process holding a restored world, snapshot then pack then verify, second round, `VmHWM` of the whole process per stage, 3 runs): pack 517-537 to 432-443, verify 555-575 to 480-491 (-75 to -90), idle after the saves 414-447 to 380-390. Same on the mixed world (pack 521-529 to 430-436, verify 559-567 to 481-491).
Verify worker alone (`meas.ts`, MB added over a start that holds the first worker's leftovers): cap 124, 128, 123 to 100, 99, 85 (young 32) and 85, 85, 99 (young 8); mixed 126, 128, 125 to 100, 102, 101.

## Tests
- `npx vitest run live ecoLive ecosystem ecoState --maxWorkers=1 --testTimeout=180000` in `src/typescript`: 362 passed in 20 files, exit 0 (run on the verify commit and again on the final head). `npx tsc --noEmit` in `server/` and `src/typescript/`: exit 0.
- New test in `liveSaves.test.ts` ("verify-only refuses a truncated, not-gzip, not-JSON or out-of-range save ..."): truncated gzip, not gzip, half a JSON text, NaN position, position outside the walls, huge velocity, huge item capacity, truncated column, null lineage table are each rejected by the verify worker; a good save verifies, and the non-verify parse returns state whose JSON equals the saved text (the dropped columns change nothing). It is a guard: it passes on perf-live as well, because the checks did not change.

## Verdict suggestion
Merge (push gate: 3 reviews). The cap peak falls 53 MB and the 3300 peak 48 MB at the bench level (80 MB in the stage-isolated harness), bytes identical, restore path and checks unchanged, about 45 code lines. This is short of 60 MB in the bench; the rest of the +190 to +210 is the main process (running footprint, glibc leftovers of the workers) and the in-memory parse floor (+80). Next levers, not exact-code: unit environment `MALLOC_ARENA_MAX=2` and fixed mmap/trim thresholds (idea 137 candidate 2, -84 MB steady), and a lower main-thread semi-space size.
