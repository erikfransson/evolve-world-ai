# Births: where the phase goes, and the scan that mostly runs for nothing (idea 114)

Branch `pl-birthcost` from `perf-live` 598dec6. Exact: fingerprints 708687555 (mixed, 60 s), 164690887 (mixed, 600 s) and 10334191 (cap) unchanged.

## Attribution (before)
Births per tick, steady: mixed 0.24 (428 in 1800 ticks), cap (juggernaut x 4900) 0.51 (927), mixed 600 s 0.28 (5052 in 18000). Not 2 per tick. Births phase on the head: 0.063 ms mixed 60 s, 0.089 mixed 600 s, 0.19 cap.

Per-tick scan of every member (`birthCandidates`), measured with kernelTimers-style wrappers (wall clock, load 8-11 on the pin, so absolute us are inflated): wrapper 48 us (mixed) and 110 us (cap) per call, kernel 35 and 87 us, so 0.048 and 0.11 ms per tick. The scan is 75% of the births phase in the mixed case and 58% at the cap.

Why it is wasted: the list holds nearly every member (2758 of 3300 on average, 3541 of 4900), because energy (median 403, thresholds median 224) is above the birth energy for most. What stops births is the caps. The loop ends at once on `weights > birthWeightCap` (mixed: 1444 of 1800 ticks, weights 6239088 against cap 6238662) or `members.length >= birthCap` (cap case: 1069 of 1800 ticks). In the other ticks it visits 1.3 members (465 visits for 356 open ticks, 37 skipped by cooldown) and then hits the cap again after its births. So the scan result is unused in 80% (mixed) and 59% (cap) of ticks, and in the rest 99.9% of the list is unused.

Per birth (giveBirth, same wrappers plus laps, cap case 195 us wall, mixed 223 us wall at the inflated load; shares are what counts):
| Part | Share | Note |
|------|------:|------|
| `spawn` | 54% | `Creature.reset` 36% (of it `SenseKernels.attach` 23%: bank `set` 8%, `setOffsets` 11%, which builds a new table for nearly every child since plan drift changes the spread), `MemberTable.admit` 11%, rest 7% |
| genome copy and `mutate` | 19% | wasm scan 4.7%, normals for about 60 hits, `genome.set` 1% |
| `driftPlan`, structural test | 6-9% | |
| `birthdrift`, spot, pay and plan copy, hue | 12% | |
Per tick that is 0.027 ms (mixed 60 s) and 0.12 ms (cap) wall-inflated, about 0.02 and 0.045 ms of CPU. No single part is above 0.01 ms per tick, so none was cut (`setOffsets` in place for a table with one reference would save perhaps 5 us a birth).

## Change (exact)
1. `Ecosystem.step` calls the scan only when the loop can run: `members.length < birthCap && weights <= birthWeightCap` at entry. Both only grow inside the loop, so a false start stays false and the loop would not have run. The `first` draw stays where it was.
2. The kernel returns the walk a few at a time (`BIRTH_CHUNK` 8, `M_MAX`), and `nextBirthCandidates` continues from the saved position (`M_FIRST`, `M_STEPS` stand after the last member looked at) with the copies of `rowAt` and `thresholds` the first call made. Births change no other member's energy, so the members not yet looked at read the same as in a full list. `mutateHits` calls between the chunks share the call block, so the continuation rewrites the fields they use.

Files: `members.wat`, `layout.ts` (`M_MAX`, `M_STEPS`), `membersKernel.ts`, `ecosystem.ts`. About +45/-12 lines.

## Measured (liveBench --profile, taskset -c 2,3,6,7 nice 19 idle, 3 alternating pairs, base = perf-live)
| Case | births phase base (ms) | births phase yours | cpuMsPerTick base | cpuMsPerTick yours | fingerprint | peak RSS MB base / yours |
|------|------|------|------|------|------|------|
| mixed 60 s | 0.063, 0.075, 0.067 (med 0.067) | 0.021, 0.026, 0.029 (med 0.026) | 9.301, 8.176, 10.33 (med 9.301) | 8.422, 11.185, 11.293 (med 11.185) | 708687555 both | 218-220 / 217-220 |
| mixed 600 s | 0.100, 0.086, 0.089 (med 0.089) | 0.047, 0.044, 0.039 (med 0.044) | 10.816, 9.128, 9.398 (med 9.398) | 10.128, 9.557, 8.462 (med 9.557) | 164690887 both | 224-228 / 223-228 |
| cap, juggernaut x 4900, 60 s | 0.186, 0.205, 0.189 (med 0.189) | 0.094, 0.094, 0.101 (med 0.094) | 13.907, 15.329, 14.327 (med 14.327) | 13.47, 13.876, 14.127 (med 13.876) | 10334191 both | 252-258 / 251-257 |

Births phase: mixed 60 s -0.041 ms (-61%), mixed 600 s -0.045 ms (-51%), cap -0.095 ms (-50%). In ticks that is 0.4-0.5% (mixed) and 0.7% (cap). The tick totals only show the load: base and yours differ by -2% to +20% between runs of one build while the phase delta is 0.04-0.1 ms, so the total ratios (medians 1.20, 1.017, 0.969) say nothing; the phase column is the measurement. No peak RSS change.

## Tests
`npx vitest run thinkEvery ecoPool liveSaves residentBodies wasmStep ecosystem mutationScale planMutation memberTable ecoSlotOrder brain ga creature wasmMembers wasmKernels birthReserve liveWeights livePools wasmCrowd evolution population ecoBirths ecoLive --testTimeout=180000 --maxWorkers=1`: 27 files, 348 tests, exit 0; `tsc --noEmit` exit 0. New in `wasmMembers.test.ts`: the candidate walk in chunks of 1, 3 and 8 with `mutateHits` calls between them equals the full list. The whole-run test (scans against JS loops) covers the gate.

## Verdict suggestion
Merge: exact, +45 lines, births phase halved (0.04-0.1 ms, 0.4-0.7% of the tick), no memory cost. Below the 1% bar alone, but it is free and the scan was pure waste in most ticks. What is left in the phase is the births themselves (0.02 ms mixed, 0.045 cap) and `spent` handling; the per-birth parts are all under 0.01 ms per tick, so further cuts there are not worth their diff.
