# The per-tick intercept: what is fixed, what is removable (idea 58)

Branch `pl-intercept` (perf-live 057a96c). Study plus two attempted exact cuts, both reverted. Kept: `liveBench --fixed --food` and `server/src/kernelTimers.ts`, so the numbers below can be repeated. Engine unchanged, so the fingerprints are unchanged (708687555 mixed, 10334191 juggernaut cap, thinkEvery pin 81047108; a short default `liveBench --seconds 20 --copies 25` gives 707917969 on both sides).

## Verdict

1. The real fixed cost per tick is about 0.6 ms (0.55 to 0.65 over the fits, 0.9 with the fresh world's 85k items), 11-12% of a tick at 1300 creatures. `late.md` finding 1 (intercept 2.2-2.7 ms, 35%) is not a fixed cost: those fits mixed population with age and machine state. The part beyond 0.6 ms is per-creature cost that rises in the aged runs. Whether that rise is age, clustering or the loaded machine is not separated here (only young creatures were measured).
2. The fixed part is spread thin. The three largest pieces are the crowd grid's `cellStart` fill (0.11-0.14 ms), the item-row patching (0.09) and regrowth (0.07). The other 0.25 ms is about 12 items of 0.01-0.03 ms (JS wrappers around each kernel call, cold after the brain kernel has streamed the weights through the cache).
3. No exact cut reached the 2% bar (0.1 ms at 1300). The two that looked best did not help (below). Nothing merged, nothing to A/B.

## How measured

`liveBench --fixed --food 0.1 --profile` (and `kernelTimers.ts` for the kernel level): births stop at the seeded count, `--food 0.1` gives 20-25k items as in an aged world (`late.md`: 18-24k; the default world starts with 85k). 400 steady ticks after 100 warm-up, at `--copies 25, 100, 325, 800` (mixed, 100 to 3200 seeded) and `--only juggernaut` at 100, 400, 1300, 3200 copies. The population falls by deaths during the run (starvation at the low food setting), so the mean population of the steady ticks is the x of the fit. Phase = least squares F + v x kilo-creatures over the four populations. Pinned to CPUs 2,3,6,7 at nice 19 under load 12-18, so absolute values carry about 5-10% noise. The plain `liveBench --profile` windows cannot give this, because the population grows with births during the run.

## Tick against population (CPU ms per tick)

| World                 | Items  | Populations (mean)       | cpuMsPerTick                    | F (ms) | v (ms per 1000) | F share at 1300 |
|-----------------------|--------|--------------------------|---------------------------------|--------|-----------------|-----------------|
| mixed                 | 20-25k | 86, 321, 1061, 2517      | 0.878, 1.950, 4.847, 10.523     | 0.62   | 3.94            | 10.8%           |
| juggernaut            | 20-25k | 79, 317, 996, 2318       | 0.816, 1.758, 4.095, 8.632      | 0.61   | 3.47            | 11.9%           |
| juggernaut            | 85k    | 100, 400, 1300, 3200     | 0.887, 2.194, 5.606, 12.489     | 0.65   | 3.72            | 11.8%           |
| mixed                 | 85k    | 100, 400, 1300, 3200     | 1.223, 2.684, 6.659, 14.739     | 0.90   | 4.34            | 13.8%           |

The fit residuals are -0.07 to -0.13 ms at the lowest population, so the true intercept is if anything lower (a 4-creature world costs 0.54 ms, half of it off the live code path: JS grid below 12 creatures).

## Table: phase, fixed part, per-creature part (mixed, 20-25k items; juggernaut in brackets)

| Phase            | F ms per tick | v ms per 1000 creatures | What the fixed part is |
|------------------|---------------|-------------------------|------------------------|
| eat              | 0.18 (0.21)   | 0.30 (0.28)             | The second crowd rebuild of the tick (after the move): the `cellStart` fill over 500 x 313 = 156k cells, 0.11 ms in the kernel, 0.04 ms JS around it; touch kernel call 0.02 |
| senser           | 0.16 (0.12)   | 1.27 (1.21)             | `syncItems`: about 15 dirty cells a tick (14.8 regrown, 1.5 eaten), each patched in 3.7 us (shift of the rest of its packed row), 0.06-0.09 ms; JS in `WasmSenser.run` 0.03 |
| regrow           | 0.06 (0.07)   | 0.01 (0.00)             | 14.8 `addRandomly` a tick, 4.7 us each (1.8 spot tries, `touchesRock`, `tooClose`, `setItem`); cache misses on the rock, weight and item grids, the rng stream fixes the work |
| births           | 0.04 (0.03)   | 0.06 (0.05)             | Birth scan call and the rare birth (a birth is 0.3-3 ms) |
| brain forward    | 0.03 (0.05)   | 1.48 (1.10)             | `forwardRun` stamps and the order walk over every held slot |
| memory and steer | 0.03 (0.04)   | 0.44 (0.41)             | `WasmStepper.step` argument block and species rows, 0.02 |
| slots            | 0.02 (0.03)   | 0.13 (0.12)             | `prepare` kernel call and species rows |
| settle and deaths| 0.02 (0.03)   | 0.07 (0.07)             | Settle scan call |
| collisions       | 0.01 (0.00)   | 0.07 (0.09)             | Sweep call |
| hunt, batch build, rest | 0.01 each | 0                    | Lap overhead |
| crowd grid       | 0.00          | 0.13                    | The tick-start grid is a `refresh` (no fill) unless a birth or death changed the members |
| Total            | 0.62 (0.61)   | 3.94 (3.47)             |                         |

Crowd rebuilds per tick (`Ecosystem.gridCrowd` calls): 1.07 at 86 creatures, 1.3 at about 1000, 1.67 at 2500. The extra ones are full rebuilds at the next tick start after a death or birth (`MemberTable.swapRemove` renumbers a member, so the sorted order changes). At 1300 creatures that is about 0.3 rebuilds x 0.4 ms = 0.12 ms, 2.4% of the tick, but not a fixed cost (it grows with the population) and not removable without patching the sorted arrays and `cellStart` (the patch of `cellStart` is as long as the fill).

Kernel level (`kernelTimers.ts`, 90 creatures, timer overhead about 1 us per row): crowd rebuild kernel 0.12-0.14 ms per call (fill; it is 0.139 ms at 100 and 400 creatures alike), `sense` 0.09, `forward` 0.11, `step` 0.03, `fill` 0.02, `prepare` 0.01, `touch` 0.02, `settle` 0.003; wrappers: rebuild +0.04, `WasmSenser.run` minus its kernels and `syncItems` 0.03, `WasmStepper.step` +0.02, `forwardRun` +0.02. The sense, brain, step and fill kernels have no per-call loops over tables (no `memory.fill` over whole tables: the only ones are per creature input and the radix counters); the `cellStart` fill is the only whole-table pass per call.

## Cuts tried

| Cut | Before | After | Exact | Verdict |
|-----|--------|-------|-------|---------|
| `crowd.wat` gap and tail fill 16 cells (four stores) per iteration instead of 4 | micro on a warm grid 131 us per rebuild | 108 us (-18%) | yes, same stores | In the running world the kernel is memory bound (626 KB table evicted between ticks by the brain weights): rebuild kernel 114, 115, 117 us base against 117, 128, 111 us cut in three alternating pairs. Reverted |
| `patchCell`: shift of the row tail and start entries in one `sense.wat` export (three `memory.copy` and an i32 loop) instead of three `copyWithin` and a JS loop | 4.0 us per patch (3.7-4.9) | 7.1-9.4 us (hot micro 2.25 to 6.7 with timers) | yes | Slower: `copyWithin` is 0.3 us a call, a JS loop is slower from 30 elements. Reverted |

Not tried (estimates): incremental grid after a death or birth (at most 1.2% of the tick, touches the sorted arrays, `cellStart` and the order within cells); u16 or row-relative `cellStart` (all readers change, see `crowdsparse.md`); a filter that fills only cells within reach of a creature (reach depends on each plan's ray length, so it is not general); cheaper regrowth (the rng stream and the rejection test fix the work, the cost is cache misses).

## Checks

Vitest `wasmCrowd wasmKernels thinkEvery ecoPool residentBodies wasmStep --testTimeout=180000 --maxWorkers=1` on the final tree (the cuts reverted, `liveBench.ts` and `kernelTimers.ts` added): 6 files, 120 tests passed, exit 0. `liveBench` default run fingerprint equal to the base (707917969). The `kernelTimers.ts` timers are thread CPU time, not wall time.
