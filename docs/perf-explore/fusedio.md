| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| (a) `remember()` writes the memory units into the brain input; fill skips them | 63.9 ms/tick | 63.5 | 1.01x (noise) | yes | +0 | +24 | Not worth it |
| (b) ground value read in the move pass (`steer`, `move`) | 63.9 | 63.5 | 1.01x (noise) | yes | +0 | +2 | Not worth it |
| (c) y recorded in the slots loop, `placeByRow` reads a Float64Array | 63.9 | 62.4 | 1.02x (noise) | yes | +0 | +8 | Not worth it |
| a + b + c | 63.9 | 63.4 | 1.01x (noise) | yes | +0 | +34 | Not worth it |

Branch `fusedio` (parts: `fusedio-a`, `-b`, `-c`) on origin/development f1ebe53. Inland Sea, 10000 creatures, serial, wasm on, 12 s, 4 alternating rounds, median cpuMsPerTick, load 13 to 18 (noise about +-3%). Individual runs: base 61.5 to 66.8, abc 61.8 to 63.8.
Exactness: map-off fingerprints 739359978, 877945501 (wasm=false), 410981010 (predators), Trials 727564408 and Inland 15 s 830514026 all equal to base. The Inland 12 s fingerprint is equal across all five variants. vitest wasmKernels, creature and ecosystem pass.
(a) is invalidated through `inputReset()` when `slotOf` sets a new brain (which zeroes the input) and cleared on `reset`, `setMemory` and `decide`. The first fill after spawn, insert or restore copies as before. (b) is safe after collisions because `ground()` is keyed on position.
Conclusion: the fill loop cost is object reads in general. Moving three of them elsewhere moves the cost instead of removing it.
