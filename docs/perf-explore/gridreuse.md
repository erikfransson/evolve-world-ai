# Reuse the shared-phase crowd grid at the tick start (idea 33)

Exact, about 2% faster at 3300 and 1.7% at the cap. Branch `pl-gridreuse`, base `perf-live` 9c7e0df. Step 1 only.

## What

The crowd grid was rebuilt twice a tick: in `prepareTick` (pre-move positions, for the sense kernel) and in `sharedPhase` (moved positions, for touch, hunting and collisions).
Nobody moves between the second and the next tick's first, except that collisions push creatures (written back into the grid's xs/ys, but a push can cross a cell) and births, deaths, eating, hunting and bumps change the member table and energies.

- `crowd.wat` `refresh`: one pass over the sorted slots, `i = owners[k]`, re-reads x, y, energy and species from the row, recomputes the cell key exactly as `rebuild` does and returns 0 at the first creature whose key differs from `cellOf[i]` of the last rebuild.
  With the same n and every creature in its old cell, a fresh stable sort gives the same order (by cell, then table index), so the arrays equal a rebuild bit for bit; `cellStart`, `occupied` and `owners` are unchanged.
- `MemberTable.version` counts `admit` and `swapRemove`. `prepareTick` tries the refresh only when the version equals the one at the last WebAssembly rebuild, so it does not spend a pass that would fail after a birth or death. Exactness rests on the cell check alone (a mutant without the version test still passes the tests).
- The JS crowd path, n of 12 or less, and a refresh that fails all fall back to the full rebuild. Species: the tick start passes none when one species, the shared phase passes `kinds`, which are then all 0, so both write the same.

## Qualifying ticks (60 s runs, counter not committed)

| Case                    | Table unchanged | Refreshed (no cell change) | Births / deaths |
|-------------------------|-----------------|----------------------------|-----------------|
| 4 founders x 800 (3300) | 1451 / 1800     | 1433 (80%)                 | 428 / 344       |
| Juggernaut x 4900 (cap) | 1120 / 1800     | 1057 (59%)                 | 927 / 927       |

## Whole tick (liveBench `--profile`, 60 s, nice 19, 3 alternating pairs, load 8-12)

| Case  | Build | cpuMsPerTick                        | crowd grid ms       | eat ms              | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------------|---------------------|---------------------|---------------|-------------|
| mixed | base  | 10.391, 12.893, 12.927 (med 12.893) | 0.335, 0.403, 0.404 | 0.771, 0.906, 0.910 | 216, 214, 214 | 708687555   |
| mixed | yours | 9.490, 12.648, 12.584 (med 12.584)  | 0.120, 0.156, 0.155 | 0.729, 0.916, 0.904 | 217, 216, 217 | 708687555   |
| cap   | base  | 15.783, 15.758, 15.621 (med 15.758) | 0.572, 0.568, 0.566 | 1.227, 1.225, 1.211 | 253, 255, 254 | 10334191    |
| cap   | yours | 15.543, 15.485, 14.314 (med 15.485) | 0.352, 0.356, 0.330 | 1.223, 1.223, 1.147 | 254, 251, 256 | 10334191    |

Ratio of medians 0.976 (mixed) and 0.983 (cap). Pair 1 of mixed ran in a quiet minute on both sides (both about 10 ms).
The phase itself drops 0.25 ms (1.9% of the tick) and 0.22 ms (1.4%). A refresh costs about 0.09 ms against 0.40 for a rebuild: the pass reads rows in grid order, which is the rebuild's own gather.
Eat is unchanged, as it should be (the shared-phase rebuild stays).

## Step 2 (not built)

Patching the grid for births and deaths would only help the ticks that now rebuild: about 20% at 3300 (at most 0.08 ms, 0.6%) and 41% at the cap (at most 0.23 ms, 1.5%).
Each event shifts the sorted arrays and every later `cellStart` entry (about 70k cells), roughly 20-30 us, with about 2.5 events per such tick at the cap, so the real gain is about 1% there and less at 3300, for an estimated 100+ lines of wat.

## Tests

New case in `tests/typescript/wasmCrowd.test.ts`: 300 ticks on a small damage world with easy births and on the predator world, an energy edit every 7th tick and a move across a cell every 11th, `prepareTick` then a fresh JS rebuild compared array for array; asserts more than 20 refreshes and more than 20 tick-start rebuilds.
It goes red with the refresh writing no energies (1550 differences) or without the cell check (900).
Focused files (wasmCrowd wasmKernels thinkEvery ecoPool residentBodies wasmStep) 118 passed, exit 0; full suite 1223 passed, exit 0; tsc clean. thinkEvery pin 81047108 holds.

## Verdict

Merge: exact, 2.4% / 1.7% per tick at 3300 / cap (1.9% / 1.4% from the phase), no RSS change, about 65 lines. Skip step 2.
