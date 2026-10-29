# Array-of-structs item records for the gathers (idea 72)

Rejected. Exact, but the sense kernel gets 1.6-4.6% slower and nothing else moves. Branch `pl-aos` from `perf-live` 3b56d06 (the diff is kept on the branch for reference).

## What was built

The packed item rows (`cells.md`) held three per-slot arrays, `xy` (f32 pairs), `kinds` (u8) and `ids` (i32). They became one 16-byte record `{x f32, y f32, kind i32, id i32}` per slot, same slot order, same `start[]` table (`senser.ts` syncItems, patchCell, writeCell, itemTables; `sense.wat` item walk; `crowd.wat` touch; `layout.ts` `S_ITEM_REC`, `C_ITEM_REC`, the kind and ids pointers are gone). The touch kernel changed with it because it shares the table, so the "item half first" split was not possible. `patchCell` now shifts the row tail with one `copyWithin` instead of three. +31/-51 lines of source.

Memory: 13 to 16 bytes per slot. At The Inland Sea (500 x 313 cells, `rowCap` 547, 171211 slots) 2.23 to 2.74 MB, +0.51 MB. liveBench peak RSS 214-220 vs 216-219 MB (800 case), 253-255 vs 253-254 (cap case): within the spread.

## Kernel harness (snapshots of the real LiveWorld at ticks 400 and 1500, one per tree, own kernel on its own snapshot; cold = 32 MB sweep before each call, interleaved, `--no-liftoff`, 60 reps)

Brain inputs of all 3331 / 3294 creatures hashed after NaN poisoning of the input region: b101b365 (tick 400) and 50357cc0 (tick 1500), equal to base, no poison left. Scripts in the scratchpad `aos/` (`time2.ts`, `lines.ts`).

| Run | t400 aos/base p25 | t1500 aos/base p25 |
|-----|-------------------|--------------------|
| cold, 3 runs | 1.035, 1.043, 1.046 (min ratios 1.017, 1.008, 1.027) | 1.026, 1.016 |
| hot (no sweep) | 1.046 | |
| records moved to 4 other offsets mod 4096 | 1.042, 1.050, 1.046, 1.054 | |
| candidate buffer moved (base and aos) | base 0.99-1.00, aos 1.029-1.042 | |
| `$ip` local removed (address recomputed inline) | 1.031 | |

Base p25 4.7 ms (t400), 4.15 ms (t1500). So it is not address aliasing and not the extra local; the slowdown is steady, 0.15-0.2 ms.

## Why: lines per visit fall, lines per call rise

Counted from the snapshot (item walk, 64-byte lines, `lines.ts`):

| | per non-empty row visit | unique lines per call, t400 / t1500 |
|---|---|---|
| separate arrays (xy + kinds) | 2.17 (xy 1.16, kind 1.02) | 7723 / 5359 |
| 16-byte records | 1.32 | 9383 / 6341 |
| 12-byte records (x, y, kind; not built) | 1.37 | 8477 / 5786 |

Per creature 4.46 row visits, 75% non-empty (t400), 2.29 items per run. The record layout does cut the lines per visit by 39%, as the idea expected, but creatures sharing a row region reuse lines inside one call: the kind array is 1 byte per slot, so 64 slots share a line and it is almost free after the first touch, while the records double the xy footprint (8 to 16 bytes). Unique lines per call rise 21-18%, and a first touch is the miss that costs. Reading 0.1 ms per 1650 extra lines is the right size for the measured loss (hypothesis from the counts, the kernel was not run under a hardware counter).

## liveBench, `--profile`, 60 s, alternating pairs (base = `perf-live` worktree a63f369, engine equal to 3b56d06), 3 pairs, load about 20

| Case | cpuMsPerTick base / aos | senser ms base / aos | eat ms base / aos | fingerprint | peak RSS MB |
|------|-------------------------|----------------------|-------------------|-------------|-------------|
| 4 founders x 800 | 14.237, 14.195, 13.889 (med 14.195) / 14.385, 14.412, 14.117 (med 14.385) | med 5.405 / 5.580 | med 1.182 / 1.195 | 708687555 both | 214-220 / 218-219 |
| juggernaut x 4900 | 17.144, 17.049, 17.156 (med 17.144) / 17.146, 17.160, 17.114 (med 17.146) | med 6.811 / 6.907 | med 1.560 / 1.556 | 10334191 both | 253-255 / 253-254 |

Ratio of medians of cpuMsPerTick: 1.013 (mixed), 1.000 (cap). Senser phase +0.18 ms / +0.10 ms. The eat phase (touch reads one line for x, y and id instead of two) is unchanged within noise, so the touch side gives nothing either.

## Tests

`tsc --noEmit` exit 0; `npx vitest run wasmCrowd wasmKernels thinkEvery residentBodies wasmStep --testTimeout=180000 --maxWorkers=1` 94 passed, exit 0 (includes the kernel drift test after `npm run wasm`); `world.test sensors rayRecast` 34 passed, exit 0.

## Verdict

Reject. Fewer lines per visit does not help when the lines are shared across the creatures of one call; the walk is bound by unique lines touched and per-row work, as in `senselive.md` and `gather4.md`. A layout that would lower unique lines needs smaller records, not fewer: x, y and kind cannot shrink without changing values (f32 x, y), so there is no exact version of this idea.
