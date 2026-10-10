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

Rejected on 2026-10-10: shared layout per generation (layout under 1% of runtime), castRay field hoisting, other grid cell sizes, one grid gather per tick for all rays (0.97x).

## Replay in the browser

Main-thread replay at 32x real time, frames per second in headless Chrome.

| Population | Before | After replaying best plus top 300 with a 6 ms step budget |
|------------|--------|------------------------------------------------------------|
| 1000       | 7-9    | 60                                                         |
| 2000       | 9      | 55-60                                                      |

Trade-off: at 32x with all creatures shown the replay runs slower than asked, and the legend says "Top 300 of the rest".

## Fast tanh behaviour check

Late mean survival (generations 25-29, population 150), Math.tanh vs fast tanh, seeds 3-6: 46.0 vs 46.5 s, per seed [48, 39, 35, 63] vs [47, 34, 44, 60].

## Ideas not yet tried
- Workers record trajectories of the replayed creatures so the browser plays them back instead of re-simulating.
- Profile the merged code for the next hotspot; exact Float64 copy of brain weights.
- Pool scaling from 1 to 8 threads and chunk size tuning.
