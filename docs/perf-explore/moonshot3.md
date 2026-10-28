# Moonshot 3: architectures for a 1.5-3x tick (idea 135, scout)

Branch `pl-moonshot3` from `perf-live` a63560d, docs only. Probes and patches are in the session scratchpad `ms3/` (not committed).
Question: which rewrite could make the live tick 1.5-3x faster on one thread, exact or under a rule change Erik could accept, with the ecology unchanged.

## How measured
- Kernel harness `ms3/harness2.ts` (from the senser budget harness `sb/harness.ts`): the live world run to call 300 (also 1500), then `sense.wat` variants timed alternately on the same state, 150 reps, p25, 32 MB sweep before each call (a warm run without the sweep gives the same gaps). Brain inputs hashed per variant: equal hash means exact.
- Count probe `ms3/counts.ts`: poses, list sizes, rebuild and invalidation rates over 30-40 consecutive ticks.
- Brain microbench `ms3/bbench.ts`: today's `brain.wat` forward against a fixed-point probe kernel `ms3/ibrain.wat` on a synthetic live-like population (1600 x 55-12-12-4, 800 x 55-16-16-4, 800 x 93-24-24-24-24-18, about 10 non-zero first-layer inputs, blocks back to back).
- `liveBench --seconds 60 --profile` for the one rule-change probe (`ms3/senseEvery.patch`).
- All runs `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, load 20-34 on 8 cores, so absolute ms are inflated and the ratios are what counts.

## Where an exact single-thread rewrite tops out
The tick is 10.4 ms mixed on a quiet machine: senser 3.9, brain 3.9, step 0.9, eat 0.9, rest 0.8.
The brain is instruction-bound once its stream is packed: on the synthetic population with blocks back to back the kernel costs 3.92 ms cold (live brain phase 3.9 to 4.4), and a population that fits in cache runs only 20% faster warm. Every brain has its own weights, so batching across creatures cannot reuse a weight load, and the add order per output is fixed. What is left is fewer instructions per multiply-add: quad lanes (1.06-1.20x brain, parked), the tidy bundle of idea 127, or the native AVX2 kernel (1.16-1.20x on the brain phase in the tick, parked).
The senser is an algorithm, so its method is free as long as each ray's nearest hit and candidate order are kept. That is where the exact headroom is.

| Part     | Today (quiet) | Best exact (estimate)                                                        |
|----------|--------------:|------------------------------------------------------------------------------|
| senser   | 3.9           | 2.5-2.9 (kernel 3.6 to 2.2-2.6: idea 1 measured, 1b estimated)               |
| brain    | 3.9           | 3.2-3.5 (quad lanes on split blocks and the tidy bundle, or the native kernel) |
| the rest | 2.6           | 2.3-2.5 (`smallphases2.md` bundle)                                           |
| tick     | 10.4          | 8.0-8.9 ms, 1.17-1.3x                                                        |

So 1.5x exact on one thread is out of reach with any rewrite found here. A factor of 1.5 or more needs a rule change (`dt` 1/20 gives 1.5x on its own and multiplies with all of the above, so about 1.75-1.95x together) or the helper threads on a host with spare cores.

## Ideas, ranked

### 1. Record-ordered candidate lists for the item walk (exact, measured)
Each creature keeps the items within `L + r + s` (skin s) of an anchor position, copied as (f32 x, f32 y, index) in today's walk order. The kernel scans this list with today's distance and wedge tests instead of walking the grid rows. The list stays valid while the creature is within s of its anchor and no item cell in its window changed (a dilated dirty stamp from `syncItems`). The pool is double-buffered: each tick the kernel reads a creature's list from last tick's pool and writes it, or a rebuilt one, to the next pool in this tick's record order, so the lists stream in the order the kernel reads them.
Exact: the list is a superset of today's kept candidates in the same order, and the same f32 positions and f64 tests decide. The real version should also keep today's window test in the scan, so an item at the f64 edge of the window is treated as today.

Counts (per creature, mean over 30-40 ticks):

| Case            | Rows today | Entries today | Kept | List s=20 / rebuilds per tick | List s=40 / rebuilds per tick | Rebuilds from moves / dirty cells, s=40 |
|-----------------|-----------:|--------------:|-----:|-------------------------------|-------------------------------|-----------------------------------------|
| mixed, tick 300 | 4.47       | 8.15          | 2.28 | 4.56 / 10.9%                  | 5.58 / 5.7%                   | 3.5% / 2.1%                             |
| mixed, tick 1500| 4.47       | 4.96          | 1.46 | 2.81 / 10.1%                  | 3.41 / 4.4%                   | 2.8% / 1.4%                             |
| cap, tick 300   | 4.46       | 7.13          | 1.38 | 3.98 / 11.1%                  | 4.90 / 5.3%                   | 2.7% / 2.4%                             |

Creatures run near top speed (median 2.6 units per tick, none stationary), so the skin sets the rebuild rate. Dirty cells (43-77 per tick) sit where creatures eat, so 1.4-2.4% of the lists lose an item each tick.

Kernel p25 change against the base of the same run, in ms (hash equal to base in every row). Bases: run 1 3.53 mixed / 4.52 cap, run 2 3.53 / 4.43, run 3 (tick 1500) 2.92.

| Variant                                                        | Run | Mixed t300 | Cap t300 | Mixed t1500 |
|----------------------------------------------------------------|----:|-----------:|---------:|------------:|
| W: today's window entries as one list, no rows                 | 1   | -0.71      | -0.92    |             |
| V20: list with skin 20, contiguous in record order             | 1   | -0.88      | -1.14    |             |
| V40                                                            | 1   |            | -1.09    |             |
| S20: same lists in per-creature slots (scattered)              | 1   | -0.43      | -0.47    |             |
| K: exactly the kept items (bound for a free walk)              | 1   | -1.01      | -1.36    |             |
| V20                                                            | 2   | -0.90      | -1.08    | -0.67 (run 3) |
| V20 plus the copy into the next pool                           | 2   | -0.91      | -1.11    |             |
| plus a rebuild walk for every 9th creature (11%, skin 20)      | 2   | -0.59      | -0.71    | -0.44 (run 3) |
| plus a rebuild walk for every 18th creature (5.5%, skin 40)    | 2   | -0.68      | -0.78    | -0.50 (run 3) |

- The row walk, not the entries, is the cost: the same entries as one list save 0.7-0.9 ms. Dropping every entry that is not kept (K) saves only 0.13-0.22 ms more than V20.
- Layout decides it. Scattered per-creature slots lose half of the gain (S20). This is why idea 28 (`raycache.md`, per-row cache slots, whole cells, 9-11 entries) found only 0.2 ms.
- The copy into the next pool is free. A rebuild walk costs 0.75-0.9 us, about three times today's per-creature walk, because a lone rebuild has no neighbour warming its rows.
- Net at a 5.5% rebuild rate: -0.68 ms mixed (19% of the kernel), -0.78 ms cap (18%), -0.50 ms at tick 1500 (17%). That is about 6-7% of the quiet tick, bit-identical.
- More to take: an alive bit per item id (with a generation byte) lets eaten items drop out of every list without a rebuild, which leaves moves and regrowth (about 3.5-4% at s=40). Due rebuilds could also run as one batch in cell order, so neighbours warm each other's rows.

Rewrite: about 300 lines (list scan, rebuild walk and pool in `sense.wat`, pools, stamps and alive bits in `senser.ts`, a differential test that goes red without the dirty stamp). Memory: two pools of about 6 entries of 16 bytes per creature, under 1 MB at 5000.
General: skin from top speed times dt, any ray length (the list radius follows each creature's L), ray count and item radius. Lists over a fixed capacity fall back to the walk.
First prototype: lists built in JS each tick from real anchors (an oracle maintenance) to check that the kernel gain survives in `liveBench` pairs, then the kernel-side maintenance, hash-equal at calls 300, 1000 and 1800, 3 pairs per case plus a 600 s run.

### 1b. The rest of a senser rewrite on the same lists (exact, estimated)
- Candidate-to-ray assignment: one conservative angular range per kept candidate instead of the pairwise prefilter over every ray group (11 group tests per creature today, about 1.6 rays per candidate pass). Superset proof needed, like idea 130's f32 prefilter, which is the first step of this. Estimate -0.3 ms of the 0.78 ms ray-test stage.
- Crowd lists: the same scheme for creature candidates. They move too, so a skin of 20 holds for about 4 ticks (about 25% rebuilds per tick), and entries need an id-to-slot lookup and a sort by crowd cell to keep the candidate order. Estimate -0.2 ms mixed, -0.35 ms cap of the 0.65-1.06 ms crowd stages.
- Rock discs: static, but `rockcost.md` already measured per-cell rock lists at -0.05 ms. Not worth a separate list.
Together with idea 1 the sense kernel would go from about 3.6 to 2.2-2.6 ms (1.4-1.6x), the tick 1.1-1.15x.

### 2. Fixed-point brains (rule change, measured, not recommended)
Weights and activations as i16, `i32x4.dot_i16x8_s` with i32 sums (associative, so any blocking and zero-skip is exact by construction and bit-equal across engines), tanh from a table.

| Population (synthetic)        | f32 `brain.wat` p25 ms | i16 probe p25 ms | Ratio |
|-------------------------------|-----------------------:|-----------------:|------:|
| live-like mix, 3200 brains    | 3.92                   | 3.17             | 1.24  |
| same, activation left out     | 3.84                   | 2.77             | 1.38  |
| 3200 x 93-24-24-24-24-18      | 8.93                   | 6.62             | 1.35  |
| 3200 x 55-12-12-4             | 2.26                   | 2.07             | 1.09  |

The small brains, the most common shape, gain little: they are bound by per-output reduction and activation, not by multiply-adds. It would need weights clamped to about plus or minus 16 and quantised to 1/2048, new pins and a fresh world, for about 1.08x per tick. The parked native kernel gives as much exactly.

### 3. Half-rate rays with the brain every tick (rule change, measured, rejected)
Each creature casts its rays on one tick in two (staggered), and its brain runs every tick on the held ray features with fresh body inputs and memory. This avoids the delayed self-feedback that shifted the ecology under `thinkEvery` 2.
One 60 s pair (mixed): tick 11.67 to 10.35 ms (1.13x), senser 4.09 to 2.89 ms. The kernel only drops 29% for half the creatures, because the sensed half no longer has its neighbours warming the rows. That is less than `dt` 1/20 (1.5x) with a milder ecology shift, so this was not given a behaviour run.

### 4. One fused pass per creature (sense, brain, step) in cell order (rejected on earlier evidence, not built)
`chunk.md` and `residency.md` (3) show the brain inputs are not evicted between the passes, and the brain wants one ascending stream, which spatial order breaks (+25% brain). The pass overheads it could remove (slots 0.3 ms, part of fill) bound it at about 3%, and a block order that follows the spatial order would need the arena to re-sort every few hundred ticks.

## Verdict suggestion
- Build idea 1 as the next exact senser change. It is the largest exact lever found since batch 14 (about 6-7% of the tick measured with its rebuild cost, more with alive bits) and the base for 1b.
- 1b is the senser moonshot proper. Take it after idea 130 reports, since the angular assignment extends its prefilter proof.
- For 1.5x and beyond: an exact single thread stops at about 1.2-1.3x with everything found here. Only `dt` 1/20 (to about 1.75-1.95x together) or helper threads on the host go further. Both are Erik's call.
- Fixed-point brains and half-rate rays give less than the rule changes Erik already has on the table. Do not pursue them.
