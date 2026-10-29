# Idea 78: stream the save JSON into the gzip (pack worker memory)

Branch `pl-packstream` (from perf-live dc01b41). Server code (`server/src/saveWriteWorker.ts`), under the push gate.

| Idea | Before | After | Exact? | Pack worker added RSS | Process peakRssMB (bench, median of 3) | Lines | Verdict |
|------|--------|-------|--------|-----------------------|----------------------------------------|-------|---------|
| Idea 78: gzip stream fed the JSON in pieces | JSON string, its Buffer, base64 columns and gzip output all alive | text between columns plus one 786 kB base64 piece at a time | gzip sha256 equal on 2 worlds + test; fingerprints equal | +167 -> +80 MB (a800), +165 -> +72 MB (cap) | 544 -> 545 MB (3300); 555 -> 517 MB (cap, 1 pair) | 20 code, 25 test | Merge for the pack worker; the process peak is the verify worker now |

## What changed
- `packState(s, col = pack)` (ecoState.ts): `col` turns a column into its string. The worker passes a function that returns a random marker (`crypto.randomUUID()`, so no visitor text can match) and records the column.
- `saveWriteWorker.ts`: `JSON.stringify` of the marker state (everything except the columns), split at the markers. The exact JSON byte length is known before any gzip work (text `Buffer.byteLength` plus `4 * ceil(n / 3)` per column), so `TooBig` fires at the same threshold with the same `bytes`, without compressing. Then an async generator yields each text part and each column's base64 in pieces of `3 << 18` bytes (a multiple of 3, so the pieces join to the column's base64), piped through `createGzip()` (same defaults as `gzipSync`: level 6, memLevel 8, windowBits 15). The column is never held as one 14 MB string.
- Unchanged: 384 MB worker cap, 10 s timeout, message protocol (`{ok, gz, bytes}` / `{tooBig}` / `{reason}`), `packSave`.
- No flush: the stream only writes, then ends. zlib output does not depend on the input chunking without a flush, and the sha256 below confirms it.
- Tried and dropped: detaching each column's ArrayBuffer (`transfer(0)`) after writing, to free the 30 MB snapshot early: 69-77 vs 79-87 MB added, within noise.

## Measured
Worker peak: `/proc/self/status` VmHWM reset before `packSave` in a fresh process holding the snapshot (`sp/meas.ts` of savepeak.md), 3 runs each, MB added over the start RSS (156). Worlds: a800 (800 copies of 4 founders, 3318 creatures, 40 743 837 JSON bytes) and 4900 juggernauts (cap, 40 223 709 bytes).

| World | Base added | New added | gzip sha256 (base = new) |
|-------|------------|-----------|--------------------------|
| a800    | 169, 167, 167 | 83, 79, 87 | 434e7922e428149a, 3 657 130 bytes |
| jug4900 | 164, 165, 165 | 73, 70, 72 | 67e80a680d34020f, 2 262 982 bytes |

Inside the worker (`process.memoryUsage().rss`, a800): 201 at worker start (156 main + the worker's own boot of 45), 202 after the marker JSON, 231 after the gzip, 238 at the end. So the pack's own transient is about 37 MB over a worker that is already booted. The 45 MB boot and the 30 MB snapshot are not touched by this idea.

Exactness: `scratch eq.ts` compares `gzipSync(Buffer.from(JSON.stringify(packState(snap))))` with `packSave` on both worlds: sha256 equal. `maxJsonBytes = bytes - 1` rejects with `TooBig(bytes)`, `= bytes` passes. Test in liveSaves: the same on a 4900-juggernaut world with `thinkEvery = 2` (outputs column), sha256 equal, `TooBig` at `bytes - 1`.

Process peak: `liveBench --seconds 120 --copies 800 --save 30` (4 saves per run), alternating base/new, `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, load about 12:

| Pair | Base peakRssMB | New peakRssMB | cpuMsPerTick base / new | Fingerprint (all) |
|------|----------------|---------------|-------------------------|-------------------|
| 1 | 565 | 554 | 18.36 / 18.56 | 979232171 |
| 2 | 531 | 545 | 18.21 / 18.42 | 979232171 |
| 3 | 544 | 541 | 18.40 / 18.61 | 979232171 |
| cap (`--only juggernaut --copies 4900`) | 555 | 517 | 19.83 / 20.14 | 989001190 |

Medians 544 vs 545 MB: no change at 3300. The cap pair (one pair) shows -38 MB, within the 531-565 spread of the base alone. All 16 saves completed at the real 10 s pack timeout (tick stalls 20-82 ms both sides). cpuMsPerTick is the tick loop, not the worker (new about 1% higher, within load noise).

## Why the process peak does not move
The save runs the pack worker, then the verify worker (idea 69: +205 MB at 3300, the `JSON.parse` stage), one after the other. The process peak is the verify worker on top of the main heap, so shaving the pack worker from +167 to +80 MB lowers the pack's momentary RSS but not the maximum. The pack worker's saving only shows in peakRssMB if the verify worker is cut below it (for example a streaming parse or a verify that does not hold the 41 MB text and the parsed objects together). The pack is also no longer the larger of the two, so further pack trims will not help either.

## Tests
`npx vitest run liveSaves live --maxWorkers=1 --testTimeout=180000` in `src/typescript`: 304 passed, exit 0. `npx tsc --noEmit` in `server/` and in `src/typescript/`: exit 0.

## Verdict suggestion
Merge (3-review push gate applies): pack worker -87 MB added RSS, byte-identical output, same limits and protocol, no slower, 20 lines. Say plainly that the bench `peakRssMB` is unchanged until the verify worker is trimmed; that is the next memory idea.
