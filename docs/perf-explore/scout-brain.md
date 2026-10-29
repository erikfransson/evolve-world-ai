# Brain kernel scout: what bounds brain.wat, and what is left

Branch `pl-scout-brain` (from perf-live e1c14f2). One engine change kept: the SIMD constants of `brain.wat` in locals (+13 -12 lines plus the regenerated kernels). Everything else is measurement.
Question: is the brain kernel (33% of the tick, about 13.8 MB of cache lines per tick) bound by DRAM bandwidth, DRAM latency, or its instructions, and which untried layout or order change could move it?

## How measured
- `perf stat` is not available (`perf_event_paranoid` 4), so everything is A/B timing on the dumped live memory.
- Harnesses in the session scratchpad `scout/`: `scout.ts` (line trace of the forward, replays, warm-ups, copy-on-write census), `quad.ts` (four-lane prototype, run-order variants, outputs compared bit for bit), `calib.ts` (clock), `genquad.py`, `genquadt.py` (prototype generators).
- One tick's real brain run of the 4 founders x 800 world at tick 600 (3318 brains, 6 shapes), user CPU per call, median of 15-31, cold = 48 MB eviction before each call. Load 18-33 on 8 cores, pinned to CPUs 2,3,6,7; a dependent `f32x4.add` chain gives about 1.15 GHz on these cores, so absolute times are slow and ratios matter.
- "Second pass" is the cost of running each brain again right after itself (run list A A B B ..., minus the single run): the brain's lines are then in L1.

## (a) Bandwidth or latency? Neither: it is L1 fills and instructions

| Run (full live mix, ms)                                       | Time        |
|---------------------------------------------------------------|-------------|
| forward, cold                                                 | 4.59-4.97   |
| second pass of each brain                                     | 3.22-3.54   |
| replay of the forward's line trace only (independent loads)   | 1.87-1.91   |
| sequential stream of the same byte count                      | 0.78-0.80 (17.3-17.8 GB/s) |
| forward after warming inputs and descriptors (1.2 MB)         | +1%         |
| forward after warming those plus every layer-0 line (4.8 MB)  | +1%         |

The memory-only replay runs at 7.2 GB/s, far below the sequential 17 GB/s, and the forward hides most of it already: warming the input vectors, descriptors and all layer-0 rows changes nothing.
Per shape, on subsets that fit L2 (same shape, address order):

| Shape (subset)                 | Cold   | All lines warmed into L2 | Second pass (L1) | Same nz pattern for every brain |
|--------------------------------|--------|--------------------------|------------------|---------------------------------|
| 55-12-12-4 (400)               | 0.331  | 0.327 (-1%)              | 0.238 (-28%)     | 0.315-0.339 (no change)         |
| 55-16-16-4 (300)               | 0.316  | 0.285 (-10%)             | 0.214 (-32%)     |                                 |
| 93-24-24-24-24-18 (100)        | 0.333  | 0.298 (-10%)             | 0.218 (-35%)     |                                 |
| 55-12-12-4, touches removed    | 0.451  | 0.361                    | 0.231            |                                 |

- DRAM costs 1-10% over L2, thanks to the brain3 touch stream (without it the cold run is 36% slower).
- The 28-35% second-pass gain is not branch prediction: giving every brain the same input (same nz pattern, same trip counts) changes nothing, and an A B A B order saves the same as A A B B. Repeating chunks of 4-16 brains keeps the gain, 32-128 loses part of it. So the step is L1 against L2, mechanism unverified (without counters).
- Conclusion: the kernel is not bandwidth-bound and not DRAM-latency-bound. Each brain pays for bringing its lines into L1 once per tick (about 1.3 ms in total) and for its instructions (about 3.2 ms). Only fewer bytes per brain or fewer instructions move it. WASM has no non-blocking prefetch, so the L1 part is what the native kernel's `prefetcht0` buys.

## (b) Rows skipped by the nz list, and a hit-frequency layout

| Lines per tick (MB)                                             | All    | Layer 0 | Later layers |
|-----------------------------------------------------------------|--------|---------|--------------|
| weights in the blocks                                           | 25.1   | 15.0    | 10.1         |
| read by the forward (current layout)                            | 13.8   | 3.6     | 10.2         |
| layer-0 rows sorted by this tick's hit frequency (in sample)    | 13.9   | 3.7     | 10.2         |
| same, frequencies from 100 ticks earlier                        | 13.9   | 3.7     | 10.2         |

The nz list already skips 11.4 of the 15 MB of layer 0 (17.7% of inputs non-zero). Sorting rows by hit frequency (add order unchanged, only the row addresses permuted) needs 2% more lines: a ray that hits sets its closeness and kind lanes, which sit in adjacent rows today. Rejected.

## (c) Copy-on-write rows: the bench is not the live world

Rows of the bank layout (`[in][pad4(out)]` plus the bias row) hashed across all brains:

| World                                      | Brains | Duplicate rows | Duplicate 16 B vectors | Read bytes that are duplicates |
|--------------------------------------------|--------|----------------|------------------------|--------------------------------|
| bench, 4 x 800 copies, tick 600            | 3318   | 95.6%          | 98.5%                  | 12.6 of 13.2 MB (95%)          |
| bench, tick 3000                           | 3293   | 92.5%          | 97.5%                  | 12.1 of 13.1 MB                |
| aged save, tick 54000 (`aged.md`)          | 1357   | 36.6%          | 70.1%                  | 1.2 of 4.0 MB (29%)            |

The bench seeds near-clones, so any content-sharing idea would look large there and small in the live world; it must be judged on an aged save. In the aged world 29% of the read bytes are shared (siblings and parent-child pairs); with L1 fills at about 1.3 ms per tick, sharing could save at most about 0.3 ms if sharers ran back to back, before paying a row indirection in every loop. Rejected.

