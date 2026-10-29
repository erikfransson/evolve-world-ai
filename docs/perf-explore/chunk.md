# Chunked sense + brain forward (idea 29)

Branch `pl-chunk`. Question: does running the brains right after sensing the same creatures (chunks of 32-512) keep the senser's shared grids in L3 instead of the 24 MB weight stream evicting them every tick?

## What changed (+45 -8, kept for the record)
- `senser.run` takes `chunk` and `after(at, m)`: setup once per tick, then per chunk it points `S_REC`/`S_N` at the chunk's records, calls `sense`, then `after`. The sense kernel keeps no state between records, so one call per chunk is the same as one call.
- `fill.wat` writes the brain slot list in record order (`q`) instead of batch order (`k`), so a record chunk and a slot chunk are the same creatures.
- `BrainBank.forwardChunk(at, m)`: sorts the chunk's slots by block address (Float64Array key sort) and calls `forward` on that part of the list. The global `forwardRun` order walk is O(held) so it cannot run per chunk.
- `EVOLVE_CHUNK` env var (experiment switch, 0 = off).
- Chunks follow the sense order (item grid row), not block address: sensing in address order would scatter the creatures over the item grid and lose the senser's row reuse.

## Measured (liveBench, 60 s, alternating, load 9-13; cpuMsPerTick)

Mixed, 3 rounds (base = perf-live), no profile:

| Chunk | Round 1 | Round 2 | Round 3 | Fingerprint |
|-------|--------:|--------:|--------:|-------------|
| base  | 13.28   | 13.08   | 10.85   | 708687555   |
| 64    | 14.32   | 14.05   | 14.26   | equal       |
| 128   | 14.61   | 13.99   | 14.09   | equal       |
| 256   | 14.36   | 13.08   | 14.19   | equal       |
| 512   | 14.19   | 10.76   | 14.04   | equal       |

Outliers (10.8) are fast-machine phases of the loaded laptop. In the sweep before, chunk 32 gave 14.36 vs 13.02 for chunk 0. Every chunk size costs about +1.0 to +1.3 ms, size barely matters.

Phases, `--profile`, chunk 256 vs base, 3 pairs (ms per tick):

| Case          | cpuMsPerTick base / 256        | senser base / 256          | brain forward base / 256   | Fingerprint | Peak RSS MB |
|---------------|--------------------------------|----------------------------|----------------------------|-------------|-------------|
| mixed         | 12.91 13.10 13.10 / 14.34 14.17 14.40 | 4.77 4.79 4.83 / 4.97 4.92 4.98 | 4.27 4.37 4.32 / 5.43 5.37 5.44 | 708687555 both | 213-218 / 215-217 |
| juggernaut cap| 12.46 15.86 15.91 / 16.15 17.87 17.87 | 4.70 5.97 6.06 / 5.53 6.18 6.21 | 3.45 4.42 4.37 / 5.61 6.18 6.18 | 10334191 both | 253-257 / 251-256 |

Ratio of medians (base / yours): mixed 0.91x, juggernaut 0.89x (both slower).

## Why it loses
- The senser did not get faster (4.8 -> 4.95 ms): its shared structures are evidently not what the brain stream evicts, or the per-chunk restart costs as much as the cold start saves.
- The brain forward got 1.1 ms (25%) slower. A chunk in spatial order holds brains scattered over 24 MB, so the weight stream is sparse (7 KB blocks with gaps, about 7-13 ascending sweeps instead of one) and the kernel's next-block prefetch and DRAM page locality are lost. The global address order of brainorder.md is worth more than the senser cache gain.
- Address-ordered chunks would fix the brain stream but scatter the sense order; not built since the senser showed no cold-start gain to recover.

## Tests
`npx vitest run wasmKernels thinkEvery ecoPool residentBodies wasmStep --testTimeout=180000 --maxWorkers=2` with `EVOLVE_CHUNK=64`: exit 0, 90 passed.

## Verdict suggestion
Reject. Exact, no RSS change, but 9-11% slower on both cases and the mechanism (senser stays warm) did not show up.
