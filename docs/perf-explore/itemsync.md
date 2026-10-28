# Item grid patches in one kernel call (idea 100)

Exact. `syncItems` drops from 0.18-0.23 to 0.10-0.13 ms per tick (CPU clock), about 0.08-0.10 ms (0.7%) of the tick at 3300 and at the cap. Under the 1% bar. Branch `pl-itemsync`, base `perf-live` 538804e.

## Attribution (temporary timers, 3300 creatures, 58 patches a tick, each shifting 122 items and 261 start entries)

| Part of a patch                              | us per patch (timers inflate each by 0.1-0.5) |
|----------------------------------------------|-----------------------------------------------|
| three `copyWithin` (xy, kind, id)            | 1.8 to 2.0                                    |
| `start[j] += delta` loop over the row's tail | 2.8 (about 10 ns an entry, scalar, bounds-checked) |
| count the cell's list                        | 0.6                                           |
| `writeCell`                                  | 0.5                                           |

Dirty cells are nearly all in different rows (a row is about 260 cells wide), so batching per row would share nothing. The cost is per patch, not per row.

## What

- `sense.wat` `patchItems`: takes records (start entry address, row end address, new count, row run end) and for each in order does the three `memory.copy` shifts and a v128 add over the later start entries. Returns the records done; fewer than given means a row outgrew its run.
- `WasmSenser.patchCells` (replaces `patchCell`): JS counts each dirty cell's list into the records (one region, 16 KB), one kernel call, then `writeCell` per cell at the final start offsets. A failed record or more than 1024 dirty cells (cheaper to pack again whole) takes the existing full pack.
- Item order inside a cell and the packed layout are unchanged.

## Measured

`syncItems` only, one `threadCpuUsage` pair per tick, ticks 100-700, pinned to cpus 2,3,6,7 at nice 19, alternating:

| Case   | Base (ms/tick)             | Yours (ms/tick)            | Medians        |
|--------|----------------------------|----------------------------|----------------|
| mixed  | 0.196, 0.164, 0.182        | 0.103, 0.111, 0.094        | 0.182 -> 0.103 |
| cap    | 0.228, 0.224, 0.264        | 0.125, 0.143, 0.120        | 0.228 -> 0.125 |

`liveBench --profile`, 60 s, 3 alternating pairs (load varied widely: base cpuMsPerTick 11.98 x3 mixed, 14.49/14.34/12.96 cap; yours 11.98/12.01/11.68 mixed, 14.25/13.75/11.56 cap):
- senser phase mixed: base 4.444, 4.395, 4.368; yours 4.386, 4.359, 4.246 (median -0.036).
- senser phase cap: base 5.585, 5.543, 5.012; yours 5.467, 5.247, 4.423 (load noise swamps it).
- fingerprints equal: 708687555 (mixed) and 10334191 (cap) in all runs. Peak RSS 214-218 vs 215-216 (mixed), 253-257 vs 254-256 (cap).
- the whole-tick change is inside the run-to-run spread; only the isolated timer shows it.

## Not built

- One interleaved record for xy, kind and id: the three copies are now inside one kernel call at about 0.1 us each, and the sense and touch kernels read the three arrays separately.
- Tombstones: the scout's estimate (under 0.07 ms net) is below this gain, and they need a reader-side skip.
- Remaining 0.10 ms is the JS list walks (cold `nextItem` and `xs`/`ys` reads) and `writeCell`.

## Tests

`tests/typescript/wasmKernels.test.ts`: packed rows equal the cell lists item for item over 40 rounds of changes, with many changes in one row, repeated cells and every tenth round dropping the dirty list. Red when the start shift adds 0 (mutant checked). `vitest run wasm sense crowd ecosystem resident --maxWorkers=2 --testTimeout=180000`: 150 passed, exit 0 (with the default 20 s timeout four slow world tests timed out on the loaded machine, not on a failure). tsc clean.

## Verdict

Exact and safe, about 0.7% of the tick for 37 wat lines and a net 26 JS lines. Does not reach the 1% bar alone; suggest merging only if it is combined with other small wins.
