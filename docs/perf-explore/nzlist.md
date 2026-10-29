# Brain kernel: non-zero ray-feature list built by the sense kernel (idea 64, "nzlist")

Exact, but slower: the sense kernel pays more than the brain kernel saves. Branch `pl-nzlist` from `perf-live`; verdict reject.

## What
- `sense.wat` `$emit` (the no-creature-seen path) appends the indices of the non-zero ray features in ascending order without branching (store the index, add the compare result to the count): closeness by the `f32 != 0` test (NaN in, -0 out) and the one-hot lane of kinds 1 to 3. The early-out path writes an empty list. Every creature gets tag 0 first, so the seen, detail and zero-ray paths keep the full compaction.
- The list sits in the brain block before the input: a 16-byte header (tag = count + 1, first unlisted input index, list address) and room for four entries per ray. `brainKernel.ts` `set` reserves `4 + pad4(nIn)` floats there; `layout.ts` has `Z_*`.
- `brain.wat` `forward`: with a tag it copies the list to `nz`, clears the tag, and `$compact` (new `from` parameter) packs only the extras and memory units after it. Without a tag it is the old full compaction.
- 3092 of 3318 brains are tagged at tick 600 (the rest saw a creature), with a mean of 1.6 listed entries.

## Exactness
- liveBench fingerprints unchanged: 708687555 (mixed), 10334191 (cap), 3 runs each.
- New test in `wasmKernels.test.ts`: ray counts 0 to 12, species 0, 2, 3 (strides 5, 6, 8), list areas poisoned with -1 before the run; each tag's list equals the brute-force `f32 != 0` indices of the ray part, the tag is consumed, and a second run on the untagged (full compaction) path gives bit-equal outputs.
- Tests: `npx vitest run wasmKernels thinkEvery ecoPool residentBodies wasmStep --testTimeout=180000 --maxWorkers=1`: 5 files, 92 tests, exit 0.

## Pre-check was wrong
Ablating the head of `$compact` (compact only the last 8 inputs) gave kernel 1.15-1.17x, but it also drops the ray part's MACs, so it is not a bound for the compaction. The real kernel gain with lists (brain3 harness `kab`, tags restored before each call, outputs hash equal to the old kernel, 3318 brains, 41-61 reps, median):

| | old | nzlist | ratio |
|---|---|---|---|
| cold | 4.896-5.136 ms | 4.714-4.977 ms | 1.03-1.04x |
| hot | 4.854-5.137 ms | 4.616-4.947 ms | 1.04-1.05x |

Leaving out the tail compaction (not exact, fewer MACs) gives 1.14x, so the list copy and header cost about nothing and the compaction of the ray part is about 5% of the kernel, not the 17-21% of brain.md (that figure includes the first touch of the input).

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, 3 alternating pairs, load 15-20)

| Case | Build | cpuMsPerTick | senser ms | brain forward ms | peak RSS MB |
|---|---|---|---|---|---|
| mixed | base | 14.203, 13.988, 14.112 (med 14.112) | 5.417, 5.362, 5.371 | 5.068, 4.987, 5.048 | 219, 215, 218 |
| mixed | nzlist | 14.283, 14.323, 14.216 (med 14.283) | 5.713, 5.681, 5.640 | 4.919, 4.996, 4.912 | 222, 219, 220 |
| cap | base | 17.039, 17.018, 17.003 (med 17.018) | 6.813, 6.747, 6.775 | 5.133, 5.164, 5.145 | 256, 254, 253 |
| cap | nzlist | 17.312, 17.315, 17.247 (med 17.312) | 7.069, 7.025, 7.047 | 5.107, 5.098, 5.079 | 258, 258, 255 |

Ratio of medians: mixed 1.012, cap 1.017 (slower). Senser +0.31 ms (mixed) and +0.27 ms (cap), brain forward -0.13 ms and -0.05 ms. Peak RSS +2-3 MB (the list room in every block).

## Why
The brain saves one compaction pass over the ray part (about 0.13-0.23 ms), while the senser pays a dependent store and count chain per ray plus two more cache lines written per creature (header and list sit apart from the input in a block that is cold when sense writes it). A sequential per-batch list buffer would cut the lines but cannot beat the brain's gain by more than about 0.1 ms (under 1% of the tick), below the 1.5% bar. Not built.

## Verdict
Reject. Exact and general over ray count and stride, but 1.2-1.7% slower. Keep the note; the brain kernel's compaction is not a worthwhile target (about 5% of the kernel).
