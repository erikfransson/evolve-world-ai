# Performance notes

Running log of optimisation experiments for large populations (500 to 2000).
Benchmark: `node src/bench.ts --pop 1000 --gens 2` in `src/typescript` on an 8-core machine, quiet unless noted.
The fingerprint hashes all fitness values, so an unchanged fingerprint means unchanged results.
Current fingerprints (since the 2026-10-11 Trials tuning: rays 150 / 125 degrees, start energy 75, hidden 6; before: 95094939 and 833522585): `--pop 1000 --gens 2` 265968394, `--pop 300 --gens 12 --seed 2` 836727452.

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
| 2026-10-10 | Shared-world refactor: per-creature ray cache with per-cell invalidation, Creature unit, mutate() | serial medians 3.02 vs 3.05 (8 pairs); threaded later gens equal, first gen +40-60 ms | ~1.0x | bit-identical | Kept, needed for Ecosystem |

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

## Ecosystem (serial, one thread)

`node src/ecoBench.ts --seconds 20 --every 5 [--pop N --set world.foodDensity=D --set eco.foodRegrow=R]`, world 8000 x 5000, machine load about 5.

| Founders | Food density, regrow | Ticks/s | Creature-ticks/s |
|----------|----------------------|---------|------------------|
| 500      | default 0.5, 0.05    | 556     | 271k             |
| 2000     | 1.5, 0.2             | 92      | 180k             |
| 5000     | 3, 0.5               | 25.5    | 125k             |

Profile at 2000 (4000 x 2500 world): first brain layer 19%, creature rays 17%, item gather 13%, item ray tracing about 12%, eatAt 5%, collisions and crowd rebuild under 4%.
Body plans and memory (2026-10-10, load about 20): 765 -> 640 ticks/s, 169k -> 133k creature-ticks/s at the defaults (memory 4 + 4, costs on); memory 0 with zero costs is unchanged, fingerprint included.
Random founders do not reach birthEnergy, so all runs decline; the default goes extinct after about 75 s without a birth.

## WebAssembly SIMD kernels (E5b)

`node src/wasmBench.ts`, ms per call for the whole batch, median of 20, machine load about 15 (so absolute times are inflated, ratios are indicative). Large plan: 16 rays, hidden 4 x 32, memory 1. Rays run in a crowd at the 2000-creature ecosystem density.

| Kernel | Plan    | Creatures | JS ms  | WASM ms | Speedup | Max abs diff |
|--------|---------|-----------|--------|---------|---------|--------------|
| brain  | default | 1000      | 4.19   | 0.81    | 5.2x    | 1.8e-7       |
| brain  | default | 3000      | 8.57   | 2.68    | 3.2x    | 2.4e-7       |
| brain  | default | 10000     | 30.56  | 9.23    | 3.3x    | 2.4e-7       |
| brain  | large   | 1000      | 21.23  | 5.38    | 3.9x    | 3.0e-7       |
| brain  | large   | 3000      | 67.84  | 18.49   | 3.7x    | 3.0e-7       |
| brain  | large   | 10000     | 317.67 | 77.14   | 4.1x    | 3.6e-7       |
| rays   | default | 1000      | 1.74   | 1.40    | 1.2x    | 2.0e-5       |
| rays   | default | 3000      | 4.53   | 2.58    | 1.8x    | 1.4e-4       |
| rays   | default | 10000     | 19.36  | 10.76   | 1.8x    | 1.0 (a)      |
| rays   | large   | 1000      | 4.70   | 1.97    | 2.4x    | 7.6e-5       |
| rays   | large   | 3000      | 15.47  | 8.55    | 1.8x    | 1.2e-4       |
| rays   | large   | 10000     | 66.86  | 30.09   | 2.2x    | 1.7 (a)      |

The rays rows are historical: they measure the deleted `rays.wat`, and `wasmBench.ts` now benches brains only, so they cannot be reproduced.

(a) Closeness difference plus 1 per ray whose kind differs. A rare grazing ray hits in f64 and misses in f32 (or the reverse), so a few rays out of 10^5 differ in kind. Otherwise closeness agrees to about 1e-4.
Ray time includes queueing the rays and applying results into `RayHit` objects, which is about 40% of the WASM time (10000 large: queue 10.4, run 18.8, apply 1.2 ms), so the speedup grows once callers write straight into the batch buffers.
Trials stays on the JS path. Ecosystem uses them with `eco.wasm` (default true since E5c, below).

## Ecosystem helper threads (E5a)

`node src/ecoBench.ts --seconds 10 --pop N --threads H [--shared]`, steady ms per tick (last three quarters), world 12000 x 7500, 2026-10-11.
The machine has 4 physical cores (8 logical) and a browser tab used 1.3-2 cores throughout, so scaling past 2-3 threads is understated.
Fingerprints are equal for every helper count and mode.

