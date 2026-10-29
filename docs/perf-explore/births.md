# Cheaper births (idea 59)

Branch `pl-births`. Exact: fingerprints 708687555 (4 founders x 800, 60 s), 164690887 (same, 600 s), 10334191 (`--only juggernaut --copies 4900`) and the thinkEvery pin unchanged; saves round-trip (liveSaves).

## Where a birth went (cpu-prof of a loop of births on the mixed world, children removed again)
Before: `mutate` 38% (the scan over about 1900 genes at 5% rate, plus the normals), `inputLayout` label arrays 7% (called by `layerSizes` per birth), `fitUnits` 8%, bank `set` 5-16%, `setOffsets` 5% (key string by `join` of the ray offsets, per birth, since plan drift gives every child a new spread), `clamp`/`refit`/`Brain` ctor the rest. Allocation and GC are not it (about 1% of the run, 138 scavenges in 60 s).
The births phase is 0.7% of a 60 s tick and 1.1% at 600 s (0.145 ms of 12.7), so the bar of 1% of the tick cannot be met by cutting the per-birth part alone: the phase also holds the candidate scan (about 23 us per tick at 3340 members, `scanBench`) and, early in a run, `new Creature` for births that find no dead one to reuse (173 of 428 births in the first 60 s, 173 of 5052 by 600 s).

## Changes (all exact)
| # | Change | Where |
|---|--------|-------|
| 1 | `mutate` split into a tight scan loop and the hit (two draws and the normal inline, no call in the loop) | ga.ts |
| 2 | The scan of `mutate` in WebAssembly: 4 genes per step (their draws are s + k x step while no gene mutates), writes gene index and the two draws of each hit; JS does `log`, `cos`, `sqrt` as before. JS loop stays as fallback and reference | members.wat `mutateScan`, membersKernel.ts `mutateHits`, layout.ts `M_SEED`, `M_LIMIT` |
| 3 | `layerSizes` without the `inputLayout` label arrays (`rayFeatureCount`), `Brain.load` shape test without a closure | brain.ts |
| 4 | Ray offset tables looked up by a hash of the offset bits (chained, bits compared) instead of a `join` string; the equality test against the held table is allocation free. Sharing by content (`sensecuts.md` #1) is kept | senser.ts |
| 5 | Bank `set` writes the transposed block with a running index | brainKernel.ts |
| 6 | A birth takes a dead creature whose brain has its genome length from the last 16 dead of the species (else the latest): 60% of reuses changed the brain shape at 600 s (2948 of 4879), each costing an arena release, alloc and reorder (the eat scout's suggestion; only the last 16 are searched, no bucket structure) | ecosystem.ts `takeSpare` |

Rejected: keeping the candidate scan's copies of `rowAt` and thresholds while `table.version` is unchanged (scan 23.1 to 19.2 us per call upper bound, about 0.03% of a tick, 6 more fields); writing the child's bank block as a copy of the parent's block plus the hit genes (about 15% of a birth, needs the hit list through `spawn`, `reset` and `attach`; not built); swapping the `set` loop order (no change).

## Per birth (birthBench: LiveWorld mixed, 400 ticks, then batches of 200 births timed by thread CPU, 20 batches, median; same stream, same fingerprint)
| | perf-live | pl-births |
|---|---|---|
| children removed again (spares always fit) | 199.4, 198.7, 210.1 us | 83.9, 82.2, 113 us (first change set only, last two) |
| random members removed (spares mixed, like a live world) | 215.0, 215.7 us | 104, 100.9 us before change 6; 90.1, 92.4 us with it |

The machine is loaded (load 12-20 on a pinned pair of cores), so absolute microseconds are inflated several times; ratios are what counts: a birth costs 0.43x.

## liveBench (taskset -c 2,3,6,7, nice 19 idle, 3 alternating pairs each, --profile)
| Case | base cpuMsPerTick | yours | births phase base | births phase yours | fingerprint | peak RSS MB base / yours |
|---|---|---|---|---|---|---|
| mixed 60 s | 14.02, 13.674, 13.93 (med 13.93) | 14.078, 13.717, 13.928 (med 13.928) | 0.093, 0.090, 0.091 | 0.080, 0.080, 0.081 | 708687555 both | 216-220 / 217-219 |
| mixed 600 s | 12.95, 12.691, 12.565 (med 12.691) | 12.689, 12.069, 12.312 (med 12.312) | 0.145, 0.145, 0.142 | 0.103, 0.097, 0.099 | 164690887 both | 229-231 / 222-224 |
| cap, juggernaut x 4900, 60 s | 16.603, 16.383, 16.751 (med 16.603) | 16.144, 16.44, 16.764 (med 16.44) | 0.242, 0.236, 0.250 | 0.196, 0.182, 0.192 | 10334191 both | 254-256 / 255-258 |

Births phase (ms per steady tick): 600 s 0.145 to 0.099 (-32%), cap -21%, mixed 60 s -12% (there `new Creature` is a large part and untouched). Tick ratio of medians 600 s 0.970, cap 0.990, mixed 60 s 1.000; the births phase delta alone is 0.046 ms (0.36% of the tick) at 600 s, the rest of the 600 s ratio is run-to-run spread (about 3% between runs of one build). No peak RSS growth.

## Tests
`npx vitest run thinkEvery ecoPool liveSaves residentBodies wasmStep ecosystem mutationScale planMutation memberTable ecoSlotOrder brain ga creature wasmMembers wasmKernels birthReserve liveWeights livePools wasmCrowd evolution population --testTimeout=180000 --maxWorkers=1`: 25 files, 294 tests, exit 0; `tsc --noEmit` exit 0. New: larger `mutate` stream test (ga), kernel `mutateHits` against the JS `mutate` over lengths, rates and start states (wasmMembers), `layerSizes` against `inputLayout`, `takeSpare` (ecosystem). The hash chain of change 4 was also run with a constant hash (wasmKernels, wasmStep green).

## Verdict suggestion
Merge: exact, a birth costs 0.43x, births phase -32% at 600 s, no memory cost, +250 lines with tests (the wasm scan is the largest part; changes 1, 3, 4, 5, 6 alone give about 1.6x per birth). The tick gain is 0.3-0.4% at 600 s, below the 1% bar, because births are 1.1% of that tick. What remains of the phase is the candidate scan (about a quarter) and construction of creatures when the population grows.