## (d) Layer-major order (layer 1 of all brains, then layer 2)

Replay of the same lines in layer-major order: 2.12 ms against 1.91 ms brain-major (+11% memory time), and no brain's lines are reused within L1 between passes. Rejected on the replay, not built.

## (e) Other findings
- V8 rebuilds every non-zero `v128.const` at each use inside a loop (`movq r10, imm; vmovq; vpunpcklqdq`, seen with `--print-wasm-code`). The tanh loop had 10 such uses, 27 of its about 52 instructions per vector. Constants in locals set before the loop (committed): outputs bit-identical, kernel 0.919-0.925x cold mixed, 0.930-0.944x at the cap, see the tick table below.
- tanh is about 0.9 ms of the cold kernel before that change (a no-tanh ablation runs 3.80-3.97 against 4.64-4.91 ms), 43k vectors per tick.
- Run order by shape: no change (4.61-4.71 against 4.59-4.73). By shape then nz count: 0.3 ms slower (the address stream breaks).
- `sense.wat` has two non-zero constants inside a ray loop (line 564, `i32x4 -1 1 2 3` and `f32x4.splat (f32.const 1)`) and one at line 116; the same fix applies there (small, untested).

## Possible rewrite: four brains per SIMD vector (quad lanes)

Four same-shape brains share each v128: lane c holds brain c, weights stored `[in][out][4]`. For layers after the first every lane does bias, then mul and add per input in order, exactly as `$layer` does per column, so the bits are the same. There is no splat, no index load, no pad4 waste, and a 4-wide output layer gets 4 independent accumulators instead of one 4-cycle add chain.
Prototype (`genquad.py`): layer 0 per brain through `$layer`, a 4x4 transpose, then quad layers; quad blocks built by the harness from the live blocks (833 quads, lane fill 99.6%). 0 of 24863 outputs differ from brain.wat.

| Variant (live mix)                       | Cold ms     | Second pass ms |
|------------------------------------------|-------------|----------------|
| brain.wat                                | 4.59-4.99   | 3.22-3.54      |
| quad, blocks of 12 / 8 / 6 outputs       | 4.99-5.31   | 2.73-3.13      |
| quad 6, touching the next quad's block   | 4.93        | 3.30           |
| quad 6, juggernaut x 4900                | 5.06 (base 4.74) | 2.96 (base 3.43) |

The quad layers cut 0.4-0.6 ms of instructions, but the cold run loses them again: the quad blocks are a second stream without the brain3 touches, and touching costs the same instructions back. A full rewrite would also run layer 0 in quads (union of the four nz lists, a product forced to -0 for zero lanes keeps `acc + 0*w` exact, since adding -0 is the identity) and keep one ascending stream per quad. It also needs a bank that groups same-shape brains into quads, handles partial quads and thinkEvery subsets, and moves brains between quads on birth and death.
Expected: 0.5-1.0 ms per tick at 3300 if the stream is kept, uncertain; large code (bank plus about 400 generated wat lines).

## Ranking (ms per tick at 3300)

| Rank | Idea                                            | Exact | Evidence                                   | Expected gain     |
|------|-------------------------------------------------|-------|--------------------------------------------|-------------------|
| 1    | SIMD constants in locals (done on this branch)  | yes   | kernel 0.92-0.94x, tick 1.024-1.057x       | 0.36-0.39 ms (measured) |
| 2    | Quad lanes, full rewrite incl. layer 0          | yes   | layers 1+ prototype: -0.5 ms hot, cold even | 0.5-1.0 ms, risky |
| 3    | Native kernel (`nativeprod.md`), already built  | yes   | kernel 1.55x; this scout shows why: L1 fills plus 4-wide plus constants | about 1.9 ms, Erik's decision |

Rejected here: (b) frequency layout, (c) copy-on-write rows, (d) layer-major order, shape order, nz-count order.

## Whole tick (cpuMsPerTick, `--profile`, perf-live worktree as base, alternating pairs)

| Case              | Metric        | Base (3 runs)          | Constants in locals (3 runs) | Ratio of medians | Fingerprint    | Peak RSS MB          |
|-------------------|---------------|------------------------|------------------------------|------------------|----------------|----------------------|
| 4 founders x 800  | cpuMsPerTick  | 12.91, 13.17, 12.85    | 12.22, 12.61, 11.73          | 1.057x           | 708687555 both | 217-220 / 215-218    |
|                   | brain forward | 4.75, 4.92, 4.73       | 4.35, 4.48, 4.20             | 1.091x (-0.39 ms)|                |                      |
| Juggernaut x 4900 | cpuMsPerTick  | 15.09, 15.44, 15.45    | 15.18, 15.01, 15.08          | 1.024x           | 10334191 both  | 252-255 / 254-258    |
|                   | brain forward | 4.74, 4.88, 4.89       | 4.52, 4.54, 4.52             | 1.080x (-0.36 ms)|                |                      |

Brain forward is faster in all 6 pairs. The tick ratio of the mixed case is above what the brain phase explains (other phases are noise at load 18-30).

## Tests
`npm run wasm` (exit 0, generated file in sync after the rebase), `npx vitest run wasmKernels thinkEvery ecoPool --testTimeout=180000 --maxWorkers=1`: 3 files, 66 tests, exit 0 (includes the thinkEvery pin). Full suite not run.

## Verdict suggestion
Merge the constants change (exact, 25 lines, brain phase -0.36 to -0.39 ms, about 2.5-5% of the tick). Apply the same check to `sense.wat`. Quad lanes only as a planned rewrite if the native kernel stays parked; the layout, order and sharing ideas (b, c, d) are closed.
