# Idea 27: boustrophedon brain order (rejected)

`WasmBrainBank.forwardRun` alternates direction each call (per-bank flag, walks `order` up, then down), so the tail of one tick's weight stream might still sit in the 12 MB L3 at the start of the next. Exact: fingerprints unchanged (708687555 mixed, 10334191 juggernaut, 252380386 at 300 s). 5 lines changed.

`liveBench --profile`, alternating pairs, base = perf-live, yours = pl-boustro. Brain forward ms / cpuMsPerTick.

| case (60 s)  | pair | base fwd | base cpu | yours fwd | yours cpu |
|--------------|------|----------|----------|-----------|-----------|
| mixed        | 1    | 3.73     | 11.33    | 3.39      | 9.95 (load dip, noise) |
| mixed        | 2    | 4.29     | 12.97    | 4.47      | 13.27     |
| mixed        | 3    | 4.28     | 13.03    | 4.46      | 13.11     |
| juggernaut   | 1    | 4.44     | 16.14    | 4.72      | 16.31     |
| juggernaut   | 2    | 4.40     | 15.95    | 4.73      | 16.33     |
| juggernaut   | 3    | 4.40     | 15.99    | 4.70      | 16.19     |
| mixed 300 s  | 1    | 4.18     | 11.87    | 4.53      | 12.57     |

Peak RSS equal (215-218 vs 217-232 mixed, 253-258 juggernaut).

Verdict: no gain, about +0.2 to +0.35 ms worse in brain forward (consistent in juggernaut and 300 s). Pair 1 mixed is load noise (base ran during a loaded phase). Likely causes: reversed block order defeats the ascending hardware stream prefetch across blocks, and the sense/steer phases between ticks already evict the L3 tail. Second variant (reversing touch direction in the kernel) not tried. Do not merge.
