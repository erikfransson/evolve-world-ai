| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines | Verdict |
|------|--------|-------|---------|--------|-----------------|-------|---------|
| Skip the raster loads in `GroundField.valueAt` with a per-node "quiet" flag map (exact) | slots 1.088 ms | 1.07 (2 runs) | 1.00x on the tick | yes, same fingerprint | +0.25 MB | about +6 (scratch) | Rejected, reverted |
| Ground lookup or energy signal moved into WASM | not built | - | - | - | - | - | Rejected on the ablation below |

Branch `pl-prep`, 3200 live seeds, `liveBench --seconds 30 --copies 800 --profile`, load about 11, cpuMsPerTick about 15.9 (fingerprint at 30 s: 654925885).

## Where `prepareRows` time goes (slots phase, ms per tick)
- Base 1.07 to 1.10.
- Ground value forced to 0 (also factor 1): slots 0.46, tick 15.05. Not a clean ablation, the creatures then move differently, but the bound is 0.6 ms (4% of the tick).
- Energy signal forced to 0.5 (no `Math.exp`): slots 0.75 to 0.77, so exp is about 0.33 ms (2%).
- Rest of the loop (field reads, body inputs, stores): about 0.45 ms.

## Why nothing was built
- The raster is 0.5 MB at most, so it sits in L2. Skipping its loads for quiet nodes changed slots by under 0.02 ms: the lookup is not load bound at this size.
- onecall.md already measured the same lookup inside WAT at the same cost as JS, and the exp stays a host import. Storing the ground value from the step kernel does not remove the lookup, and collisions move creatures after the step.
- Best case for any exact variant is below 0.6 ms of 15.9 (under 4%), and the realistic gain is a fraction of that, under the 2% bar.

## Verdict
Reject. No code change kept (`GroundField` restored to the committed file).
