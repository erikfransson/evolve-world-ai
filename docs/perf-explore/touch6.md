# Brain touch stream in the 5- and 6-vector loops (idea 57)

Branch `pl-touch6`, docs only (no engine change kept). Base `perf-live` 88c20fd.
Question: `brain3.md` touches the next brain's weights only in the 1- to 4-vector column loops; `pfrows.md` showed the layers wider than 16 outputs (5- and 6-vector loops, the 24-wide Oracles) leave 9.6 of 13.1 MB per tick unprefetched in the mixed case. Does extending the touch to those loops speed the brain kernel?

## Kernel A/B
Harness `scratchpad/touch6/kab.ts` (the brain3 one pointed at this worktree): one tick's real brain run on the live memory at tick 600, user CPU, median of 31, interleaved, cold (48 MB eviction) and hot. Memory hash equal to base in every variant (touches are extra loads only). Ratio to base, higher is faster. Load 18-20 on 8 cores, pinned to CPUs 2,3,6,7.

| Variant (touch in the 5- and 6-vector loops unless noted)      | Live mix cold / hot | Oracles only cold / hot | Oracle, same block (L1) cold / hot |
|----------------------------------------------------------------|---------------------|-------------------------|------------------------------------|
| two lines, +128 per iteration (the brain3 touch)               | 0.975 / 0.973 (0.990 / 1.004 in a first run) | 0.975-0.981 / 0.968-0.978 | 0.897 / 0.891 |
| one line, +64 per iteration                                    | 0.993 / 0.993       | 0.957 / 0.933           |                                    |
| two lines every other iteration (branch on list pointer)       | 0.993 / 0.991       | 0.952 / 0.948           |                                    |
| two lines, 5-vector loop only                                  | 0.961 / 0.972       | 0.900 / 0.919           |                                    |
| two lines, 6-vector loop only                                  | 0.990 / 0.992       | 0.936 / 0.927           |                                    |
| three lines, +192                                              | 0.960 / 0.966       | 0.937 / 0.943           |                                    |
| four lines, +256                                               | 0.923 / 0.925       | 0.894 / 0.888           |                                    |
| from the tanh loop of layers wider than 16: two lines, +128    | 0.949 / 0.961       | 0.931 / 0.950           |                                    |
| same, four lines, +256                                         | 0.974 / 0.969       | 0.974 / 0.997           |                                    |

Base times: live mix 4.8-5.1 ms, Oracles alone (828 brains, about 15 MB of weights) 2.7-2.8 ms (3.3 us each), one Oracle block repeated (L1) 1.76 ms (2.1 us each).

## Why
The Oracle is memory-bound (3.3 us against 2.1 us in L1, so about 1.2 us of stall each), and the touches do cut some of it. The cost: the 6-vector loop already issues 6 loads, 6 multiplies, 6 adds and the index gather per iteration, and two touch loads plus the compare and select add about 11% in-core (0.89x when the block is in L1). That is more than the stall they hide (about 25% of 1.2 us, so about 8% of the Oracle). The 5- and 6-vector loops are throughput-bound, unlike the 1- to 4-vector loops where the touches fit into idle slots. Fewer touches (one line, every other iteration) cost less in-core but then do not keep the streamer ahead of the 18 KB Oracle blocks; more lines cost more than they hide. The tanh loop has only 6 iterations per layer, too few and too late to stream a block.
Juggernaut (55-16-16-4) has no 5- or 6-vector loop, so this change cannot affect that case.

## Verdict suggestion
Reject. Every variant is slower than base on the live mix, so no tick-level pairs were run (the bar is 1.5% of the tick, about 4.5% of the brain phase, and the kernel A/B is negative by 1-8%). No engine change committed. Untried: a prefetch instruction is not available in WASM; a native or non-WASM kernel is the only route to cover the Oracle blocks (`native.md`).