| Creatures | Serial | FJ 1 | FJ 2 | FJ 4 | FJ 6 | Shared 1 | Shared 2 | Shared 4 | Shared 6 |
|-----------|--------|------|------|------|------|----------|----------|----------|----------|
| 1000      | 8.7    | 7.5  | 6.4  | 6.1  | 5.8  | 6.7      | 6.0      | 5.0      | 5.8      |
| 3000      | 27.4   | 23.0 | 20.1 | 15.7 | 16.0 | 21.1     | 18.2     | 14.5     | 15.4     |
| 5000      | 47.6   | 37.9 | 32.7 | 25.8 | 26.0 | 37.4     | 32.6     | 25.8     | 25.2     |

FJ is fork-join by messages. H helpers plus the coordinator make H + 1 sensing threads.
At 5000 the serial rest (memory, motion, shared phase, publish and collect) is about 13 ms, so sensing scales about 2x on 5 threads; the same slices run on one thread take 12 ms per 1000 creatures, on helper threads about 20 ms, which points at core sharing and clock drop rather than overhead.
Fixed on the way: the first packet carries every founder genome, and a delta area kept at that size made fork-join slower than serial (17-50 MB moved per helper per tick); it now shrinks after the founders.
Browser (headless Chrome, preview, about 1000-1100 creatures, default world): one thread 2.5-3.0x real time at both 16x and Max; 6 helpers 3.7-4.5x shared, 4.3-4.9x by messages.

## WebAssembly in Ecosystem sense and think (E5c)

`node src/ecoBench.ts --seconds 10 --pop N [--threads 4 --shared] --set eco.wasm=true|false`, steady ms per tick, world 12000 x 7500, 2026-10-11, JS and WASM run in alternating pairs.
Item and wall rays, encoding and the shared phase stay in JS; crowd rays and brains run in WASM, each thread with its own kernels.
Several runs per cell, machine load 5-12 from other jobs.

| Creatures | Serial JS         | Serial WASM       | 4 shared JS             | 4 shared WASM           |
|-----------|-------------------|-------------------|-------------------------|-------------------------|
| 1000      | 8.1, 12.6, 9.0    | 8.1, 8.1, 7.5     | 5.2, 5.3                | 4.8, 4.8                |
| 3000      | 26.9, 27.1, 27.4  | 23.8, 24.1, 24.9  | 18.8, 14.9, 15.8, 15.6  | 30.5 (a), 13.4, 14.4, 14.4 |
| 5000      | 58.1, 47.0, 48.0  | 40.5, 40.2, 40.7  | 26.5, 25.7, 26.2, 25.9  | 49.4 (a), 23.0, 23.8, 23.3 |

(a) First pass, load swinging around 10; the later passes agree with each other.
WASM is 8-17% faster per tick in every repeated pair. Profile at 3000 serial: the JS sparse first layer (19%) and crowd rays (17%) become about 16% WASM plus 3% queueing; JS item rays, encoding and the shared phase are most of the rest.
Fingerprints are equal for serial, fork-join and shared with any helper count (tests in ecoPool.test.ts).

Population over 600 s, default world and seed pool, 4 shared helpers, samples every 60 s:

| Seed | Path | Births | Deaths | Population at 0, 60, ... 600 s                          |
|------|------|--------|--------|---------------------------------------------------------|
| 1    | JS   | 8656   | 8096   | 1000 342 329 428 653 1234 1663 1510 1570 1586 1560      |
| 1    | WASM | 9066   | 8393   | 1000 347 412 569 841 1487 1607 1631 1674 1694 1673      |
| 2    | JS   | 8369   | 7758   | 1000 336 341 419 643 1061 1661 1629 1649 1640 1611      |
| 2    | WASM | 9008   | 8439   | 1000 325 361 502 795 1264 1580 1506 1561 1565 1569      |
| 3    | JS   | 9043   | 8445   | 1000 336 371 535 807 1443 1545 1528 1529 1542 1598      |
| 3    | WASM | 8706   | 8036   | 1000 329 362 484 748 1206 1721 1573 1623 1632 1670      |

Same shape and plateau (1500-1700); seed-to-seed spread is as large as the JS-WASM difference.
Browser (headless Chrome, preview, default world at Max, median of the last 20 s of 40 s, 3200-3700 creatures): one thread 1.1x JS and 1.1x WASM; 4 helpers in shared memory 1.4, 1.4x JS and 1.5, 1.4x WASM. The tile's 0.1 resolution hides a 10% gain.
Default set to WASM (`eco.wasm` true, "Use WebAssembly" under Life cycle); runtimes without SIMD fall back to JS.

## One-call WebAssembly sense (E5d)

`sense.wat` does ray directions, item and wall rays (f64, same candidate order as `World.castRays`), crowd rays (f32) and the ray features written into the brain input, for a whole batch in one call. The item grid and crowd are copied into WASM memory each tick. The old `rays.wat` is gone. Only `Ecosystem.detail` (the selected creature) gets its `creature.rays` and brain input read back.
Width 20000 (about 2700 creatures), user CPU ms per steady tick, main e17cba7 vs branch in alternating pairs: serial 28.4, 29.3, 28.2 vs 20.5, 20.7, 21.8 (1.37x); 3 shared helpers, total CPU 40.4, 40.0 vs 32.2, 32.8 (1.24x). Fingerprints equal to main for serial, 3 shared, 3 message and 1 shared helpers.
Details and rejected f64x2 variant in `docs/perf-explore/wasm.md`.
