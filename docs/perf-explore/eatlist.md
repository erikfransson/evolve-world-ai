# Compact hit list from the touch kernel (idea 103)

Nothing to build: the eat loop already visits only the creatures with a hit. Branch `pl-eatlist`, base `perf-live` e204b2e, no code change.

## What the code does today

`Ecosystem.sharedPhase` (`ecosystem.ts:506-523`) does not walk the members with creature objects. It scans `touched[]` (one Int32Array of n ints, written by the touch kernel) once, collects the indices with `touched[at] >= 0` into `hits` and counts how many are below the random start (`from`), then calls `eat` only for the hits, rotated to start at the random member. So `eatAt` (the only code that reads member and creature objects) runs for the 33-58 creatures a tick that touch an item, in the same order as a walk over every member. The scan reads only `touched[]`, no object.

Per-member work that must run for every member (energy and tick count, death marking) is not in this loop: it is `settle` in the wasm member scan (`scan.settle`), a separate phase ("settle and deaths").

## What a kernel-emitted list could save

- The touch kernel writes in cell order, `touched` is indexed by owner, and the eat order is member-index order rotated by a random start. A list emitted in kernel order would need sorting by owner (or a bitmap plus a scan) to keep the order, so the kernel would do the same scan the JS does.
- A wasm scan of 3300 ints (16 per v128 compare) would take about 2-3 us. The JS scan, measured alone (`scan.mjs`-style microbenchmark: 3300 ints, 58 hits, rotated start, taskset 2,3,6,7, nice 19, warm, 20000 calls): 26 us a tick on the loaded machine, so at most 0.03 ms, 0.2% of the 13-15 ms tick, below the +-2% noise. The eat loop's own cost is 0.065 ms (`eatlive.md`); the 0.27 ms of `scout-js.md` includes about 1 us of timer overhead per call and the cache misses on member and item arrays (`eatAt`, `removeItem`, `World.log`), which a list does not touch.
- Writing the list in the kernel adds an output region, one more store per hit and an `eat` order contract between wat and JS, for a gain that cannot be told apart from noise.

## Numbers

No benchmark pairs: no code differs from `perf-live`. No fingerprint or RSS change (708687555 and 10334191 unchanged by construction). Tests not run (no change).

## Verdict

Reject as already done (the hit list exists in JS) and not worth moving into the kernel: ceiling 0.03 ms (0.2%), unmeasurable. Same family as `touchbatch.md`.
