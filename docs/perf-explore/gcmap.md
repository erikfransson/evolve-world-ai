# Garbage collection, per-tick allocations and frame cost (gcmap)

Measurement only, no code change. Bench: `node src/ecoBench.ts --preset inland-sea --pop 10000 --set eco.maxPopulation=12000 --set eco.foodRegrow=0.02 --seconds 15` on origin/development e06ddf8, serial, wasm on. Machine load 15 to 34 during the runs, so absolute times are noisy; ratios are what to read.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| GC pauses, whole run (`--trace-gc`) | 720 ms total, 96 events | not changed | n/a | n/a | n/a | 0 | Measured, about 1.2 to 1.9% of tick time, below 2%. Not worth changing |
| Per-tick allocation hot spots (sampling heap profiler) | 1.21 MB per tick, about 124 B per creature | not changed | n/a | n/a | n/a | 0 | Largest sites each under 0.6% of tick time through GC. Not worth changing |
| Frame encode: hoisted constants, inlined `q16`/`clamp`, one DataView | 7.5 ms | 10.1 ms | 0.74x (slower) | Yes, 0 differing bytes on 10096 creatures | n/a | 0 (scratch only) | Rejected, slower than the repo version |

## GC (`node --trace-gc`, load about 26)

- Scavenge: 63 events, 253 ms total. Steady-state scavenges take 0.3 to 0.7 ms; four large ones between 6 and 9 s take 12 to 34 ms, during set-up.
- Mark-Compact: 33 events, 467 ms total, 9 to 73 ms each. Roughly one every 1.2 s from about 9 s on, so these promote garbage into old space.
- Total pauses 720 ms. Events from 8 s on (set-up is over by then, estimated from the trace) total 446 ms, which is about 1.2% of the 37.3 s tick window. Counting everything, 1.9%.
- Peak RSS over three runs: 340, 370 and 385 MB (the last two with trace or profile flags). The brief baseline said 348 MB.

## Per-tick allocations (sampling heap profiler, 16 KB interval, 450 ticks)

Only stacks under `Ecosystem.step`, so map and pool set-up is excluded (set-up allocates about 0.5 GB).

| Site (self, tick code) | KB per tick | Share of tick allocations | Share of tick time via GC (estimate) |
|------------------------|-------------|---------------------------|--------------------------------------|
| `finishTick` (ecosystem.ts:448) | 383 | 31% | about 0.4 to 0.6% |
| `sharedPhase` (ecosystem.ts:473) | 309 | 25% | about 0.3 to 0.5% |
| `run` (src/sim/wasm/senser.ts:254) | 250 | 21% | about 0.2 to 0.4% |
| `stepBody` (physics.ts:49) | 167 | 14% | about 0.2 to 0.3% |
| all others | under 15 each | under 2% together | |

The GC column is the site's share of bytes times the total GC share, since allocation itself is a bump pointer. The profile does not give line numbers inside a function, so the inlined sources under `finishTick` are not identified. They would need a line-level profile to split further.

## Live frame cost (`readCreatures` and encode, 9516 creatures, median of 31 to 41 runs)

The server sends one creature frame every `FRAME_MS` = 200 ms (server/src/public.ts:20), so five per second.

| Step | Ms per frame | Share of one core at 5 Hz |
|------|--------------|---------------------------|
| `readCreatures` with the reused frame (already reused by liveWorld.ts) | 1.37 | 0.7% |
| `readCreatures` with a fresh frame (for reference) | 1.79 | |
| `eco.get(id)` loop for ages (Map lookup per creature, liveWorld.ts:406) | 1.61 | 0.8% |
| `encodeCreatures` (19-byte records, 191 KB buffer, DataView setters) | 6.76 | 3.4% |
| Frame total | about 9.7 | about 4.9% |

The tick median in the same process was 68.6 ms. The encode step is the only one above 2%. The hoisted candidate in the table above wrote identical bytes but was slower, so the DataView path in the repo stays. Encode allocates a new buffer each frame, which the server keeps for sending, so buffer reuse is not an exact option there.

## Verdict

No change. GC is below 2% of tick time, no allocation site is above 2% through GC, and the one frame cost above 2% (encode, 3.4% at 5 Hz) did not get faster with the candidate. Fingerprints checked: 830514026 for the bench (baseline, trace and profile runs all match). Map-off fingerprints not run because no code changed.

## New ideas, not tried

- Old-space churn: 31 mark-compacts in the tick window, about 414 ms. Finding which objects survive two scavenges (heap snapshot diff) would cap the gain near 1.2%.
- Frame ages: `readCreatures` could fill the age array, and the server's id loop would go, saving about 0.8% per frame. It is server-side work, so it belongs in a separate change.
- Line-level allocation profile inside `finishTick` (about 0.38 MB per tick) to see whether it is the inlined `remember` and `stepBody` path.
