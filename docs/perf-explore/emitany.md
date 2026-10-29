# Idea 154: pair emit and lean merge loop for every stride (emitany)

Branch `pl-emitany` from `perf-live` a461e50. Generality item B1 of `generality.md`: the two-rays-per-step `$emit` and the lean crowd merge loop ran at stride 6 only (one species), every other stride took the per-ray loops. Exact: bytes equal for every stride.

## Built (`sense.wat`)
- `$emit`: the pair loop takes any stride. The zero tails (4 * (stride - 4) bytes per ray) are right-aligned v128 stores, which only overshoot into the ray's own head, and the two head vectors (closeness plus one-hot, same `f64x2` division and shuffles as before) are stored after them. The odd last ray takes the single loop, now without the stride 6 special case.
- Lean merge loop (no detail record): any stride. Zero tail as above, then for a seen creature the species flag at `16 + 4 * species` (only if species < stride - 5) and the energy at `4 * (stride - 1)`; stride 4 (no creature sight) writes the head only. The detail-record loop lost its stride 6 copy (the general code writes the same bytes; one creature per call).
- No stride-specific branch is left in `sense.wat` (grep `stride) (i32.const 6)` is empty).

## Differential (review round 11 harness, `sensediff2` extended to species counts 0, 1, 2, 3, 4, 7 and the blind case)
`perf-live` against this tree: strides 4, 6, 7, 8, 9, 12, ray counts 1-64, four world setups (walls, rocks, item radius 0), with and without a detail record for every creature, NaN and -0 energies, spreads 0 to 7, 1792 cases, 1.86 M rays, 211 k crowd hits, kinds 0-4. All 1792 hashes equal (`cmp` of the two dumps identical).

## Test
`wasmKernels.test.ts`: "writes the JS encoding, and the same input with and without a detail record, at every ray stride and ray count": strides 4 (no sight), 6, 7, 8 (3 species), 9, 12, rays 1, 2, 3, 8, 9, 16, 33, 64, crowd clumps and wall creatures; kernel ray input equals the JS `encode` within 1e-4 and the non-detail input equals the detail input exactly (NaN-filled before each run). With the pair zero stores removed it fails (NaN left in the tail), so it sees the stores.

## Whole tick (`liveBench --profile --seconds 60`, taskset 2,3,6,7, nice 19, alternating pairs, base = `perf-live` worktree)

| Case  | Set | Build | cpuMsPerTick            | senser ms                | brain forward ms     | peak RSS MB   | fingerprint |
|-------|-----|-------|-------------------------|--------------------------|----------------------|---------------|-------------|
| mixed | 1   | base  | 8.734, 8.430, 7.725     | 3.153, 3.038, 2.744      | 3.401, 3.291, 3.046  | 202, 200, 201 | 708687555   |
| mixed | 1   | new   | 8.467, 7.628, 8.856     | 3.059, 2.750, 3.220      | 3.290, 2.983, 3.430  | 202, 202, 201 | 708687555   |
| mixed | 2   | base  | 7.656, 7.540, 7.594     | 2.728, 2.684, 2.694      | 3.008, 2.969, 2.996  | 201, 200, 200 | 708687555   |
| mixed | 2   | new   | 7.627, 7.806, 7.450     | 2.736, 2.819, 2.691      | 2.997, 3.040, 2.909  | 201, 197, 200 | 708687555   |
| cap   | 1   | base  | 9.243, 9.355, 9.339     | 3.620, 3.644, 3.661      | 2.861, 2.855, 2.878  | 233, 238, 237 | 10334191    |
| cap   | 1   | new   | 9.385, 9.028, 9.588     | 3.705, 3.573, 3.798      | 2.879, 2.760, 2.953  | 236, 235, 238 | 10334191    |
| cap   | 2   | base  | 8.999, 8.923, 8.703     | 3.515, 3.507, 3.424      | 2.780, 2.754, 2.684  | 236, 236, 239 | 10334191    |
| cap   | 2   | new   | 8.940, 9.128, 8.901     | 3.533, 3.602, 3.503      | 2.744, 2.815, 2.735  | 237, 235, 237 | 10334191    |

Ratio of medians (new / base), senser: mixed 1.007 and 1.016, cap 1.017 and 1.007; tick: 1.004 and 1.004 (mixed), 1.005 and 1.002 (cap). Per pair the sign flips (new faster in 4 of 12 pairs for the senser), the load on the machine moves the senser by 10% between runs.

Kernel harness (sense.wat variants alternated on one state, p25 ms, hash equal 10b91cba mixed and 4cc9bd68 cap): new minus base +0.03 to +0.07 mixed, -0.01 to +0.12 cap, about +1 to 3% of the kernel. A control shows this is not the general code: a copy of `perf-live` with only the detail-record loop edited (code that runs for no creature in the bench) reads +0.03 to +0.07 as well, and a hybrid (stride 6 branches of `perf-live` kept, general code for the other strides) is no faster than the general form (+0.00 to +0.07). Two identical copies of base differ by 0.01. So the cost is a code-layout effect of editing the large `sense` function, not the extra stores or loops.

## Verdict suggestion
Merge. Exact, one code path for all strides, about 0.3% of the tick (+1% of the senser, inside the pair noise) at the live stride. If the 1% senser rule is applied strictly, the hybrid (kept stride 6 form plus the general loop for the others) did not measure better, so it does not buy the speed back. Peak RSS unchanged.

## Tests
`npm run wasm` exit 0. `npx vitest run wasm sense resident --maxWorkers=2 --testTimeout=180000` from `src/typescript`: 5 files, 114 tests, exit 0.
