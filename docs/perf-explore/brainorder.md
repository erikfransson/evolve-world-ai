# Brain run order: run the brains by weight-block address

Branch `pl-brainorder`, change in `src/typescript/src/sim/wasm/brainKernel.ts` only (+58 -3).
Question: does running the brain kernel in block-address order, instead of the batch (row) order, help the prefetcher and the brain3 next-block touches?

## What changed
- The bank keeps `order`, the slots holding a brain sorted by block address, updated by binary search and `copyWithin` in `set()` only when a block moves (new slot, or a shape whose rounded size changed). Same-size births reuse the block and cost nothing.
- `forwardRun` stamps the slots the fill kernel wrote, then rewrites the list as the stamped slots in `order` (n + slots typed-array steps, about 10 us). Works for thinkEvery subsets too.
- The sense kernel already ran on its own order, the fill kernel addresses inputs by slot and the step kernel reads outputs from the rows, so only the brain run order changes. Each brain depends only on its own block, so the bits are the same.

## Why the order drifts
Slots never move, but `set()` reallocates a block when a newborn's shape rounds to a different size, and the arena hands out freed blocks of that size (LIFO). The batch order is 97.5% ascending in address at tick 600, 93.5% at 3000, 81% at 9000 and 70% at 18000, so the effect grows with the age of the world.
Blocks are never contiguous: a creature's 256-byte memory-unit block sits between brains (gap histogram: 256 B for about 90% of neighbours). Packing the blocks back to back (upper bound of a separate brain arena) adds only 1-2% over the sorted order.

## How measured
Kernel: `scratchpad/bo/oab.ts` (kab.ts variant): one tick's real brain run on the dumped live memory, the same wat, the slot list permuted, user CPU, median of 41, cold (48 MB eviction) and hot, output vectors hashed (equal in every variant).
Tick: `liveBench`, perf-live (c5840b3) as base, alternating pairs, load 8-13.

## Kernel (live mix, ratio to batch order, cold / hot)

| Tick  | Batch ms    | Address order | Slot order  | Address descending | Packed, 64 B |
|-------|-------------|---------------|-------------|--------------------|--------------|
| 600   | 4.30 / 4.28 | 1.006 / 1.015 | 0.99 / 1.01 | 0.94 / 0.94        |              |
| 3000  | 3.00 / 3.26 | 1.001 / 1.027 | 0.98 / 1.01 | 0.91 / 0.94        |              |
| 9000  | 4.69 / 4.56 | 1.071 / 1.065 | 1.01 / 1.00 | 1.01 / 1.00        | 1.11 / 1.09  |
| 18000 | 4.73 / 4.60 | 1.098 / 1.091 | 1.00 / 1.00 | 1.04 / 1.04        | 1.11 / 1.12  |

Allocation order (slot order) does no better than the batch order, descending addresses are worse.

## Whole tick (cpuMsPerTick)

| Case                                | Base                                | brainorder                          | Ratio of medians | Fingerprint      | Peak RSS MB        |
|-------------------------------------|-------------------------------------|-------------------------------------|------------------|------------------|--------------------|
| 4 founders x 800, 60 s              | 13.08, 12.99, 13.02                 | 12.98, 12.95, 12.83                 | 1.005x           | 708687555 both   | 213-219 / 214-217  |
| same, 180 s, `--profile`            | 12.39, 10.12, 12.46                 | 12.34, 12.30, 12.35                 | 1.004x           | 76698974 both    | 216-250 / 220-254  |
| brain forward phase, 180 s          | 4.37, 3.56, 4.37                    | 4.30, 4.30, 4.31                    | 1.015x           |                  |                    |
| same, 600 s, `--profile`            | 12.15, 12.21, 12.26, 12.19, 12.18   | 11.36, 11.24, 10.77, 10.89, 11.02   | 1.107x           | 164690887 both   | 264-267 / 263-267  |
| brain forward phase, 600 s          | 4.51, 4.53, 4.55, 4.54, 4.53        | 4.09, 4.04, 3.90, 3.93, 3.99        | 1.12x            |                  |                    |
| Juggernaut x 4900, 60 s             | 15.75, 16.03, 12.00                 | 15.86, 12.48, 15.77                 | 1.00x            | 10334191 both    | 252-258 / 254-257  |
| Juggernaut x 4900, 180 s            | 15.01, 15.05, 15.13                 | 15.15, 12.07, 15.16                 | 0.99x            | 381483493 both   | 260-261 / 256-262  |

Juggernauts all share one shape, so blocks never move and the order never drifts: no gain, no cost.
At 600 s every pair favours brainorder, but the other phases (crowd grid, senser, eat) are also 5-9% faster in every pair, which this change should not touch. The part I can attribute is the brain phase, 0.49 ms (about 4% of the tick), which matches the kernel A/B at tick 18000 (0.42 ms).

## Verdict suggestion
Merge: exact (all four fingerprints equal), about 10 us per tick, no RSS change, 61 lines in one file.
The 60 s bench barely sees it (0.5%), but a live world runs for days and the drift grows with age: the brain kernel gains 9-12% from about 10 minutes on, 3-4% of the tick. The 600 s whole-tick 1.107x overstates it, as non-brain phases moved too.
A separate arena for brain blocks (no unit blocks in between) would add 1-2% of the kernel at most; not worth it.
