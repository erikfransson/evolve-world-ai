# Brain weights and 4 KB pages (idea 108, study)

Branch `pl-pagepack` (from perf-live 8119c8b), docs only, no engine change.
Question: the scout (`scout-brain.md`) found each brain 28-35% faster when run a second time right after itself, and no touch-stream variant recovered it (`touchdist.md`). Is that cost address translation (a page-aware packer would fix it), L2 capacity, or something else, and what would 2 MB pages buy?

## How measured
- The tick-600 dumps of `touchdist.md` (mixed 3318 brains, juggernaut 4900), today's brain.wat, user CPU, cores 2,3,6,7 at idle priority, load 10-15. Absolute times drift between processes with the clock, so every comparison below is between instances in one process, interleaved, 31 reps, median.
- Layouts at equal bytes and equal lines read (blocks copied, descriptors rewritten, outputs bit-identical in every layout): `real` (the dump: brain blocks interleaved with unit blocks, rows and tables), `packed` (back to back in run order, 64 B aligned), `page` (packed, but no block straddles a 4 KB page unless it is larger than one), `spread` (every block starts a page), `straddle` (every block crosses one page boundary more than it must).
- 2 MB pages: a scratch addon calls `madvise(MADV_HUGEPAGE)` and `MADV_COLLAPSE` on the WASM memory (THP is `madvise` on this machine and V8 never asks), checked with `AnonHugePages` in `/proc/self/smaps`. Collapse got 26-42 MB per process (ENOMEM after that, memory is fragmented), so the huge rows say how much was covered. Also the native kernel of `pl-nativeprod` (brain.cc without N-API) on a buffer with and without huge pages.
- TLB from `cpuid` leaf 0x18: L1 DTLB (loads) 64 entries of 4 KB or 32 of 2 MB, STLB 1024 entries (4 KB or 2 MB) plus 1024 (4 KB or 1 GB), so 2048 pages of 4 KB (8 MB reach). L1d 48 KB, L2 1.25 MB per core, L3 12 MB shared with the other sessions.
- Harnesses in the session scratchpad `pp/` (`pp.ts` layouts cold, `sw2.ts` sweep, `cs.ts` cold subsets, `thp.cc`, `hp/hp.cc`, `tlb.c`), not committed.

## (1) Layout at equal bytes (cold full run: 48 MB eviction, inputs and descriptors read back, then one forward; ratio to real, higher is faster)

| Layout   | Mixed pages (per brain) | Mixed ratio             | Jug pages (per brain) | Jug ratio               |
|----------|-------------------------|-------------------------|-----------------------|-------------------------|
| real     | 6769 (9784)             | 1                       | 6764 (11023)          | 1                       |
| packed   | 6380 (9656)             | 1.015-1.028 (5 runs)    | 6203 (11026)          | 1.032-1.150 (5 runs, median 1.046) |
| page     | 6930 (7520)             | 0.981, 0.987, 0.988, 1.002 | 6534 (9800)        | 1.008, 1.048, 1.105     |
| spread   | 7520 (7520)             | 0.975, 0.987            | 9800 (9800)           | 0.913                   |
| straddle | 9120 (9120)             | 0.901, 0.907, 0.922, 0.923 | 9800 (9800)        | 0.865, 0.875, 0.987     |

Cutting the page crossings per brain by 22% (page against packed) does not help: on the mixed dump page is 2-4% slower than plain packing (its padding breaks the ascending stream), on the juggernaut dump the two are within noise. Plain packing gains 2-5%, from removing the foreign blocks between brains (the brain-only arena of `brainorder.md`, which estimated 1-2%).

## (2) Footprint sweep (hot: one call runs the first K brains cyclically, 3300 brain runs per call; us per brain run, two runs of the juggernaut dump)

