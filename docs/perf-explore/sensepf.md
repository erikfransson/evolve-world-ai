# Sense kernel: touching the next creature's lines (idea 84)

Rejected. Exact in every variant (brain inputs hash equal to the base: 35f12a2d at tick 400, cb1ad30c at 1500; fingerprints 708687555 and 10334191 unchanged), but every variant is slower. Branch `pl-sensepf` from `perf-live` 531a215, docs only; the prototypes were generated scratch copies of `sense.wat`.

## What

A `$touch(P, nextRecord)` function called right after the record load of creature j, for creature j+1 (skipped for the last): it computes the same clamped cell windows as the walks (every index clamped into the grid, so all touches are in bounds for any position, NaN included) and issues `drop (load ...)` touches, as `brain.wat` does. Flags: `o` the offset table (one touch per 64 bytes of the cos/sin tables), `i` item row starts (`itemStart` at cx0 and cx1+1 of each row), `e` the first item of each row run (guarded by `it < ie`), `c` crowd row starts, `k` crowd `sx`/`sy` of the first entry per row (guarded), `1` first row only, `n` empty body (cost of the call).

## Kernel (snapshots of the real LiveWorld at ticks 400 and 1500, cold = 32 MB sweep, interleaved, 150 reps, `--no-liftoff`, pinned 2,3,6,7 nice 19, load 8-12)

p25 in ms; base 4.25 (t400 cold), 4.23 (t400 hot), 3.69 (t1500 cold).

| Variant                         | t400 cold | t400 hot | t1500 cold |
|---------------------------------|----------:|---------:|-----------:|
| n (empty call)                  | 4.27      | 4.24     | 3.72       |
| o (offset tables)               | 4.36      | 4.31     | 3.80       |
| 1i (first item row start)       | 4.60      | 4.57     | 4.04       |
| i (item row starts)             | 4.72      | 4.71     | 4.18       |
| ie (rows plus first entry)      | 4.70      |          |            |
| 1ic (first rows, items+crowd)   | 4.97      | 4.92     |            |
| ick (rows, crowd rows+entries)  | 5.27      |          | 4.70       |
| oick, oicke                     | 5.34      |          |            |

Every touch adds time, in proportion to the loads it issues. Hot and cold are equal, so the lines are not cold in the sense that matters (the 2 MB of grid tables live in L2/L3 and the reads of the walk are already overlapped by the out-of-order core).

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, 3 alternating pairs, variant `i`)

| Case  | Build | cpuMsPerTick | senser ms | peak RSS MB | fingerprint |
|-------|-------|--------------|-----------|-------------|-------------|
| mixed | base  | 13.042, 13.148, 13.854 (13.148) | 4.913, 4.983, 5.189 (4.983) | 221, 216, 213 | 708687555 |
| mixed | i     | 13.580, 13.856, 14.475 (13.856) | 5.430, 5.526, 5.742 (5.526) | 218, 219, 219 | 708687555 |
| cap   | base  | 16.516, 16.334, 16.359 (16.359) | 6.537, 6.435, 6.481 (6.481) | 257, 253, 254 | 10334191 |
| cap   | i     | 17.436, 17.103, 16.476 (17.103) | 7.382, 7.260, 6.959 (7.260) | 256, 251, 255 | 10334191 |

Ratio of medians (yours / base): mixed 1.054, cap 1.045 (senser 1.11 and 1.12). Slower on every pair.

## Why

A WASM load that misses blocks retirement, unlike `prefetcht0` (`brain3.md`). The brain touch works because it is a sequential stream the hardware prefetcher follows, so the touches hit lines already on their way. The sense lines are scattered (4-5 row starts per creature at 2 KB strides, cells of a random position), so each touch is a real miss that the core now waits for in order, where the walk's own loads overlapped. One touch of one row start costs 0.3 ms per call (about 100 ns per creature), the price of an exposed miss. The offset tables are already interned (273 distinct among 3300), so they are mostly hot and their touch only adds instructions. `nsense.md` found the same with real prefetch instructions in a native twin (offset table -1 to -3%, rows -5 to -10%).

## Verdict

Reject. No variant is exact and faster; the least bad (`o`, offset tables) is +2%. No engine change committed. Only a non-blocking prefetch could change this, which WASM lacks (`native.md`, `nsense.md`).
