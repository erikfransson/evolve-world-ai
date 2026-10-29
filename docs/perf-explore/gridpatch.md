# Patch the crowd grid for births and deaths (idea 40)

Exact, but too small to matter: 0.02 ms (0.1%) at 3300 and 0.08 ms (0.45%) at the cap from the grid phase, under the 1% bar. Branch `pl-gridpatch`, base `perf-live` 4e4320f. Step 2 of `gridreuse.md`.

## What

`gridreuse` (step 1) refreshed the shared-phase grid at the tick start only when nobody came or went. Now births and deaths are patched in first.

- `MemberTable.gridEvents`: `admit` notes `(index, row)` and `swapRemove` notes `(~index, 0)` since the last WebAssembly grid build (`markGrid`, called by `gridCrowd`). More than 16 events, or no grid, sets count to -1 and the tick start rebuilds. This replaces `version`/`gridVersion`.
- `crowd.wat` `patch`: replays the events on `owners`, `cellStart`, `occupied`, `cellOf` and the count.
  A birth (index n) goes to the end of its cell's run, later `cellStart` entries +1, `occupied` grows when the cell was empty.
  A death removes the creature from its run, later `cellStart` entries -1; the last creature, which takes the dead one's index, is moved to where that index sorts inside its run.
  Anything that does not fit (index out of order, creature not in its run) returns 0 and the tick start rebuilds.
- `refresh` then runs as before (cell check, re-read of positions, energies and species), so a patched grid equals a fresh rebuild bit for bit.
- Cost: each event is a `cellStart` shift (about 70k cells at the cap, vectorised) plus short `memory.copy` calls; the events are 128 bytes of resident memory.

## Ticks refreshed (60 s, counter not committed)

| Case                    | Refreshed, no event | Refreshed after patch | Rebuilt (cell change, too many events) |
|-------------------------|---------------------|-----------------------|----------------------------------------|
| 4 founders x 800 (3300) | 1433 (80%)          | 342 (19%)             | 25 (1%)                                |
| Juggernaut x 4900 (cap) | 1057 (59%)          | 639 (35%)             | 104 (6%)                               |

Before: 80% and 59% refreshed. Now 99% and 94%.

## Whole tick (liveBench `--profile`, 60 s, nice 19 on cpus 2,3,6,7, 3 alternating pairs, load about 12)

| Case  | Build | cpuMsPerTick                         | crowd grid ms       | peak RSS MB   | fingerprint |
|-------|-------|--------------------------------------|---------------------|---------------|-------------|
| mixed | base  | 14.724, 14.682, 14.367 (med 14.682)  | 0.207, 0.206, 0.198 | 213, 248, 217 | 708687555   |
| mixed | yours | 14.667, 14.499, 14.416 (med 14.499)  | 0.185, 0.181, 0.181 | 218, 218, 219 | 708687555   |
| cap   | base  | 17.870, 17.751, 17.164 (med 17.751)  | 0.479, 0.464, 0.473 | 257, 255, 257 | 10334191    |
| cap   | yours | 17.977, 17.656, 18.063 (med 17.977)  | 0.396, 0.385, 0.403 | 257, 251, 255 | 10334191    |

Ratio of medians 0.987 (mixed) and 1.013 (cap), both inside the run-to-run spread.
The grid phase drops 0.02 ms (0.13% of the tick) and 0.08 ms (0.45%). The patch plus refresh costs about as much as the 0.09 ms refresh plus 0.03-0.05 ms of patching, against 0.40 for a rebuild; the shared-phase rebuild (about 0.3 ms at the cap) stays and is now most of the phase.
A single cellStart pass per tick (batching the events) could save a further 0.03 ms or so; not built.

## Tests

`tests/typescript/wasmCrowd.test.ts`, the gridreuse case extended: between ticks 1 to 4 extra deaths on every 5th tick on top of the tick's own births and deaths, then `prepareTick` and a comparison with a fresh JS rebuild, array for array.
Asserts more than 20 patched refreshes and more than 20 rebuilds; births are asserted only on the bump world (the predator world has about one birth in 300 ticks).
Red with the moved creature placed at the end of its run instead of by index (704 differences, mutant checked). Focused files (wasmCrowd wasmKernels thinkEvery ecoPool residentBodies wasmStep) 119 passed, exit 0; tsc clean. Fingerprints unchanged.

## Verdict

Exact and safe, but 0.1% to 0.45% of the tick for about 190 added lines (wat 138). Suggest skipping: it does not reach the 1% bar and adds a second grid-maintenance path.
