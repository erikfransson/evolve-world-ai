# Startup and pacing at 50000 width

Machine loaded (load average 6 to 13 during runs), so numbers are CPU time where noted. Harness: Node script around `Ecosystem`, `ThinkPool` and `EcoRunner`, 50000 x 28000 world, 10000 founders, 60 pool entries.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Founder genome draws inlined (same mulberry32 stream, Box-Muller in place) | Ecosystem build CPU 2615 ms median (2479 to 2793) | 2486 ms (2381 to 2491), 3 alternating pairs | about 5% of build; 18% on the genome draws alone | Yes: 8 s ecoBench fingerprint 164834199 both ways, micro-bench hashes equal | none | about 16 | Not worth it, gain within noise |
| Lazy founder brains | n/a | n/a | 0 | Yes | n/a | n/a | Rejected by reasoning: every founder steps on tick 1 and the WASM path copies its genome then, so the work moves, it does not go |
| WASM compiled once, instantiated per helper | 2 to 10 ms per `SenseKernels.create` | n/a | under 3 ms per helper | n/a | n/a | n/a | Not worth it |
| Smaller init messages | init packet is the config plus four numbers | n/a | n/a | n/a | n/a | n/a | Nothing to cut |
| Helper start, 3 helpers | 321 ms | n/a | n/a | n/a | n/a | n/a | Bare 3-worker spawn is about 100 ms; the rest is loading the helper module graph. Pre-warm was already rejected in `docs/perf-notes.md` |
| Snapshot item scan over `world.count` | 3.4 ms per snapshot at 125000 slots (3.2% of a 94 ms tick at 10000 creatures) | n/a | up to about 3%, only at this size | would be exact | none | would need World to track live slots | Not worth it |
| Stats at 1 Hz (traitStats filter, offers) | about 23 ms per 1 s message at 10000 creatures (about 2%) | n/a | n/a | n/a | n/a | n/a | Already at 1 Hz; leave |
| Lineage top-k per sample | O(founders) per call, about 0.05 ms | n/a | n/a | n/a | n/a | n/a | Negligible |

## Startup breakdown (50000 wide, 10000 founders, serial)

- Ecosystem constructor 2.4 to 3.3 s wall under this load. Founder genome draws are about 2 s of it (11.9 M weights, 1194 per founder on average; random genome generation measured alone at 2.06 s).
- Math.log and Math.cos alone for 12 M pairs take about 0.73 s, a floor no exact change can remove.
- Pool parse 15 to 35 ms, config 0.5 ms, WASM kernel probe 2 to 10 ms.
- Remaining build work (Brain and Creature objects, `inputLayout` per founder, mutate for pool founders, crowd rebuild, poison clearing) is roughly 0.3 to 0.5 s and spread thin.

## Pacing at Max speed (ecoRunner.ts)

- `pump` runs ticks until a 12 ms slice ends; a snapshot posts after the slice once 33 ms have passed since the last one, and only while fewer than 3 are in flight.
- 50000 wide, 10000 creatures: 68 to 94 ms per tick, so one snapshot per tick (about 11 to 15 per second). Bookkeeping self time: postSnapshot 3.2%, readCreatures 1.0%, popStats per second 2.0%, offers and leaderboard 0.4%. Total about 6.6%.
- 20000 wide, 400 to 1700 creatures: 4 ms per tick, about 9.6 ticks per snapshot, 25 snapshots per second. postSnapshot 1.0% plus stats under 0.5%.
- Samples and lineage top-k run once per simulated second, so they are negligible.

Verdict: the bookkeeping is 1.5% to 7% of worker time, and the largest piece (the item scan) is bounded to about 3% at the biggest size. No change clears the bar. Recommend no merge.

## Harness

Scripts are in the scratchpad (`opt2/startup/`): `startup.ts`, `genome.ts`, `normbench.ts`, `pace.ts`, `ab.sh`. Not in the repo.
