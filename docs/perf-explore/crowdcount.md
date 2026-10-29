# Crowd walk skip for a creature alone in its window (idea 31)

Exact but slower. Rejected. Branch `pl-crowdcount`, base `perf-live` dd1de4f.

## What

`sense.wat`: before the crowd walk (main path and the idea 14 early-out), sum `cStart[end] - cStart[start]` over the window rows. A total of 0, or 1 where `own[k] == self`, means no candidate, so the walk is skipped (`cy` set past `cy1`, leaving `ce == cand`, the state of a walk with zero candidates; the walk writes nothing else, the detail creature included).

## Counter (snapshot harness of `senselive.md`)

Creatures reaching the main-path walk that are skipped: tick 400 1704 of 2834 (60%), 51% of the 3331 creatures; tick 1500 1374 of 2255 (61%), 42% of 3294. The early-out was entered by 572 / 1210 creatures.

## Kernel

Brain inputs of all creatures after NaN poisoning hash equal to the base kernel (d372010c at tick 400, 62738f98 at 1500). Cold, alternating, 300 reps, `--no-liftoff`, load 6-12 (p25 ms):

| Snapshot  | base  | main path + early-out | main path only |
|-----------|------:|----------------------:|---------------:|
| tick 400  | 5.143 | 5.308 (+3.2%)         | 4.950 vs 4.830 (+2.5%) |
| tick 1500 | 4.187 | 4.295 (+2.6%)         | 4.245 vs 4.169 (+1.8%) |

## Why

The walk per row is two prefix loads plus a short loop of about one candidate (windows hold few creatures), so the count repeats the row overhead and saves only the one or two candidate bodies of the lone creature. Net loss.

## Whole tick (liveBench `--profile`, 4 founders x 800, nice 19, 3 alternating pairs)

| | cpuMsPerTick | senser ms | peak RSS MB | fingerprint |
|-|--------------|-----------|-------------|-------------|
| base  | 13.392, 13.132, 13.280 (med 13.280) | 4.941, 4.833, 4.841 | 215, 219, 219 | 708687555 |
| yours | 13.357, 13.389, 13.361 (med 13.361) | 5.007, 4.946, 4.956 | 219, 218, 219 | 708687555 |

Ratio of medians 1.006 (slower); senser +2%. The juggernaut case was not run (kernel already negative). No test added.

## Verdict

Reject. A count pass cannot beat a walk whose cost is the per-row overhead. Only a precomputed per-cell occupancy (for example a per-row bitmask or a "crowded cell" flag set by the crowd grid build) could skip rows without touching them.
