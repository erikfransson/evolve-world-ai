# Churn: births, deaths and records at 9-10k creatures

Setup: `ecoBench --width 50000 --seconds 20 --threads 0`, 600 ticks, mean population 9420, about 345 births and 3780 deaths in the run. Times are wall-clock inside one unchanged run (machine load 7 to 17), so read the shares, not the absolute ms. Instrumentation is a preload script outside the repo (`--import`), which wraps `giveBirth`, `remove`, `Creature.reset`, `Lineages.born/died` and emulates the live runner's per-death and per-second record work (`ecoRunner.ts`).

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Births (copy, mutate, spawn, traits) | 0.22 ms per birth, 0.18% of step | n/a | n/a | n/a | n/a | 0 | Below 2%, left alone |
| Deaths (`remove`, slot recycling) | 0.012 ms per death, 0.11% of step | n/a | n/a | n/a | n/a | 0 | Below 2%, left alone |
| Death records (`onDeath` offers) | 0.0075 ms per death, 0.07% of step | n/a | n/a | n/a | n/a | 0 | Below 2%, left alone |
| Per-second record offers, all creatures | 0.4% of step | n/a | n/a | n/a | n/a | 0 | Below 2%, left alone |
| Per-second `traitStats` (page histograms) | 45 ms per call, 1.6 to 1.8% of step per sim second | 33 ms per call, 1.3% of step | 1.35x on this part | Yes: 20 of 20 calls equal to the old output | +0.7 MB retained scratch at 10k (estimate, not measured) | +14 / -6 | Merge |
| GC pauses (22 scavenges, 15 mark-compacts) | 240 to 256 ms in 600 ticks, about 0.55% of step | n/a | n/a | n/a | n/a | 0 | Below 2%, left alone |

Notes:

- The per-second block runs once per sim second here (30 ticks). In the live runner it runs once per wall second (`LINEAGE_MS`), so its share of page-worker time is larger than its share of a tick. At the measured cost that is about 4% of worker time before the change and about 3% after.
- The change: `traitStats` in `sim/popStats.ts` keeps one reused `Float64Array` of values instead of allocating a value array per trait. Same arithmetic order, so the means and bins are identical.
- Not measured: a separate WASM brain-bank cost at birth (inside `giveBirth`, not split out), and the `filter`/`map` that builds the per-species plan lists (about 4 ms per second, 0.2% of step).
- The remaining cost of the trait block is the `TRAITS[k].of` calls (about 85k per call at 9.4k creatures). Cutting it further means changing when the block runs (the runner's cadence), which changes the page output timing, not the sim, so it is left for a separate decision.
- Fingerprints are unchanged by this branch because `ecoBench` does not call `traitStats`; the check is run on the branch (see the report).
