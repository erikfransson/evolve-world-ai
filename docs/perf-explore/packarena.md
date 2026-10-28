# Dense brain stream: chunked brain arena with compaction (idea 116)

Branch `pl-packarena` (from perf-live eae5208). Question: `pagepack.md` measured plain back-to-back packing of the weight blocks 1.5-4.6% faster for the brain kernel than the real layout. Can the live arena be kept dense, exactly?

## Fragmentation of the real layout (liveBench `--copies 800`, hook at the brain run, run-order neighbours; scratch hook, not committed)
A gap is the bytes from the end of one block's weights to the start of the next block's weights in run (address) order, which the touch stream has to cross.

| Sim time | Blocks | Weights MB | Gap MB (share of stream) | In/out vectors | 256 B rounding | Free-list blocks | Foreign (rows, tables, units) | Gap median / p90 / p99 B | Gaps over 4 KB (MB of gaps over 1 KB) | Free list total | Out of address order |
|----------|--------|------------|--------------------------|----------------|----------------|------------------|-------------------------------|--------------------------|---------------------------------------|-----------------|----------------------|
| 600 s    | 3253   | 25.2       | 20.4 (44.8%)             | 0.94 MB        | 0.29 MB        | 0.02 MB          | 19.2 MB                       | 688 / 4672 / 12864       | 354 (18.6)                            | 416 blocks, 1.9 MB | 0 (run order is address order, brainorder.md) |
| 1800 s   | 1559   | 9.3        | 40.5 (81.3%)             | 0.41 MB        | 0.14 MB        | 5.6 MB           | 34.3 MB                       | 688 / 45760 / 182736     | 889 (40.2)                            | 5206 blocks, 23.1 MB | 0 |

The gap median of 688 B is a 256 B units block plus the block's own in/out vectors plus rounding. At 1800 s the population fell from 3300 to 1559 (the crash of the 1800 s pin), so the free lists (23 MB) and the foreign blocks between brains dominate. The few gaps over 1 KB hold nearly all the gap bytes (they are rows, tables and free blocks); how much of that the stream pays is the 1.5-4.6% of pagepack.

## What changed
`brainKernel.ts` (+97 -11), `senseKernels.ts` (+14 -2), a test in `wasmKernels.test.ts`.
- Brain blocks no longer come from the shared arena's size classes. `WasmBrainBank` takes 1 MiB chunks from the arena and bump-allocates blocks in them (64 B aligned, exact size, no 256 B classes), so brain blocks sit back to back and only brains are inside a chunk. A larger block gets a chunk of its own. A new block goes to the first chunk with room at its end.
- `release` leaves a hole in the chunk (a hole at the chunk end just lowers the end). `compact()` slides the live blocks of the chunk with the most hole (over 1/16 of its used bytes) down over its holes, one chunk per call; `place` slides the chunk with the most hole when no chunk has room at its end, before taking a new chunk. A block moves by copying its whole bytes (weights, inputs, outputs), so the weights are unchanged; the descriptor, `inFloat`/`outFloat` and the sorted run order (relative order does not change) stay valid.
- A moved block changes the input address in its resident row and the output address in its creature: `onMove` tells `SenseKernels`, which keeps the creature per slot (`owners`) and rebinds it with the same code as `attach`. `runRows` calls `compact()` at its start (before the fill writes the inputs). Helper threads and the save path read the addresses through the creature and the row, so they see the new ones; helpers own their own kernels and memory.
- Cost per tick: a loop over about 30 chunks; a slide is a memmove of at most 1 MiB, in practice a few blocks.

## Measured
`liveBench` `--profile`, alternating base (perf-live worktree) and packarena pairs, `taskset 2,3,6,7`, load 8-13 (phase times move 10-20% with the load between runs, so the brain-forward to senser ratio is also given; the senser is untouched).

| Case | cpuMsPerTick base / new | brain forward base / new | brain / senser base / new | peakRssMB base / new | Fingerprint |
|------|-------------------------|--------------------------|---------------------------|----------------------|-------------|
| mixed, 60 s, 3 pairs | 10.61, 10.59, 10.98 / 10.22, 9.04, 11.16 | 4.01, 4.02, 4.15 / 3.89, 3.42, 4.24 | 1.038, 1.040, 1.036 / 1.062, 1.034, 1.049 | 216, 218, 216 / 220, 214, 221 | 708687555 both |
| juggernaut 4900, 60 s, 3 pairs | 11.44, 11.07, 10.93 / 11.11, 11.10, 11.05 | 3.62, 3.49, 3.49 / 3.44, 3.44, 3.42 | 0.815, 0.809, 0.836 / 0.789, 0.791, 0.789 | 255, 255, 255 / 253, 253, 255 | 10334191 both |
| mixed, 600 s, 3 pairs | 8.37, 8.25, 7.89 / 7.92, 9.06, 9.82 | 3.44, 3.43, 3.27 / 3.25, 3.70, 3.95 | 1.286, 1.303, 1.292 / 1.280, 1.276, 1.245 | 257, 243, 229 / 254, 224, 242 | 164690887 both |
| mixed, 1800 s, 2 pairs | 5.96, 5.92 / 5.80, 5.93 | 2.50, 2.48 / 2.41, 2.48 | 1.414, 1.413 / 1.394, 1.408 | 294, 280 / 289, 286 | 847136415 both |

Medians of the brain / senser ratio: mixed 60 s 1.038 to 1.049 (nothing), juggernaut 0.815 to 0.790 (-3.0%), mixed 600 s 1.292 to 1.276 (-1.2%), mixed 1800 s 1.414 to 1.401 (-0.9%, two pairs). The final code (with the `place` slide) ran once more at 1800 s (5.84 ms, ratio 1.418, fingerprint 847136415), 60 s mixed (708687555) and 60 s juggernaut (10334191): same fingerprints.
Fragmentation after the change (same hook, 600 s / 1800 s): gap median 256 B (was 688), p90 464 B (was 4672); gaps over 1 KB 104 / 96 (was 414 / 913); gaps over 4 KB 74 / 72 (was 354 / 889); the free list holds 10 / 2642 small blocks (0.3 / 0.9 MB) for the other users. What remains: the in/out vectors of the large-input brains (3.8-18.7 KB inside the block, the compactio.md idea), and one restart per chunk (a chunk is 1 MiB; after the crash the chunks hold 20-200 KB each, so about 18 of them mean a 1 MB gap per 100 KB). The wasm memory top at 1800 s is 45.9 MB against 49.9 MB.

Tests: `vitest run wasm thinkEvery ecoPool brain resident ecosystem --maxWorkers=2 --testTimeout=180000` 207 passed, exit 0; `tsc --noEmit` exit 0. New test in wasmKernels ("compact() closes the holes ...") checks outputs equal before and after, moved slots reported, nothing moved the second time. The existing "kernel resources of dropped creatures" test (arena top flat over crash-and-regrow cycles) failed with compaction limited to one chunk per tick (+1 MiB per cycle); the `place` slide fixed it.

## Verdict suggestion
Exact (four fingerprints equal), no peak RSS change, the wasm top 4 MB lower at 1800 s, but the gain is 0 to 3% of the brain phase (0.03-0.1 ms), under 1% of the tick and inside the load noise of this machine. Park: it does not clear the 1.5% tick bar, and it adds 111 lines and a rebinding path (moved blocks) that the bank did not have. If the 4 KB-19 KB in/out vectors of large-input brains were moved out of the blocks as well, the remaining gaps would close, but compactio.md found that move alone worth 0.6-0.9%.
