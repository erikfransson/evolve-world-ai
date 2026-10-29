# Brain touch stream: skip the dead first-layer rows of the next brain (idea 52)

Branch `pl-pfrows`, docs only (no engine change kept). Base `perf-live` 3d33e82.
Question: the touch stream of `brain.wat` (`brain3.md`) walks the next brain's whole weight block, but the first layer only reads the rows of non-zero inputs. If the stream skips the dead rows, does the brain phase get faster?

## Counter (model of the stream on the real run, `scratchpad/pfrows/count.ts`)
Per tick, the stream is replayed from the brains' descriptors and inputs: 2 touches (pf, pf+64) and pf += 128 per input iteration of the 1- to 4-vector loops, as in the wat. A line is "needed" if the next brain's forward reads it (rows of non-zero inputs of layer 0, all biases, all later layers).

| Case (tick 600)      | Weights | Stream touches | of those needed | Forward reads | Needed, not touched | Skip stream touches | of those needed | Needed, not touched |
|----------------------|--------:|---------------:|----------------:|--------------:|--------------------:|--------------------:|----------------:|--------------------:|
| 4 founders x 800     | 24.5 MB | 9.6 MB         | 3.5 MB (37%)    | 13.1 MB       | 9.6 MB              | 3.7 MB              | 3.7 MB (98%)    | 9.4 MB              |
| juggernaut x 4900    | 23.6 MB | 23.3 MB        | 8.8 MB (38%)    | 9.4 MB        | 0.6 MB              | 9.2 MB              | 8.8 MB (96%)    | 0.6 MB              |

About 62% of the touched bytes are dead rows, as suspected (91-96% of the brains have under a quarter of their inputs non-zero). Skipping them touches 2.5x fewer bytes at the cap with the same coverage of needed lines. In the mixed case the 9.5 MB of needed lines the stream never reaches are the 828 Oracles (24-wide layers take the 6-vector loop, which has no touches, and the stream is too short for their blocks), so the skip does not extend the reach there either.

## Kernel A/B (upper bound: gap lists built on the host, not timed)
Variant: every touch loop checks `pf >= gap start` and jumps `pf` to the gap end (dead runs of at least 128 B in layer 0, clamped to `pe`, so every touch stays in bounds); the lists come from a table the harness fills, so the real build cost (a pass over the next brain's non-zero list, estimated 0.1 ms per tick) is not even counted. `scratchpad/pfrows/kab2.ts`, one tick's brain run on the live memory, user CPU, median of 31-41, cold (48 MB eviction) and hot. Output memory hash equal to base in every case. "Control" is the same wat with every gap list empty (the code change without the skipping).

| Case                          | v1 (gs, gp locals) cold / hot | v2 (compare against the load) cold / hot | Control v1 / v2 (cold) |
|-------------------------------|-------------------------------|------------------------------------------|------------------------|
| live mix (tick 600)           | 0.943x / 0.935x               | not run                                  | not run                |
| juggernaut, 4900 brains       | 0.939-0.958x / 0.949x         | 0.929x / 0.932x                          | 0.971-0.982x / 0.952x  |

The skip is slower than base by 4-7% and also slower than its own control by 1-3%; the control alone costs 2-5% (two more live values in the loops).

## Why (unverified)
The hardware streamer wants an unbroken ascending run of lines. Jumping over the dead rows breaks it, so the needed lines behind the jump are no longer fetched ahead and the touches become real misses. This matches `brain3.md`: touching only the used rows, or skipping lines (0.72-1.04x), lost against the plain sequential stream. The dead-row touches are not waste, they keep the stream running into the lines that matter. Fewer bytes do not help because the stream is not bandwidth-bound (9 to 23 MB per 14 ms tick is under 2 GB/s).

## Verdict suggestion
Reject. A free gap list already loses 4-7% of the brain kernel, so the real build (list construction plus tests) cannot reach the 1.5% bar; no tick-level pairs were run for that reason. No engine change committed.
