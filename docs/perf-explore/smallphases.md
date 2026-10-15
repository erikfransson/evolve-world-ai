| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Birth scan reads `birthEnergies`, a plain-array mirror of `members[i].birth.energy` kept beside `states` and `kinds`; cooldown read only for creatures past the energy test | births 1.29 ms (median of 3 pairs) | 0.77 ms | 1.7x on the phase, about 0.5 ms of 71 ms per tick | yes, all fingerprints equal | none (median 344 to 340 MB) | 13 added, 2 removed | Merge |
| Crowd grid: fuse the states copy into the cell pass | 2.36 ms (micro, 9760 creatures, 100000 cells) | not built | at most 0.3 ms | | | | Not worth it, copy is 0.3 of 2.4 ms |
| Crowd grid: unconditional `fill` for every gap | 2.47 ms (A/B, 6 rounds) | 2.95 ms | none, slower | yes | | | Rejected |
| Crowd grid: gap loop without the `> 32` fill branch | 2.47 ms (A/B, 6 rounds) | 2.43 ms | 1.02x, noise | yes | | | Rejected, no gain |
| Slots: second warm pass over the same creatures | 1.0 ms first pass | 0.84 ms warm pass | n/a | n/a | n/a | n/a | Probe only, reverted. Cost is per-creature JS, not first-touch misses |

Benchmark: `node src/ecoBench.ts --preset inland-sea --pop 10000 --set eco.maxPopulation=12000 --set eco.foodRegrow=0.02 --seconds 15 --profile`, serial, wasm on, nice 19 under `bench.sh`. Baseline is origin/development 6ee394f copied from HEAD, A/B alternating, 3 pairs. Whole-tick cpuMsPerTick was 72.96, 71.85, 68.06 (median 71.85) before and 69.73, 70.96, 74.08 (median 70.96) after, so the whole-tick gain is inside the noise, about 1 to 2 percent. Load average during the pairs was 17 to 22 on 8 cores.

## Findings

- Crowd grid at 9760 creatures on the Inland Sea (cell 100, 100000 cells, 9277 occupied): micro breakdown per rebuild was cellIndex 0.47 ms, radix passes 0.47 ms, gather 0.40 ms, cellStart gap writes about 0.6 ms (the loop over cells is the cost of dense `cellStart`, about 10 cells written per occupied cell), states copy 0.3 ms. Each part is a small fraction and the dense `cellStart` is what the sense kernel and castRays read as contiguous ranges, so a real cut needs a sparse cell index. That changes readers in `castRays`, `anyWithin` and the WASM sense kernel, so it is not a small exact change.
- Slots phase is `slotOf` per creature: it reads `kernelOwner`, `kernelSlot`, `brainVersion` and `versions[slot]`. A warm second pass costs 0.84 ms, so it is JS work per creature, not cache misses on first touch. Moving it into the batch build only moves the cost.
- Births: the old scan touched `members[i]`, its `creature`, `creature.state` and `birth` objects for every member. The mirror keeps the energy test to `states[i]` and `birthEnergies[i]`. The mirror is set in `setBirth` (after `spawn`), pushed in `spawn` and `restoreMember`, and swapped and popped in `remove`, the same places `kinds` changes.

## Checks

Fingerprints equal to baseline: Inland bench 830514026, `ecoBench --seconds 30 --pop 600` 739359978, same with `--set eco.wasm=false` 877945501, `--predators --seconds 40` 410981010, `src/bench.ts --pop 300 --gens 12 --seed 2` 727564408.
Vitest full suite: 891 passed (88 live tests need `server/node_modules` symlinked into the worktree to load). `npx tsc --noEmit`: only errors in `server/` from the missing `ws` module in the worktree, none in `src/`.

## Not tried

- Sparse crowd cell index (occupied cells with per-row offsets) to drop the cell-linear `cellStart` writes, about 0.6 ms per tick at this density. Touches the sense kernel, so needs its own write-up.
- Energy mirror as a typed array updated by eat, hurt and metabolism, so settle and births scan one typed array. Many write sites, so larger than this change.