| K    | Blocks MB | Pages real / straddle | real          | page          | straddle      |
|------|-----------|-----------------------|---------------|---------------|---------------|
| 1    | 0.005     | 2 / 3                 | 0.565 / 0.595 | 0.566 / 0.592 | 0.568 / 0.589 |
| 64   | 0.32      | 89 / 192              | 0.567 / 0.600 | 0.569 / 0.582 | 0.565 / 0.581 |
| 256  | 1.27      | 356 / 768             | 0.590 / 0.627 | 0.593 / 0.634 | 0.617 / 0.672 |
| 512  | 2.53      | 710 / 1536            | 0.610 / 0.657 | 0.602 / 0.658 | 0.652 / 0.682 |
| 768  | 3.80      | 1063 / 2304           | 0.637 / 0.682 | 0.634 / 0.688 | 0.690 / 0.762 |
| 1024 | 5.06      | 1416 / 3072           | 0.694 / 0.777 | 0.657 / 0.748 | 0.741 / 0.890 |
| 1280 | 6.33      | 1769 / 3840           | 0.695 / 0.835 | 0.729 / 0.823 | 0.823 / 0.909 |
| 1536 | 7.59      | 2121 / 4608           | 0.813 / 0.844 | 0.795 / 0.835 | 0.847 / 0.939 |
| 2048 | 10.1      | 2825 / 6144           | 0.795 / 0.848 | 0.788 / 0.836 | 0.886 / 0.973 |
| 4900 | 24.2      | 6764 / 14700          | 0.817 / 0.855 | 0.802 / 0.850 | 0.926 / 0.978 |

Mixed dump, real layout (shapes change along K, so only the knee is comparable): K 1 0.507, 64 (0.23 MB) 0.508, 400 (1.4 MB) 0.547, 800 (2.9 MB) 0.560, 1200 (4.9 MB) 0.646, 1600 (7.3 MB) 0.783.
Cold subsets (`cs.ts`, juggernaut, K = 256): hot 0.746, after the eviction 0.871, after the eviction with every block line read back 0.781, the same plus one brain run first 0.762. Bringing the lines back near the core recovers the cold cost.

## (3) 2 MB pages (cold full run, ratio to the same layout on 4 KB pages)

| Kernel, layout        | Huge MB covered       | Mixed        | Jug          |
|-----------------------|-----------------------|--------------|--------------|
| brain.wat, real       | 42 of 46-48 (32 once) | 1.021, 1.037 | 1.031, 1.017 |
| brain.wat, packed     | 26 of 25 (all)        | 1.030        | 1.026        |
| brain.wat, straddle   | 26 of 36-38           | 1.038        | 1.049        |
| native, real          | 47 of 48              | 1.017        |              |
| native, straddle      | 46 of 64 (blocks 44)  | 1.029        |              |

Native straddle against native real on 4 KB pages: 3.390 against 3.379 ms, equal. brain.wat straddle on 2 MB pages stays 7% behind packed on 2 MB pages (4.19 against 3.92 ms).

## Findings
- Not L1, and barely L2: cycling 64 brains (324 KB, 7x L1) runs at the speed of one brain repeated, and 256-800 brains (1.3-3.9 MB, past L2) cost 4-10% more. The second-pass gain is the footprint past L3: the knee sits at 4-8 MB, where this process's share of the 12 MB L3 ends, and the full 24-25 MB of blocks per tick cost 40-45% over K = 1. Fewer bytes per brain is the only lever there.
- Translation is small: the STLB reach (8 MB) coincides with the knee in the real layout, but the straddle layout (2.2x the pages, same bytes) passes 2048 pages at K = 680 with a step of 5-8% only, its main rise comes at the same bytes as in real, and 2 MB pages buy 2-4% of the kernel (0.08-0.14 ms of about 3.9 ms, 12-21 ns per page, a walk that hits cache). A page-aware packer has nothing to win: no layout reached 3% over real by aligning to pages.
- What a page crossing does cost in brain.wat (straddle: 8-13%) is mostly the hardware streamer restarting at every 4 KB boundary, which the touch stream relies on: it stays with 2 MB pages and vanishes in the native kernel, which prefetches with `prefetcht0`.
- For Erik, 2 MB pages: about 0.1-0.18 ms per tick from the brain phase (4.3-4.5 ms in liveBench, `touchdist.md`), near 1% of the tick, other phases unmeasured. The server would get them only with THP `always` system-wide (root, every process) or a native `madvise`/`MADV_COLLAPSE` call on the WASM memory (native code in the server); collapse failed past 26-42 MB here, so on a busy host the gain is not guaranteed. RSS cost is small, as the arena memory is already touched.

## Verdict suggestion
Close: no packer built (page alignment 0.98-1.05 of real, below plain packing). The second-pass gap is DRAM traffic of 25 MB of weights per tick, not translation and not L1. A brain-only arena (plain packing) is exact and worth 2-5% of the brain phase (0.1-0.2 ms, under the 1.5% tick bar); hugepages are about 1% of the tick and need a host or native change, Erik's call.
