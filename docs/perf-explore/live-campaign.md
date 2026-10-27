# Live World speed campaign (2026-10-27)

Goal: the live server's tick (The Inland Sea, one thread, nice 19, cap 5000) runs faster without peak memory running away.
Branch `perf-live` from `development` (c384eb5). Every idea is logged below with its measured effect and verdict; kept ideas are merged into `perf-live`.

Benchmark: `node src/liveBench.ts` in `server/` (new, this campaign): the server's `LiveWorld` with `liveConfig`, seeded with the live founders, stepped headless on one thread.
Number to compare: `cpuMsPerTick` (user CPU per steady tick, after the first quarter), run as `nice -n 19 ionice -c3 chrt --idle 0`, several alternating pairs because the laptop is loaded (load 10-12).
Fingerprint equal means bit-identical results.

## Decisions for Erik

- **Exact wins are merged** (1.17x after batch 3, bit-identical, memory flat); the branch is ready for review and merge into `development` any time.
- **`eco.thinkEvery` 2 (1.5x more) is in the code but off in `liveConfig`.** It changes the ecology (births and deaths 1.5-1.9x, creatures turn more and eat less, from the brain's delayed self-feedback), see `think2.md`, `think3.md`, `sense2.md`. Say yes to turn it on, or no to leave it as a page option.
- **Native AVX2 brain kernel** (`native.md`, branch `pl-native`): 1.15x more, bit-identical, server only, but a C++ twin of brain.wat, a g++ build at deploy and new attack surface under the Live push gate. Say yes to productionize it.
- **Relaxed-SIMD FMA** (`fma.md`, branch `pl-fma`): 1.025x, not bit-exact across machines. Not recommended.

## Progress (development vs perf-live)

| Date       | Case                                   | development ms/tick | perf-live ms/tick | Factor | Peak RSS dev / perf-live |
|------------|----------------------------------------|---------------------|-------------------|--------|--------------------------|
| 2026-10-27 09:00 | 4 founders x 800 copies, 60 s (3300)   | 15.24               | 15.24             | 1.00x  | 214 / 214 MB             |
| 2026-10-27 09:00 | Juggernaut x 4900 (cap), 60 s          | 18.50               | 18.50             | 1.00x  | 253 / 253 MB             |
| 2026-10-27 10:46 | 4 founders x 800 (3 pairs, medians)    | 16.03               | 15.51             | 1.03x (exact); 1.5x more with `eco.thinkEvery` 2, Erik's call | 249 / 248 MB |
| 2026-10-27 10:46 | Juggernaut x 4900 (3 pairs, medians)   | 19.66               | 19.41             | 1.01x (exact) | 257 / 254 MB |
| 2026-10-27 11:37 | 4 founders x 800 (3 pairs, medians)    | 16.22               | 14.79             | 1.10x (exact); 1.5x more with `eco.thinkEvery` 2, Erik's call | 216 / 218 MB |
| 2026-10-27 11:37 | Juggernaut x 4900 (3 pairs, medians)   | 19.90               | 18.19             | 1.09x (exact) | 252 / 256 MB |
| 2026-10-27 12:50 | 4 founders x 800 (3 pairs, medians)    | 15.28               | 13.03             | 1.17x (exact); 1.5x more with `eco.thinkEvery` 2, Erik's call | 217 / 218 MB |
| 2026-10-27 12:50 | Juggernaut x 4900 (3 pairs, medians)   | 18.58               | 15.85             | 1.17x (exact) | 256 / 256 MB |

Baseline phases (ms per tick, 3300 mixed / 4900 Juggernaut): senser 5.74 / 7.54, brain forward 5.23 / 5.17, slots (prepareRows) 1.04 / 1.52, memory and steer 1.26 / 1.59, eat 1.05 / 1.35, crowd grid 0.51 / 0.67, collisions 0.18 / 0.27, rest under 0.2. Server frame encoding adds 0.57 ms per tick at 5 Hz. Speed achieved unpaced on this loaded machine: 2.0x and 1.7x real time (the set speed is 3x).

## Ideas

| # | Idea | Kind | Effect | Exact | Verdict |
|---|------|------|--------|-------|---------|
| 1 | Think every other tick (`eco.thinkEvery` 2, staggered halves) | broad | 1.51x (3300 mixed), 1.47x (4900 cap); no memory cost | no at 2 (yes at 1) | Merged with thinkEvery 1 everywhere: at 2 the 600 s runs show churn 1.5-1.9x higher and the population trend reversed, so switching the live world to 2 is Erik's call (`think2.md`) |
| 2 | FMA via relaxed SIMD in brain and sense kernels, fallback kernels | small | 1.024-1.026x (brain forward -7%, senser unchanged), 90 lines plus a second kernel build | no (rounding, machine-dependent) | Rejected for now: too little for giving up cross-machine bit-equality; parked on `pl-fma` (`fma.md`) |
| 3 | bf16 brain weights (half the weight bandwidth) | small | brain kernel 1.00x or worse (weights are 28% of kernel time, the widening costs 0.5 ms) | no (rounding) | Rejected (`bf16.md`) |
| 4 | Sense kernel profile at the live setting (measurement) | study | kernel flat: per-ray passes 38%, item walk and tests 38%, crowd 14%, rock 10%; two exact cuts worth about 4% of the tick | - | Done (`senselive.md`), cuts queued as idea 8 |
| 5 | Native N-API brain kernel with AVX2 (server only) | moonshot | brain forward 1.8x bit-identical (prefetch, 8-wide), whole tick 1.15-1.17x; FMA adds 2% | yes (exact variant) | Parked on branch `pl-native` (`native.md`): needs Erik's call on a C++ twin of brain.wat, a build step at deploy and the Live push gate (no bounds checks yet) |
| 6 | Helper threads for the server at idle priority on this laptop (`liveBench --threads`) | ops | wall ms per tick, 2 rounds: 0 helpers 17.2 / 15.3, 1: 16.7 / 22.4, 2: 13.3 / 24.2, 3: 26.9 / 26.5; CPU 1.4-1.7x, RSS +120-260 MB, fingerprints equal | yes | Rejected: no reliable wall gain under SCHED_IDLE on a loaded host; keep LIVE_THREADS 0 |
| 8 | Sense: pooled ray-offset tables, rock lower-bound table (70 KB), v128 feature store | small | senser 5.2 to 4.5 ms, tick 1.05x in both cases; wall-loop skip rejected (0.8%) | yes | Merged (`sensecuts.md`) |
| 9 | brain.wat: up to 6-vector column blocks (24-wide layers in one pass), tanh inlined per layer | small | brain kernel 1.10x (Oracle 1.17x, Juggernaut 1.05x), about 3% of the tick | yes | Merged (`brainblock.md`) |
| 11 | Server frame encoding (byte writes, age without a Map lookup, leaderboard key) | small | frame work 0.64 to 0.50 ms per tick, 0.14 ms (under 1% of the tick); 81 lines in the gated server path | yes | Rejected (`frames.md`); the bench charged stats at 5 Hz instead of 1 Hz, fixed |
| 10 | Eat phase: crowd `cellStart` fill four cells per v128 store (both rebuilds per tick) | small | crowd grid 0.55 to 0.42 ms, eat 1.14 to 1.00 ms, about 1.7% of the tick; the eat loop itself is 0.07 ms (33 eaters a tick) | yes | Merged (`eatlive.md`) |
| 12 | Node and V8 flags for the server process (semi-space, liftoff, wasm tiering, gc) | small | none beats baseline by over 3%; GC is about 2% | yes | Rejected (`flagslive.md`) |
| 15 | Step kernel: clear-of-rock raster one bit per square (8x smaller lookup) | small | memory and steer phase -8% in every pair, about 0.7% of the tick; sin and cos host calls are 36% of the phase, not removable exactly across engines | yes | Merged (17 lines, less memory) (`stepk.md`) |
| 14 | Sense early-out: creatures with no candidate of any kind get their zero ray features by one fill, per-ray passes skipped | small | senser -0.17 ms (1.3%), tick pairs 2.0-2.5%; applies to 15-32% of creatures here, more in the sparse live world | yes | Merged (`senseempty.md`) |
| 16 | AOT-compile the existing .wat kernels with wasm2c into a server addon (no twin) | moonshot | bit-identical but 0.66-0.86x with bounds checks, 0.92-1.01x unchecked: TurboFan already emits the same inner loop; the native 1.8x needs a different (8-wide, prefetching) kernel | yes | Rejected (`aot.md`) |
| 13 | thinkEvery 2 but every tick while another creature is in sensing range | broad | 1.36x; dynamics still outside the thinkEvery 1 spread (births +20-60%); with collisions off the churn still doubles, so the cause is the delayed feedback of the brain's own speed and turn inputs (turning +26%, eating -11%), not encounters | no | Rejected (`think3.md`) |
| 17 | brain.wat: stream-touch the next brain's weight block during the 1-4 vector column loops (software prefetch that rides the hardware streamer) | small | brain kernel 1.10x live mix, 1.19x Juggernaut; tick 1.04-1.05x; about half the kernel time is memory stall (24 MB of weights never fit L3) | yes | Merged (`brain3.md`); tuned on this CPU, worst case elsewhere a few extra loads |
| 18 | Sense every other tick, think every tick with fresh body inputs (`eco.senseEvery`) | broad | 1.12x; births and food at 600 s outside the senseEvery 1 spread (closer than thinkEvery 2) | no at 2 (yes at 1) | Rejected, parked on `pl-sense2` (`sense2.md`) |
| 20 | Item and crowd grid cell size (100 today, plans see 170) 1.25-3x | small | at best 1-2% of the tick; item cell factors change the fingerprint (tie-break of multi-touch eats, 0.3% of touching creature-ticks) | no (tie-breaks) | Rejected (`cell.md`) |
| 7 | prepareRows (slots phase, 7%) into the fill kernel | small | no exact variant over 1%: ground lookup is at most 0.6 ms, exp 0.33, rest 0.45 | yes | Rejected (`prep.md`) |

## Log
- 2026-10-27 09:00 Campaign start. Prior campaigns (B1, B2, `docs/perf-explore/`) already moved sense, brains, physics, crowd grid, collisions and scans into WASM; their rejected ideas are not retried unless the live setting changes the picture.
- 2026-10-27 09:19 `server/src/liveBench.ts` written; two runs at 400 seeded give the same fingerprint (260290661), so the bench is deterministic.
- 2026-10-27 09:24 Idea 3 rejected: the brain kernel is about 72% compute or latency, only 28% weight traffic (cache-resident control 3.9 vs 5.3 ms); bf16 widening eats the saving. Write-up `bf16.md`.
- 2026-10-27 09:26 Idea 7 rejected: the slots phase splits into ground lookup (at most 0.6 ms), Math.exp (0.33) and field traffic (0.45); nothing exact to cut. Write-up `prep.md`.
- 2026-10-27 09:40 Idea 4 done: sense kernel cost is loop entry, branch misses and cold misses per grid row, not candidate counts (2.2 items, 0.2 rock, 0.1 crowd kept per creature). Exact cuts queued as idea 8. Write-up `senselive.md`.
- 2026-10-27 09:55 Idea 5 (moonshot) measured: a native AVX2 brain kernel on the bank memory is bit-identical and 1.8x on the kernel, 1.15-1.17x per tick. Parked for Erik: it means a C++ twin of brain.wat, a g++ build at deploy, and attack surface (uploaded plans size the brains). Finding: the kernel cost is instructions and latency, not bandwidth, so brain.wat itself has headroom (idea 9).
- 2026-10-27 10:14 Idea 2 measured 1.025x; parked, not merged: relaxed_madd fuses only on CPUs with FMA, so saves would replay differently across hosts, and the gain is 0.4 ms. Erik can overrule.
- 2026-10-27 10:25 Ideas 1 and 9 merged into perf-live (c5b159a, 414b13e). thinkEvery stays 1 in liveConfig: the 1.5x is available by one config line once Erik accepts the dynamics change. Factor run batch1 (3 alternating pairs, both cases) and the full test suite started.
- 2026-10-27 10:45 Idea 12 rejected: no Node flag helps (baseline spread alone 6%). GC about 2%.
- 2026-10-27 10:46 Factor after batch 1: 1.03x mixed, 1.01x at the cap, bit-identical. The exact wins are small, as the earlier campaigns found; the big lever (think every other tick, 1.5x) waits for Erik's decision on the dynamics change.
- 2026-10-27 10:49 Full suite on perf-live: 1215 of 1216 pass; the Inland Sea case of residentBodies.test.ts hits its 20 s timeout under load on perf-base too (both pass in 45 s with --testTimeout=180000), so not a regression.
- 2026-10-27 10:50 Idea 11 rejected: under 1% for 81 lines in server code under the push gate. liveBench now calls stats once a second as the server does.
- 2026-10-27 10:50 Idea 10 merged (14 lines of crowd.wat). The second crowd rebuild cannot be skipped exactly (creatures cross cells every tick, in-cell order matters for collisions).
- 2026-10-27 11:08 Idea 8 merged (+138/-34, exact, about 5%).
- 2026-10-27 11:34 Idea 15 merged (small but consistent, smaller raster). Note from the agent: identical code ran 0.8 ms slower in one worktree than another, so pairs must run from one checkout (base = HEAD, yours = patch).
- 2026-10-27 11:37 Factor after batch 2 (brainblock, eat, sensecuts; stepk merged after the run): 1.10x mixed, 1.09x at the cap, bit-identical, memory flat. liveBench got `--threads` for the helper-thread check (idea 6).
- 2026-10-27 11:40 Idea 14 merged (+87/-16 in sense.wat, exact, equality test with poisoned inputs).
- 2026-10-27 11:53 Idea 16 (moonshot 2) rejected: V8's code for the kernels is as good as gcc's from the same wat; only a hand-written wider kernel gains (idea 5, parked).
- 2026-10-27 11:53 Idea 6 measured: helpers do not pay on this host (load 12-20); the server stays single-threaded.
- 2026-10-27 12:12 Idea 13 rejected: the thinkEvery 2 churn comes from the brain's delayed self-feedback, not from encounters. Next variant (idea 18): sense every other tick but think every tick with fresh body inputs, so only the ray inputs are one tick stale.
- 2026-10-27 12:22 Independent review (Opus) of development...perf-live: no correctness bug; three low items, two fixed (thinkEvery bounded in pasted configs, helper packet tick stored mod 840 so the i32 header never wraps), one noted (per-tick subarray views in collect, only with thinkEvery above 1 and helpers; inactive on the server).
- 2026-10-27 12:31 Idea 17 merged (28 lines of brain.wat). Finding: per brain 1047 ns in the live mix vs 500 ns from L1, so the brain kernel is about half memory stall; bursts and list-driven touches lose, only a sequential stream of touches wins.
- 2026-10-27 13:05 Factor after batch 3 (stepk, senseempty, brain3 added): 1.17x in both cases, bit-identical. Idea 18 rejected: stale rays alone change the dynamics; every variant of thinking or sensing less often does.
- 2026-10-27 13:50 Idea 20 rejected: wider cells cut loop entries but scan more items, net 1-2%, and not exact.
