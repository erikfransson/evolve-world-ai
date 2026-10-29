# Two-lane sin/cos in step, and a u16 crowd `cellStart` (idea 147, "kernelsmalls")

Branch `pl-kernelsmalls` from `perf-live` 7493645. Piece B (u16 table) is built and exact; piece A (two-lane sin/cos) is exact but slower in four structures and is not in the branch. Neither reaches the 1.5% bar; the bundle is not worth merging.

## A: `sin`/`cos` of two creatures per step as f64x2 (not built in; code kept outside the repo)
Exact in every form below (harness hash of the whole kernel memory equal to base, `portSincos2` equal to `Math.sin/cos` in both lanes on 144k pairs incl. NaN, infinity and |x| > 823549 partners that take the scalar path).
The vector code itself: `$ksin2`/`$kcos2` with the scalar operation order, branches as selects (skipped when both lanes agree), `$rem` per lane, quadrant by masks, pair sent to scalar `$sincos` when either |x| is past `$rem`'s reach or NaN/Inf.

| Measure (step p25 ms, harness, hash equal)                                      | Base  | Variant | Delta   |
|---------------------------------------------------------------------------------|------:|--------:|--------:|
| sincos alone, hot, 3200 angles in +-50 (JS call included): scalar / pair        | 0.413 | 0.306   | -0.107  |
| same, +-0.5 / +-3 / +-5000                                                       | 0.471 / 0.586 / 0.698 | 0.213 / 0.487 / 0.537 | -0.26 / -0.10 / -0.16 |
| pre-pass over all rows (turn, heading, vector sincos), main loop reads cos/sin  | 0.968 | 1.167   | +0.20   |
| same pre-pass with scalar `$sincos` twice                                       | 0.968 | 1.289   | +0.32   |
| `$front`/`$back` functions, pairs, 1000 reps x2, mixed / cap                    | 0.939 / 1.07 | 1.086 / 1.30 | +0.15 / +0.22 |
| one function, inner 2-row loops (front, trig, back)                             | 0.989 | 1.097   | +0.11   |
| same with scalar `$sincos` twice                                                | 0.989 | 1.126   | +0.14   |
| software pipeline: even row peeks the next row's turn and heading, one pair call | 1.012 | 1.097   | +0.085  |
| same with scalar `$sincos` twice                                                | 1.012 | 1.126   | +0.115  |

Reading: in isolation the pair is 25-45% cheaper than two scalar calls (the lanes share the polynomial and the `$rem` stays per lane), which is 0.1 ms per 3200. In the step loop every way of making two rows meet costs 0.08-0.15 ms more than the gain (the vector pair saves only 0.03 of it in context), because the loop's first-touch misses of rows, units and outputs no longer overlap the sin/cos latency chains as in the one-row loop (`stepbudget.md`, `stepparts.md`). Variants with the same scalar work in the new order are as slow, so the loss is the reordering, not the vector code. Not tried: 4 rows per group or vectorising `$rem`; both enlarge the reorder cost.

## B: `cellStart` as u16
What: `crowd.wat` gap fill stores eight u16 cells per v128 (table 312 KB instead of 626 KB, room for 7 cells past the end), the sweep loads (`crowd.wat`) and the two crowd walks (`sense.wat`) use `load16_u`, `Crowd.cellStart`, the kernel views and the senser copy are `Uint16Array`. `touch` and `fill` do not read the crowd table (the brief listed them; they read the item grid). Guard: `MAX_GRID_CREATURES = 65535` throws `RangeError` in `Crowd.rebuildFrom` and `WasmCrowd.rebuild` (the engine allows 20000, `ecoState` MAX_CREATURES; the server 5000). Test: `crowd.test.ts` builds a 65535 grid and refuses 65536.

Harness `rebuild` (p25 ms, 400 reps, two copies of each, call 300; both variants on a table region large enough for the i32 one):

| Case  | i32 (base)   | u16          | Delta  |
|-------|-------------:|-------------:|-------:|
| mixed | 0.394, 0.394 | 0.360, 0.359 | -0.035 |
| cap   | 0.568, 0.567 | 0.538, 0.537 | -0.030 |

About 1.2 calls per tick, so -0.04 ms/tick from the rebuild. The readers cannot be run on the base table in the harness (format differs), so their share comes from liveBench phases.

## Whole tick (liveBench `--profile --seconds 60`, taskset 2,3,6,7 nice 19, 6 pairs per case: 3 base-first, 3 new-first; base = `perf-live`)
Fingerprints equal in all 24 runs (708687555 mixed, 10334191 cap). Peak RSS base / new: mixed 200-204 / 200-203, cap 235-237 / 234-240.

| Case  | cpuMsPerTick base                                | cpuMsPerTick new                                 | Median ratio |
|-------|--------------------------------------------------|--------------------------------------------------|-------------:|
| mixed | 10.466 10.361 10.275 10.492 10.132 10.256        | 10.623 10.497 10.358 10.379 10.503 10.357        | 1.012        |
| cap   | 12.229 12.097 12.194 11.719 12.167 12.190        | 12.172 12.242 12.333 12.622 12.323 12.324        | 1.012        |

Phase medians, base to new (mixed / cap): eat -0.044 / -0.038, collisions -0.035 / -0.024, senser -0.044 / -0.077, crowd grid -0.006 / -0.015, steer -0.004 / -0.005: together -0.13 / -0.16 ms (1.2% / 1.3% of the tick), as the table halves for the sweep and the two crowd walks and the rebuild.
`brain forward` is the exception: +0.25 / +0.31 ms in the same 12 runs, which eats the gain and makes the cpu medians worse. Unexplained. Not the region size (same-size region, and touching the unused half, gave the same), not the brain kernel (its bytes are unchanged), and a shorter 25 s check of base against a copy of base in another directory against the branch gave +0.0 / +0.15 on average with load noise 0.2. Likely a code or data placement effect on the memory-bound brain kernel; a longer interleaved run would be needed to settle it.

Piece shares: A -0 to +0.1 ms (not built), B -0.13 / -0.16 ms in the phases it touches, 0 to +1.2% in the tick as measured.

## Tests
`npx vitest run wasm step crowd fill sense resident layout --maxWorkers=2 --testTimeout=180000`: 7 files, 117 tests, exit 0. Full suite once: 122 files, 1264 tests, exit 0. (Piece A's `wasmStep` additions, 21 tests incl. the pair checks, also passed before it was dropped.)

## Verdict
Park. B is exact and small (about 1.2% in its own phases, the tick gain does not show through an unexplained brain-forward shift); A is a loss in the step loop in every structure tried. If B is wanted later, it can be taken alone (+48 -26 lines over five files and one test); re-measure brain forward with 10 or more interleaved pairs first.
