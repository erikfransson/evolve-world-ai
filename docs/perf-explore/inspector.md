# Inspector: whole live path read and measured for hidden overhead (idea 134)

Branch `pl-inspector`, base `perf-live` a63560d. No code change, study only.
Result: outside the kernels nothing in the engine reaches 1% of the tick. The three server items that do are the stats message (chronicle), the creature frame and the detail refresh, all exact for the simulation and all in the viewer path that idea 131 is budgeting.

## How measured

- `liveBench --seconds 60 --profile --frames` (mixed 3300) and `--only juggernaut --copies 4900 --profile --frames` (cap), plus `node --cpu-prof --cpu-prof-interval 250` on both, last 55% of samples (build and warm-up left out).
- Per-call thread CPU (`process.threadCpuUsage`) of the server's own calls in a harness that seeds like `liveBench` and calls `live.step()`, then `creatureFrame` and `takeDelta` every 18 ticks (5 Hz at speed 3) and `stats` every 90 ticks (1 Hz), 1200-1800 ticks. Mixed 3 runs, cap 2 runs, spread under 10%. Harness and summariser not committed.
- `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, load 16-34 (heavy), so absolute ms are inflated, shares are the useful number. Fingerprints equal to base (708687555 with the `forwardRun` timer in, 10334191 at the cap).

## Where a tick goes (cpu-prof self time, mixed / cap)

| Part                                                 | Mixed  | Cap    |
|------------------------------------------------------|--------|--------|
| brain.wat (`$layer` 31.1 / 26.9, `$compact`, forward) | 36.4%  | 31.4%  |
| sense.wat (`sense` 28.2 / 29.4, helpers, patchItems)  | 29.3%  | 30.2%  |
| crowd.wat: rebuild / touch / pack / sweep / refresh  | 4.5 / 3.8 / 1.6 / 1.3 / 0.9 (12.2%) | 6.2 / 3.8 / 2.6 / 1.7 / 1.1 (15.7%) |
| step.wat (step, rem_pio2, keepOut)                   | 8.9%   | 9.2%   |
| fill.wat (prepare, fill)                             | 5.5%   | 7.0%   |
| members.wat (settle)                                 | 0.5%   | 0.7%   |
| all JavaScript (mixed run with `--frames`, cap run without) | 6.7% | 5.4%  |
| GC, js-to-wasm wrappers, other V8                    | 0.5%   | 0.4%   |

The crowd kernels are 12-16% of the tick, more than the phase table shows: the shared-phase rebuild and the touch kernel sit inside the "eat" phase.

## Candidates at 1% or more (ranked)

| # | Where | Mechanism | Measured cost (mixed / cap) | Change, lines | Exact |
|---|-------|-----------|-----------------------------|---------------|-------|
| 1 | `LiveWorld.creatureFrame` (5 Hz) | per frame: `readCreatures` 0.35-0.8 ms, ages by `eco.get(id)` per creature 0.9-1.1 ms (Map, then member, creature, state, row: cold pointer chase), `encodeCreatures` 1.5-2.7 ms (DataView calls, three float `%`, five `Math.round` per creature) | 2.6 / 3.9-4.3 ms a frame, 0.14 / 0.22-0.24 ms a tick, 1.3% / 1.6% | ages from `table.states[i].ticksAlive` inside `readCreatures`, byte writes in the encoder (idea 11 did this for 0.14 ms when the tick was 15 ms), about 20-40 | yes (sim untouched; wire bytes kept equal) |
| 2 | `LiveWorld.stats` / `Chronicle.observe` (1 Hz) | one 10-16 ms block a second: `Leaderboard.offer` for 4 boards x every creature 3.3-6.5 ms (template-string key, Map lookup, `findIndex` closure, `build` closure, per offer), `namedTop` 3.1-5.3 ms (per living family: `lineageName`, `wireName` regex, key string, Map), best-of scan about 1-3 ms (cold `ageTicks` chain) | 9.8-10.3 / 16.0-16.4 ms a call, 0.11 / 0.18 ms a tick, 1.0% / 1.3% | board lists in an array by board index, offer tested against the list minimum before any lookup, `wireName` cached per family until a rename; about 25-35 | yes (same message) |
| 3 | `LiveWorld.refreshWatched` / `Ecosystem.refreshDetail` (only with followed creatures, up to `detailRefreshesPerSecond` 25) | each followed creature rebuilds the whole crowd grid (`gridCrowd`, 0.42-0.5 ms) before its JS sense, so 5 followed creatures rebuild 5 times between two ticks; plus a `members.findIndex` scan | 0.69 / 0.94 ms a refresh, at 25 a second 0.19 / 0.26 ms a tick (1.6% / 1.8%) | one `prepareTick`-style refresh-or-rebuild per frame before the loop, `byId` instead of `findIndex`; saves 0.75-1.1% at the follower cap, about 0.2% with one follower; about 10 | yes (refresh equals rebuild bit for bit, the detail sense is unchanged) |

All three are server code under the Live push gate and overlap idea 131 (viewer frame path budget); hand them to it rather than building them twice.
Production caveat for #2: a 60 s world has 3200-4900 founder families, an aged one far fewer, so `namedTop` shrinks there, while the offer loop scales with the population and stays.

## Checked and below 1% (measured)

| Item | Cost | Note |
|------|------|------|
| `forwardRun` stamp-and-walk over `held` slots (spares included) | 0.053 ms, 0.46% | idea 112 already found a kernel copy gains nothing |
| `sharedPhase` JS (touched scan, hits list, eat calls) | 0.6% self | idea 103 |
| `syncItems` with `patchCells` (JS list walks plus `patchItems`) | 0.7% incl. | idea 100 |
| `removeItem` plus `setItem` (log, unlink, stamps) | 0.3-0.5% | idea 113 |
| regrow (`randomSpot`, `touchesRock`, `addRandomly`) | 0.5% incl. | `items.md` |
| `takeDelta` with `collectOps` (ItemOp objects) | 0.06-0.1% | |
| tick wrappers in production (`advance`, `await tick()`, timers) | about 1-3 us a tick, under 0.03% | not in liveBench, read and timed by hand |
| per-tick copies of the row lists into wasm (`i32.set` in fill, prepare, step, crowd) | about 13-20 KB a tick, microseconds | |
| GC | 0.05% | `alloc.md` |

Not re-opened, already measured in the campaign: grid patch and move (40, 49), u16 `cellStart` (89), touch skip (35), IO pools (30), step prefetch (`stepparts.md`), ground quiet mask (123).

## Verdict

No exact engine change above 1% is left outside the kernels, whose budgets ideas 125-130 own.
Pass candidates 1-3 to idea 131: together 2.3% (mixed) to 2.9% (cap) of the tick while viewers watch, plus up to 1.8% with followed creatures, for roughly 60-85 lines of exact server code.
