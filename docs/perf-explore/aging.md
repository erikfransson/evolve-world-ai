# Aging: which phases get slower as the live world ages

Branch `pl-aging` (from perf-live 2db77a3), change: `liveBench --profileEvery N` (+16 -2 in `server/src/liveBench.ts`), prints per window of N simulated seconds the mean population, food and every phase in CPU ms per tick per 1000 creatures (`windows`). With it the warm-up is not left out of the phase totals.
Question: `brainorder.md` saw the brain kernel 12% slower at 600 s and the crowd grid, senser and eat 5-9% faster after the fix. Which phases slow down with age, and why?

## How measured
`node src/liveBench.ts --seconds 1800 --copies 800 --profile --every 300 --profileEvery 300`, 4 founders x 800, one run at a time, nice 19. Base = the perf-base worktree (development plus bench, so it lacks every perf-live gain, not only brainorder). Two runs each, fingerprint 847136415 in all four (equal results). Window values below are the mean of the two runs (the pair spread is 1-4%, up to 10% in single phases).
This run is not steady: population falls 3249 -> 1403 (the founders die off, births per capita rise from tick 1200), so late windows mix aging with a shrinking world.

## perf-live, ms per tick per 1000 creatures (mean of 2 runs)

| Window s | Pop  | Food  | Total | Crowd | Slots | Senser | Brain | Mem+steer | Eat   | Births |
|----------|------|-------|-------|-------|-------|--------|-------|-----------|-------|--------|
| 0-300    | 3249 | 24613 | 3.84  | 0.123 | 0.316 | 1.31   | 1.33  | 0.37      | 0.27  | 0.03   |
| 300-600  | 3086 | 18955 | 3.84  | 0.122 | 0.316 | 1.21   | 1.40  | 0.40      | 0.26  | 0.04   |
| 600-900  | 3020 | 15776 | 3.79  | 0.123 | 0.309 | 1.14   | 1.41  | 0.40      | 0.26  | 0.06   |
| 900-1200 | 2956 | 13874 | 3.59  | 0.118 | 0.279 | 1.03   | 1.33  | 0.39      | 0.24  | 0.12   |
| 1200-1500| 1749 | 17571 | 4.38  | 0.141 | 0.337 | 1.24   | 1.68  | 0.42      | 0.28  | 0.18   |
| 1500-1800| 1403 | 17627 | 4.02  | 0.148 | 0.339 | 1.22   | 1.39  | 0.40      | 0.28  | 0.14   |

(Window labels: the window ending at the second shown; the raw JSON labels it `toSec`.) Base, same table: total 4.45, 4.12, 4.55, 4.56, 4.94, 4.47; brain 1.60, 1.54, 1.73, 1.77, 1.95, 1.43; crowd 0.155, 0.148, 0.162, 0.163, 0.208, 0.230; senser 1.58, 1.36, 1.47, 1.42, 1.47, 1.34.
Run totals (cpuMsPerTick, cpuMsPerKilo, peak RSS MB): perf-live 9.22 / 9.10, 3.90 / 3.84, 373-375; base 10.73 / 10.88, 4.54 / 4.60, 299.

## Findings
1. Aging in this world is small. Brain forward is the only phase that drifts: +6% from 0-300 s to 600-900 s on perf-live (1.33 -> 1.41), +8% on base (1.60 -> 1.73), consistent with the address-order drift in `brainorder.md` (which acts mostly in the first 1000 s here, then more founders die). Base minus perf-live at the same age is 0.27 ms/kilo at 0-300 s and 0.32 at 600-900 s, so brainorder's share is small compared with the other perf-live gains.
2. Crowd grid, slots (prepareRows), memory and steer, eat are flat from 0 to 1200 s (crowd 0.123, 0.122, 0.123, 0.118). So rows drifting out of batch order does not slow the fill, sense or step kernels measurably. The 5-9% faster crowd/senser/eat in the 600 s brainorder pairs is not aging, it is run-to-run noise (repeat spread here 1-4% in totals, up to 10% in single phases at load 9-16).
3. Senser follows the food count, not age: 1.31 -> 1.03 ms/kilo while food falls 24.6k -> 13.9k, then 1.24 when food returns to 17.6k. This is the item grid size (cells hold fewer items), not `rowCap` growth. Not separated from population density by a counter.
4. The late rise (1200-1800 s) is the population falling to 1400: per-tick fixed costs (crowd grid 0.12 -> 0.15, slots, regrow, births per capita 0.03 -> 0.14) spread over fewer creatures. Per-creature work (brain, eat, memory) does not rise beyond noise.
5. Not measured with counters: lineage table and GC. Peak RSS is 373 MB (perf-live) after 1800 s vs 214 MB at 60 s; base is 299 MB, so perf-live's extra memory (not aging) is 75 MB; no phase appears to slow with heap growth.

## Cheapest exact fixes
- Brain order: already done (`brainorder`). The remaining +6% is small, only a periodic compaction of the weight arena (re-pack every N ticks) could remove it, bounded gain below 0.1 ms/kilo; not worth it.
- Row or arena drift in crowd, senser, eat: nothing to fix, no measurable effect.
- Senser vs food: no fix needed, a lower food count helps by itself.

## Verdict suggestion
Keep `--profileEvery` (bench only, results unchanged). No aging fix beyond brainorder is worth building; to test longer ages (hours) use `--seconds 7200` runs with this option, population steadiness depends on the founders.
