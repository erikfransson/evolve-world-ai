# Four-ray f32x4 item prefilter in the sense kernel (idea 130, "prefilter4")

Branch `pl-prefilter4` from `perf-live` 4e9f308 (ideas 88 and 126 in). Built and measured, exact, but slower. Verdict: drop. The patch (+78 -41 in `sense.wat`) is kept outside the repo; only the superset check is committed (`prefilter4-superset.py`).

## What the prefilter compares

Per candidate (item or rock disc, centre `(fx, fy)` relative to the creature) and ray (unit direction `(dx, dy)`): `s = fx*dy - fy*dx`, the perpendicular distance of the centre from the ray line. Items pass when `s*s <= rt`, `rt = r^2 + 1e-9 (L + |r|)^2`; rock discs always pass (their own radius). Distance along the ray, the quadratic and the closeness tie rule are only in the exact test, which runs on the passing pairs, so a false positive in the prefilter costs time and changes no output. Kept item candidates have `|f| <= far = L + r + 1e-9 L`.

## Superset argument

Gate: four rays in f32x4, pass when `|s32| <= T32` with `s32 = fl(fl(fx32*dy32) - fl(fy32*dx32))`, inputs demoted to f32, `u = 2^-24`.
- Each product has relative error at most `3u(1+)` (two input demotions and one product rounding), the subtraction adds `u|s32|`. So `|s32 - s| <= 3u (|fx dy| + |fy dx|) + u|s| <= (3 sqrt2 + 1) u |f||d| = 5.25 u |f||d|` (Cauchy-Schwarz), with `|d| = 1 + 1e-14`, `|f| <= far`. The f64 evaluation of `s` has error under 1e-15 far, negligible against the slack below.
- Take `E = 8u far = 2^-21 far` (factor 1.5 over 5.25u), `T = (sqrt(rt) + E) (1 + 2^-23)`, `T32 = demote(T)`. Round-to-nearest gives `T32 >= T(1+2^-23)(1-u) >= T`.
- If the f64 prefilter passes, `|s| <= sqrt(rt) (1+tiny)`, so `|s32| <= |s| + E <= T <= T32`: the gate passes. The f64 prefilter is already a superset of the exact hit (existing margin 1e-9 far above rounding), so the gate is too. The gate only decides which pairs enter the unchanged f64 prefilter and exact test.
- Padding lanes (rays beyond `nR`) hold NaN directions, `NaN <= T` is false. Rock discs OR the gate with all-ones (no bound, as the f64 path with `rtk = inf`).

Check: `docs/perf-explore/prefilter4-superset.py` (numpy float32, per-operation IEEE rounding as in wasm, no fused multiply-add). 44.6 million candidate and ray pairs (L 0.1-3000, r 0.01-100, tangent cases at `s = r (1 +- 1e-12..1e-2)`, free perpendicular distances, direction length drift 1e-14), 27.9 million passing the f64 prefilter, 16.4 million exact hits: 0 violations. The largest observed `|s32 - s64| / far` is 3.17u (derived 5.25u, used 8u). Power: with `E = 0` 30403 prefilter passes (13659 hits) are lost in 7.4 million pairs, with `E = 1u` 40 and 15. The gate is also tight: in the kernel at call 300 every pair it lets through passes the f64 prefilter (counts below), so false positives are not the cost.

## Build and measurement

Gate loop of four rays per step (5.5 gates per creature instead of 11 groups), f32 directions written next to the f64 ones (quad store pass, no more in `crowdPrep`), per-candidate f32 splats of `fx, fy`, on a pass the two f64 pair bodies run unchanged behind a lane test. Counts (call 300, items): mixed 17614 gates per 3200 creatures, 15.5% pass, 0.86 pairs run per creature, all of them pass the f64 prefilter and hit; cap 13509 gates per 4900 creatures, 23% pass.

Kernel harness (the 121 harness against this worktree, p25 of 150 calls, `taskset -c 2,3,6,7 nice -n 19`, base and variant alternating on the same state). Hash of all brain inputs equal in every row (exact):

| Call | Case  | base ms | prefilter4 ms | delta  |
|-----:|-------|--------:|--------------:|-------:|
| 300  | mixed | 3.487   | 3.624         | +0.137 |
| 300  | mixed | 3.576   | 3.741         | +0.165 |
| 300  | cap   | 4.449   | 4.746         | +0.297 |
| 300  | cap   | 4.519   | 4.704         | +0.185 |
| 1000 | mixed | 3.198   | 3.342         | +0.144 |
| 1000 | cap   | 3.993   | 4.143         | +0.150 |

Probes (call 300 mixed, base 3.606 in that run):

| Variant                                                           | p25    |
|-------------------------------------------------------------------|-------:|
| base with the exact path forced off (scan only)                   | 3.234  |
| prefilter4 with the pair path forced off (gate scan + prelude)    | 3.269  |
| base plus the f32 direction prelude only                          | +0.05  |
| f32 directions as 16-byte stores instead of 8-byte (forwarding)   | equal  |

Reading: the scan itself is not the cost. With the exact work switched off, the old two-ray scan (3.234) and the four-ray gate (3.269, prelude included) take the same time, so halving the groups removes nothing measurable; the 0.37 ms between base and its scan-only probe is the taken path (1.6 passing pairs a creature, mispredicted branches and the exact test), which the gate cannot shrink because it already admits only pairs that pass the f64 prefilter. The new prelude (+0.05 ms) and the extra branches of the passing path (gate, lane test per half, loop) make it 4-6% slower. The liveBench pairs were not run: a kernel regression of 0.14-0.30 ms cannot become a 1.5% tick gain.

Tests (with the build, before it was reverted): `npx vitest run wasm sense resident --maxWorkers=2 --testTimeout=180000`, 5 files, 104 tests, exit 0.

## Verdict

Drop. The f32 superset is cheap and proven (above), but the group count is not what the prefilter costs; the passing path is. Not worth retrying with a different gate width. Remaining ideas would have to cut the passing path (fewer mispredicted branches or a branch-free exact test, which `raytests.md` found slower).
