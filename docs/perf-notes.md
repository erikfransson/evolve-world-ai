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
| 2026-10-10 | Round 3: anchored item list reused across ticks (slack 0.3 x ray length), eating from the same list | serial 3.46 vs 2.94, then 2.76 vs 2.63 | 1.16x, 1.05x | bit-identical | Kept |
| 2026-10-10 | Round 3: register-blocked brain layers (4 outputs first layer, 2 outputs dense) | 2.94 vs 2.75 | 1.07x | bit-identical | Kept |
| 2026-10-10 | Round 3: cull items outside the ray fan wedge | 2.65 vs 2.45 | 1.08x | bit-identical | Kept |
| 2026-10-10 | Round 3: brain panel redrawn at most every 25 ms (browser) | main-thread busy 16.1 vs 12.5 ms per frame | -22% | n/a | Kept |
| 2026-10-10 | Round 3 merged (serial, 6 alternating pairs, medians) | 3.39 vs 2.44 | 1.39x | bit-identical | Kept |
| 2026-10-10 | Round 4: breeding runs the mulberry32 stream inline     | breeding 51 vs 37 ms at pop 1000 | about 3% per generation | bit-identical | Kept |
| 2026-10-10 | Round 4: overlap breeding with evaluation of the next generation | pop 2000 5 gens 4.08 vs 3.85 s | 1.01-1.06x | bit-identical | Rejected, 212 lines across 7 files for the gain |
| 2026-10-10 | Round 4: pre-warm pool workers                          | 1.50 vs 1.53 s             | none    | n/a              | Rejected, startup only moves |

Rejected in round 3: typed-array RNG state (breeding 37 to 24 ms, 1% of a generation), wall skip again (0.6%), branchless input compaction (0%), slack 0.15 and 0.6 (0%), branch-free encodeInputs (0%).
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

## Generation breakdown (round 4, 7 threads, steady state)

Pop 1000 / 2000: evaluation 290 / 580 ms, breeding 40 / 82 ms serial, frame merge 10-15 ms overlapped. Generation 0 takes about 0.93 s at pop 1000: about 320 ms worker startup and 190 ms JIT warm-up.
Threads 4 vs 7 at pop 1000: steady generations equal at about 0.29 s; 4 threads start faster (gen 0 0.69 vs 0.96 s).

## Ideas not yet tried
- Profile after round 3 (ns per tick, duplicate-the-call method): forward about 500, castRays about 200, encodeInputs about 100, setTrig about 55, rest about 300. The tanh division is about a third of forward.
- Fuse encodeInputs with the first-layer nonzero scan.
- WebAssembly port of castRays and Brain.forward (needs a toolchain dependency, ask first).
