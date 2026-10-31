# Performance notes

Running log of optimisation experiments for large populations (500 to 2000).
Benchmark: `node src/bench.ts --pop 1000 --gens 2` in `src/typescript` on an 8-core machine, quiet unless noted.
The fingerprint hashes all fitness values, so an unchanged fingerprint means unchanged results.
Current fingerprints (since obstacles and terrain, #34, 2026-10-12, which add a brain input, so a genome has more genes and every mutation draws more numbers; the map-off values changed on purpose):
`--pop 300 --gens 12 --seed 2` 393406425 with the Trials hall of fame and the brain on WebAssembly (459613821 with the hall of fame alone, 553379790 with the WebAssembly brain alone, 727564408 before both, 2026-10-31; serial and 7 threads agree); `ecoBench --seconds 30 --pop 600` 739359978 (also with 3 helpers), `--set eco.wasm=false` 877945501, `--predators --seconds 40` 410981010 (before: 847633506, 204227508, 303607739). `--pop 1000 --gens 2` not re-measured. Rollback is one-way: a version 2 save (written after this change) cannot be read by an older build.

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

Merged on 2026-10-11 (rounds 2 and 3 of `docs/perf-explore/`): crowd rebuild by radix sort (1.3-1.7x at 30k to 50k), brain kernel (1.33x kernel), lazy JS-only scratch buffers (RSS 508 to 322 MB at 50k), helper genomes sent only to the owning helper with an adaptive first-tick timeout (start-up RSS 1.37 to 1.0 GB), packed item cells (kernel 1.2x), and the render worker (page busy 111% to about 10%).
All except the render worker are bit-identical.
Details per idea in `docs/perf-explore/`.

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
Random founders do not reach their birth energy, so all runs decline; the default goes extinct after about 75 s without a birth.

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
Ecosystem uses them with `eco.wasm` (default true since E5c, below), and Trials runs its brain on `brain.wat` (next section).

## Trials brain on WebAssembly (2026-10-31)

`Episode` runs the brain of its one creature on `WasmBrainBank` (slot 0, one bank per thread reused by `runEpisode`), with rays, encoding and motion still in JS (`TRIALS_WASM` in `sim/episode.ts`). Without WebAssembly SIMD, or for a layer over 1024 neurons, the JS brain runs.
The whole Ecosystem kernel set (sense, fill, step, brain) was tried first and was slower (7.2 against 5.5 us per tick at the defaults): its per-call setup is made for thousands of creatures, and Trials calls it for one.
Results change slightly (f32 sums): `bench --pop 300 --gens 12 --seed 2` 727564408 before (836727452 in older notes, before the terrain input), 553379790 after. The JS path is unchanged (same fingerprint as before with WebAssembly disabled).
Evaluation per creature-tick, median of the 3 seeds, 150 creatures, 50 generations (20 for the big brain), serial, load about 13:

| Brain          | JS ns/tick (3 seeds) | WASM ns/tick (3 seeds) | Speedup |
|----------------|----------------------|------------------------|---------|
| default [6]    | 4723 (4599-4730)     | 3630 (3628-3995)       | 1.30x   |
| hidden [32,32] | 13672 (13611-14289)  | 4883 (4834-5289)       | 2.8x    |

On 300 random genomes (`trialsTickBench`, 3 runs) the default gains 1.05x (6066 to 5755 ns, spread 5217-5771) and [32,32] 1.9x (15015 to 7952 ns, spread 6797-9390): random creatures see little, so the JS sparse first layer has little to do.
Fitness over 50 generations (seeds 1-3, mean of the last 10): best 346/385/319 JS against 395/412/340 WASM, population mean 89/104/91 against 107/128/84, so learning is not worse.

## Ecosystem helper threads (E5a)

`node src/ecoBench.ts --seconds 10 --pop N --threads H [--shared]` (`--shared` since removed, see the shared-memory decision below), steady ms per tick (last three quarters), world 12000 x 7500, 2026-10-11.
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

`node src/ecoBench.ts --seconds 10 --pop N [--threads 4] --set eco.wasm=true|false`, steady ms per tick, world 12000 x 7500, 2026-10-11, JS and WASM run in alternating pairs.
Item and wall rays, encoding and the shared phase stay in JS; crowd rays and brains run in WASM, each thread with its own kernels.
Several runs per cell, machine load 5-12 from other jobs. The shared columns and runs are from the since removed shared-memory mode.

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

`sense.wat` does ray directions, item and wall rays (f64, same candidate order as `World.castRays`), crowd rays (f32) and the ray features written into the brain input, for a whole batch in one call. The item grid is patched in WASM memory per tick (`patchItems`) and the crowd is read in place. The old `rays.wat` is gone. Only `Ecosystem.detail` (the selected creature) gets its `creature.rays` and brain input read back.
Width 20000 (about 2700 creatures), user CPU ms per steady tick, main e17cba7 vs branch in alternating pairs: serial 28.4, 29.3, 28.2 vs 20.5, 20.7, 21.8 (1.37x); 3 shared helpers, total CPU 40.4, 40.0 vs 32.2, 32.8 (1.24x). Fingerprints equal to main for serial, 3 shared, 3 message and 1 shared helpers.
Details and rejected f64x2 variant in `docs/perf-explore/wasm.md`.

## Live World speed campaign (2026-10-27)

The server tick of the Inland Sea (one thread, cap 5000) went about 1.65x faster on the mixed case and 1.72x at the cap, bit-identical, with `server/src/liveBench.ts` as the benchmark. Ideas, numbers and verdicts are in `docs/perf-explore/live-campaign.md`; the older sections here predate it.

## RL episodes (single thread)

`nice -n 17 node src/rlBench.ts [--reps 3] [--env id]` in `src/typescript`: ms of CPU time per episode for pool:39 and a random learner over 6 seeds; the fingerprint hashes every result of every env in `ENVS`, so it must not change when an optimisation lands. It was 799232213 since 0.2.4 (time-pressure envs and fixed held-out seeds); with the Ambush, Turf war and Cull envs added it prints 1819613860, and the value without those three is still 799232213 (checked 2026-10-28), so the existing envs are unchanged; with Patch war and Live now added it prints 976191245 (2026-10-28); with Two stops (Memory) added it prints 238187872 (2026-10-28, `--reps 1`), and the value without it is still 976191245; with Corral and Lap added it prints 1301207144 (2026-10-28, `--reps 1`), and the value without them is still 238187872.
Profile: brain forward/first layer about 30%, sensing and input encoding 15-20%; episode setup 5-10% (random rival genomes dominate in hunt envs); crowd grid, collisions and prepare about 20% for single-creature envs.
Kept (bit-identical): no collision pass and no grid rebuild for a lone creature, one cached layout config for random learners. Single-creature envs 1.3-2.5x faster (forage-sparse pool 9.7 to 3.8 ms, endurance random 8.7 to 3.3), multi-creature envs unchanged within noise.
Not done: wasm kernels (f32, changes results, brain-bound at 1-9 creatures anyway).

## Shared-memory helper mode removed (WP3, WP4)

Decision: helper threads use message passing (fork-join) only. The shared-memory transport, the `?shared` flag, `ecoBench --shared` and the coi-serviceworker are gone.
Browser comparison on current main (headless Chrome, preview, 1440x900, 4 helpers, WebAssembly, Max speed, median of the last 60 s after 30 s warm-up, x real time, 3 alternating pairs, machine load 12-40 from other jobs):

| Case                  | Messages      | Shared memory |
|-----------------------|---------------|---------------|
| Ecosystem default     | 2.5, 3.3, 2.8 | 3.1, 2.9, 2.5 |
| Ecosystem width 20000 | 2.7, 3.6, 3.9 | 2.8, 3.1, 3.5 |
| Predators & prey      | 1.8, 4.0, 4.1 | 3.2, 3.4, 4.4 |

Means 2.9 vs 2.8, 3.4 vs 3.1, 3.3 vs 3.7. No case is clearly better by 10%, and run-to-run spread (load 12 vs 40) is larger than the difference, so the extra barrier code, second resize path and installed service worker are not paid back.
Fingerprints were unchanged then (before the later terrain input): `ecoBench --seconds 30 --pop 600` 417250420 and `--predators --seconds 40` 657843665 for 0 and 3 helpers, Trials `bench --pop 300 --gens 12 --seed 2` 836727452.
The `unref` on node helper workers was only needed for shared-mode waits; without it a closed pool still lets the process exit, so it was dropped.

## Live World on the Inland Sea (A2, A5, A7)

Moved from `docs/status.md`.
Map engine (A2): Live session numbers (nice 19, no helpers, 2000 founders, cap 2500, A5 values, 900 simulated seconds, two runs in parallel): map 15.8 CPU ms per tick vs 18.9 for a Highlands-style world of the same size, at mean population about 2200; earlier 2400 s runs at mean 1480: 7.3 vs 6.0 for a plain world. Item slots are exactly density x 100000 (local caps are normalised and weighted by open area): food 1.5 + poison 0.01 = 151000, food 2 + poison 0.05 = 205000. Poison is scarce (base 0.15, Ashfall 3.5): at 0.01 about 52 shore cells hold 517 of the 1000, 486 of 1000 cells hold any, the open sea 0. Food about 10-12k and poison about 930-1000 items in the run. Raster 0.99 MB, map build about 3 s per thread (each thread builds its own), save 13.6 MB at 1200 creatures, peak RSS about 230 MB.

Launch food values (A5): From a quarter-area run scaled x4: population about 800-2300 over the year, food about 10-12k items, poison at its 1000 cap, 9.8 CPU ms per tick at 1100-2500 creatures (nice 19, no helpers), peak RSS 344 MB, save 13 MB at 1192 creatures.

Server and page (A7), nice 19, host load about 17 on 8 cores, so slower than an idle core:
- Startup: founders check 7 ms, world and map build 3.0-3.5 s, seeding 20 ms; with a 2500-creature save 14 s to listening (parse 7 s, restore 0.8 s), peak RSS 414 MB. Each helper thread builds its own map (3.4 s, about 40 MB).
- 2500 creatures, 150k food: tick 36 ms here (1.4x achieved), save 24 MB JSON (14.5 MB gz) whatever the food, saveState stalled ticks 2.8 s (2.4 s on the old world; since the worker save the stall is 0.04-0.19 s, `docs/perf-explore/savestall.md`), save path 10 s, verify 4.7 s (passes with a 192 MB heap too). An admin load (save, parse, restore) peaks at 944 MB RSS uncapped (old world 824 MB) and at 829 MB inside a MemoryMax=1G, swap 0 scope, where it completes.
- Full item set at 150k food: 663 kB (59 kB of slot kinds), over the 300 kB connect allowance, so it comes from the resync share: a lone viewer has it after 2.1 s, ten joining together after 0.8-7.8 s. At 10-12k food it is about 107 kB and goes out at once. Creature frame at 2500: 47.5 kB.
- Page (headless Chrome, software raster): at 2500 creatures and 50-90k items a frame's JS is 30-40 ms, with 450-550 ms long tasks for raster; at 140k items 54 ms and 700 ms; at 12 creatures and 45k items 4.5 ms and 90 ms. The map worker also traces the rock outlines (`rockGeometry`, checked on the page and handed over with `useRockGeometry`), so the longest main-thread task while the map arrives and is first drawn fell from 17-19 s to 1.1 s on desktop and 1.6 s on phone (the rest is software raster).
- Population: from 40 seeds and 50k start food it reaches the 2500 cap in about 90 simulated seconds and stays there while food lasts, so visitor adds are refused as "world full".
- Cap (Erik, 2026-10-14): 3000, births stop 100 below it (`eco.birthReserve` 100, admin-tunable up to 1000) so visitors can still add. Probe: a seeded world sits at exactly 2900 after about 90 simulated seconds, and a visitor add of 3 then goes in. Cap runs (`scratchpad/cap15k/`): 2500 peaks at 687 MB with a 24 MB save, 5000 at 857 MB and 42 MB; 10000 and 15000 pass the 1 GB limit and their saves are refused (over 50 MB). At 3000 a creature frame is 57 kB, so about 23-38 viewers fit at the full population.
