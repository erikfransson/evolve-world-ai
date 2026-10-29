# compactio (idea 30): inputs and outputs out of the weight blocks

What: `WasmBrainBank.set` stores each brain's input and output vectors in two slot pools (1 MiB arena chunks, 64-byte rounded, free lists per size) instead of at the end of its weight block. Descriptor src and dst point there, the weight end moved to the last descriptor word (max 11 layer sizes, was 12; the plan limit is 6) and the `forward` prefetch bound is now that end minus 256. No fixed stride: the largest input is 1024 floats, so a fixed stride would cost 20 MB at 5000 slots.

Measured: liveBench `--seconds 60 --profile`, alternating pairs (base perf-live, compactio), 3 pairs per case, medians.

| case                    | cpuMsPerTick base | yours  | slots | senser | brain forward | memory and steer | peak RSS MB |
| ----------------------- | ----------------- | ------ | ----- | ------ | ------------- | ---------------- | ----------- |
| mixed 800 copies        | 13.15             | 13.07  | 1.047 / 1.045 | 4.816 / 4.824 | 4.333 / 4.323 | 1.158 / 1.130 | 217 / 219 |
| juggernaut 4900 copies  | 15.85 (11.85 noisy) | 15.71 | 1.495 / 1.498 | 6.040 / 5.988 | 4.398 / 4.358 | 1.424 / 1.385 | 252 / 254 |

Fingerprints equal in all 12 runs (708687555, 10334191). Tests wasmKernels thinkEvery ecoPool residentBodies wasmStep liveSaves: exit 0 (116 passed, thinkEvery pin 81047108 unchanged).

Result: mixed -0.6% of the tick, juggernaut -0.9% (within run to run spread, load noise 1 to 4 ms across runs). Memory and steer gains about 0.03 ms, senser and slots nothing. The scattered accesses are not the cold misses assumed, or the hardware already hides them. Below the 2% bar.

Verdict: reject (exact and harmless, but not worth the descriptor limit change). Full suite not run.
