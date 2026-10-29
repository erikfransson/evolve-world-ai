# Batch the touch kernel per tick (idea 98)

Nothing to build: the touch is already one JS-to-wasm call per tick. Branch `pl-touchbatch`, base `perf-live` 538804e, no code change.

## What the code does today

- `Ecosystem.sharedPhase` calls `crowd.kernel.touch(...)` once per tick (`ecosystem.ts:501`, the only call site). `crowdKernel.ts` `touch` sets 8 parameters and calls `exports.touch(C)` once, then copies `n` ints into `lookups`.
- `crowd.wat` `touch` loops over all `n` creatures in cell order and calls `$firstItem` (a wasm-internal call) per creature, writing `touchOut[owner]`. The "2500 calls per tick" of `touchbit.md` are these in-kernel `firstItem` calls (about 3300 a tick), not boundary crossings.
- The eat loop only reads `touched[]`. The same-tick dependency is already handled: lookups run before the eat loop on the grid at that moment, and `Contacts.eatAt` re-queries (`creature.eat`) only when the looked-up item was removed by an earlier creature. Items are only removed inside the eat loop, so a looked-up item still there is still the first touched, and -1 stays -1.

## Cost left

Boundary cost per tick: 8 stores, one call, one 3300-int copy, about 2-3 us (under 0.02% of 13-15 ms). The wasm-internal call per creature is a few ns of 150 ns; inlining `firstItem` into the loop would save well under 10 us a tick. The 0.41-0.50 ms of the touch is the window arithmetic and row walk itself (`touchbit.md`: arithmetic only 0.19 ms warm, `touchskip.md`: skipping costs the sense kernel as much as it saves).

## Verdict

Reject as already done. No benchmark pairs run since no code differs from `perf-live`. Remaining touch ideas are the rejected ones: `touchbit.md` (bitmap pre-reject), `touchskip.md` (clearance record), `occgate.md`.
