# JS bundle: the small pieces between the kernels (idea 142)

Branch `pl-jsbundle`, base `perf-live` 819d0a8. Exact: fingerprints 708687555 (mixed, 60 s) and 10334191 (cap) unchanged. One cut built (`forwardRun` into the brain kernel), the other pieces measured and left alone.
Verdict: below the bar. The pieces add up to 3.0% (mixed) and 3.2% (cap) of the tick, but all but `forwardRun` are first-touch misses on cold lines, not JS work. The one real cut is worth 0.03-0.05 ms (0.3-0.4%).

## How measured

Per-call thread CPU (`process.threadCpuUsage`) with self time (children subtracted), prototype wrappers around the pieces, 900-1200 ticks, last 75% counted, `taskset -c 2,3,6,7 nice -n 19`, load 12-20. One read costs about 1-2 us here, so "coarse" mode wraps only top-level pieces (about 8 calls a tick) and fine mode (40 `eatAt`, 15 `addRandomly`) overstates by 2 us a call and is used only for call counts. Harness not committed.
Mixed = `--copies 800` (3300 creatures), cap = `--only juggernaut --copies 4900`.

## Per-piece table (ms per tick, self, before / after)

| Piece                                              | Mixed before | Mixed after | Cap before | Cap after | Note |
|----------------------------------------------------|-------------:|------------:|-----------:|----------:|------|
| `forwardRun` (mark and walk of the run list)       | 0.065-0.073  | 0.036 (kernel `runOrder`) + about 0.005 | 0.087-0.089 | 0.027 + about 0.005 | built, exact |
| `syncItems` (`patchCells`)                         | 0.071-0.079  | same        | 0.100      | same      | of it the `patchItems` kernel 0.046, JS list walks 0.028 |
| `regrow` (15 `addRandomly`, 1.8 accepts, 1.06 `touchesRock`, 1 `tooClose` each) | 0.056 | same | 0.056 | same | 3.7 us a spot, about 15 cold lines each |
| eat loop in `sharedPhase` (40 eats, `removeItem` 1 us each) | about 0.09 | same | about 0.09 | same | `eatcost.md` |
| `sharedPhase` self without the eat loop            | 0.03         | same        | 0.05       | same      | the hit scan and rng, no cut worth a line |
| `MemberTable.swapRemove` + `admit` (births and deaths) | 0.012 + 0.012 (cap) | same | | | splice and `copyWithin` of the row lists, cold `slotPosition` chases, 23-24 us a call at 4900 |
| `Ecosystem.remove` (deaths, bench has no chronicle) | 0.027      | same        | 0.04       | same      | |
| `giveBirth`                                        | 0.038        | same        | 0.08-0.09  | same      | `birthcost.md` |

Fine-mode wrapper noise makes the `sharedPhase` self time (0.095-0.15 ms with 70 wrapped calls) a ceiling only.

## Change

`brain.wat` gets `runOrder(run, n, order, held, mark, cap, stamp)`: the mark pass and the walk of `forwardRun` as one kernel call. `order` is mirrored into kernel memory when it changed (`orderDirty`, set in `reorder` and `unorder`, 5% of ticks mixed, 1% cap), the stamps are bytes in the arena (one per slot, cleared every 255 calls), and a slot not below `cap` is skipped. The "slot without a brain, or listed twice" check stays: fewer slots placed than listed throws. About +26 wat, net +25 JS. The old `thinkEvery` test that set the i32 stamp near its limit now sets the byte stamp near 255.
Why not more: 30 us for 6700 steps is cold-line bound, not instruction bound (byte marks instead of i32, 4x fewer lines, did not change it). Skipping the sort when the run list equals last tick's would save about 0.013 ms more (births and deaths change it in 33% / 61% of ticks).

Test (`wasmKernels.test.ts`): `forwardRun` against `forwardSlots` over 600 rounds of scrambled lists, births, reshapes, releases, slot-table growth and two stamp wraps; red without the `orderDirty` in `unorder` and red without the mark clear at the wrap (both mutants checked); rejection of an unset, released, repeated or out-of-table slot.

## Measured (liveBench --profile, 3 alternating pairs, base = perf-live, cpuMsPerTick)

| Case  | Base                   | Yours                  | Ratio of medians | brain forward phase base / yours (medians) | Fingerprint    | Peak RSS MB base / yours |
|-------|------------------------|------------------------|-----------------:|--------------------------------------------|----------------|--------------------------|
| mixed | 11.189 11.180 11.136   | 11.222 11.129 11.121   | 0.995            | 4.297 / 4.265                              | 708687555 both | 214-218 / 214-221        |
| cap   | 12.972 12.418 12.912   | 12.883 12.717 12.672   | 0.985            | 4.054 / 3.968                              | 10334191 both  | 255-256 / 252-256        |

The tick totals are inside the run-to-run spread (base cap alone spans 12.42-12.97); the phase medians agree with the per-call timers (-0.03 mixed, -0.09 cap).

## Verdict suggestion

Merge only as a tidy-up: exact, 0.3-0.4% of the tick, +26 wat and a small JS change, no memory cost. The bundle bar (1.5% in one case) is not reachable: of the 0.35-0.43 ms the pieces cost, the JS is cache-miss bound and the only exact lever left (batching regrow lookups, warming ahead) was already shown flat in `eatcost.md`.

## Tests

`vitest run wasm ecosystem resident ecoSlotOrder ecoPool`: 8 files, 186 tests, exit 0. `tsc --noEmit` exit 0. Full suite (`--maxWorkers=2`): 1256 passed, 6 failed, exit 1: five load timeouts (`cli` x4, `liveReset`, 20 s default, "packing the save took too long"), which pass alone (`thinkEvery cli liveReset`: 35 passed, exit 0), and the `thinkEvery` stamp-wrap test, which set the old i32 stamp limit and was fixed as above.
