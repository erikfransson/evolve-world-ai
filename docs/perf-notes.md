# Performance notes

Running log of optimisation experiments for large populations (500 to 2000).
Benchmark: `node src/bench.ts --pop 1000 --gens 2` in `src/typescript` on an 8-core machine, quiet unless noted.
The fingerprint hashes all fitness values, so an unchanged fingerprint means unchanged results.

| Date       | Idea                                                    | Seconds (pop 1000, 2 gens) | Speedup | Results          | Verdict  |
|------------|---------------------------------------------------------|----------------------------|---------|------------------|----------|
| 2026-10-10 | Baseline before optimisation                            | 9.2                        | 1.0x    | reference        |          |
| 2026-10-10 | Sparse first brain layer, per-episode decay factors     | 6.4                        | 1.45x   | bit-identical    | Kept     |
| 2026-10-10 | Ray directions by angle addition                        | about 4% alone             | ~1.04x  | identical on checks | Kept  |
| 2026-10-10 | Fast tanh approximation (max error 1e-4)                | 7.0 alone                  | 1.31x   | changed, learning same over 6 seeds | Kept |
| 2026-10-10 | Parallel evaluation, 7 worker threads                   | 2.7 alone (pop 2000: 4.8 vs 18.6) | 3.4x (3.8x at 2000) | bit-identical | Kept |
| 2026-10-10 | All of the above merged                                 | 1.84 (serial 4.9)          | 5.0x    | new reference    | Kept     |
| 2026-10-10 | Round 2: one item gather per tick for all rays, input-major first layer | serial 3.47 vs 4.69 | 1.35x serial | bit-identical | Kept |
| 2026-10-10 | Round 2: workers record top-300 trajectories for replay | +3-5% eval time            | n/a     | bit-identical    | Kept     |
| 2026-10-10 | Round 2 merged, recording bounded                       | 1.56 (from 9.2)            | 5.9x    | bit-identical to round 1 | Kept |

Rejected in round 2: wall skip when far from walls (2%), Float64 dense weights (0%), input-major dense layer (7% slower).
Rejected on 2026-10-10: shared layout per generation (layout under 1% of runtime), castRay field hoisting, other grid cell sizes, one grid gather per tick for all rays (0.97x).

## Replay in the browser

Main-thread replay at 32x real time, frames per second in headless Chrome.

| Population | Before | After replaying best plus top 300 with a 6 ms step budget |
|------------|--------|------------------------------------------------------------|
| 1000       | 7-9    | 60                                                         |
| 2000       | 9      | 55-60                                                      |

Round 1 trade-off: at 32x with all creatures shown the replay ran at about 31% of the asked speed, and the legend says "Top 300 of the rest".
Round 2 fixed the speed: workers record per-tick x, y, heading and energy for the top 300 during evaluation (4-10 MB per generation, transferred without copying), so the browser plays them back and only re-simulates the best creature. Replay speed is 1.00 of asked at 1000 and 2000.
Review found recording memory unbounded (every creature, whole lifetime). Now only the best plus top 300 are kept and each is capped at 9000 frames (300 s); a capped creature freezes in the replay.
Stress test (pop 2000, regrowth on, lives reaching a 600 s cap): peak RSS 1485 MB before, 777 MB after, 335 MB without recording; frames 43 MB per generation.

## Fast tanh behaviour check

Late mean survival (generations 25-29, population 150), Math.tanh vs fast tanh, seeds 3-6: 46.0 vs 46.5 s, per seed [48, 39, 35, 63] vs [47, 34, 44, 60].

## Pool scaling (round 2)

Seconds per generation by worker threads, quiet pass; the CPU has 4 physical cores and 8 hyperthreads.

| Threads | Pop 1000 | Efficiency | Pop 2000 | Efficiency |
|---------|----------|------------|----------|------------|
| 1       | 2.24     | 1.00       | 4.34     | 1.00       |
| 2       | 1.24     | 0.90       | 2.33     | 0.93       |
| 4       | 0.72     | 0.78       | 1.28     | 0.84       |
| 7       | 0.83     | 0.38       | 1.40     | 0.44       |
| 8       | 0.84     | 0.33       | 1.42     | 0.38       |

Scaling stops at the physical core count. Per-generation overheads are 1-5 ms, load imbalance about 5%, breeding about 45 ms serial. Chunk counts from 4 to 32 per worker made no difference. No change kept: browsers only report logical cores, so the default stays min(cores - 1, 8).

## Ideas not yet tried
- Profile after round 2: forward 32%, castRays 22%, step 13%, item gather 9%.
