# Per-cell gather of the item and crowd candidates (idea 110)

Study only, no code change. Branch `pl-cellgather` from `perf-live` 6858a11 (no engine diff).

## Idea

Today every creature walks the grid rows of its own window, once for items (f64 window) and once for the crowd (f32 window).
The prototype would group the creatures that share a cell (consecutive in the record order since `cellorder.md`), walk the union window of the group once into a scratch list in row order, then run each creature's distance and wedge tests over its own rows of that list with a column filter, which keeps the candidate order exact.
It saves row visits only when cells hold more than one creature, and it adds the copy into the scratch list plus the extra entries of the wider union columns.

## How measured

Scratch script (scratchpad `cellgather/count.ts`) hooks `WasmSenser`'s `sense` call and reads the kernel's own param block and records at 15 ticks (tick 400 to 1800 after the start, every 100).
Windows are recomputed exactly as `sense.wat` does (f64 item window, f32 crowd window, same clamps), entries are counted from the packed `itemStart` and `cStart` tables.
Groups: cell = creatures in the same item cell (cell 100, 500 x 313 cells), counted both as consecutive runs of records (what a kernel sees) and as all members of a cell (identical numbers, so the record order already makes every cell one run).
Block = all creatures of a 3 x 3 cell block, an upper bound that would need a block-major record order.
Cases: mixed (4 founders x 800), juggernaut x 4900, aged save of `aged.md` (`--load`, 1300 creatures).
All numbers per creature with rays, mean over the 15 ticks.

## Creatures per group

| Case       | Mean pop | Alone in cell (share of creatures) | 2 in cell | Groups per creature, cell / block | Alone in 3x3 block | 2 in block | 3+ in block |
|------------|---------:|-----------------------------------:|----------:|-----------------------------------|-------------------:|-----------:|------------:|
| mixed      | 3307     | 96.9%                              | 3.1%      | 0.984 / 0.899                     | 80.4%              | 17.6%      | 1.9%        |
| juggernaut | 4900     | 93.0%                              | 6.8%      | 0.964 / 0.841                     | 70.1%              | 24.6%      | 5.3%        |
| aged       | 1298     | 96.7%                              | 3.3%      | 0.983 / 0.913                     | 83.3%              | 14.7%      | 2.0%        |

The world has 156500 cells for 1300 to 4900 creatures, so almost every occupied cell holds one creature, also in the clustered aged world.

## Row visits and entries per creature

Narrow = entries each creature scans in its own rows of the union list, copied = entries written into the scratch list per creature.

| Case       | Walk  | Rows today | Rows, cell gather | Rows, block gather | Entries today | Cell: copied + narrow | Block: copied + narrow |
|------------|-------|-----------:|------------------:|-------------------:|--------------:|----------------------:|-----------------------:|
| mixed      | item  | 4.474      | 4.410 (-1.4%)     | 4.115 (-8.0%)      | 5.817         | 5.752 + 5.830 (+99%)  | 5.570 + 6.052 (+100%)  |
| mixed      | crowd | 4.632      | 4.564 (-1.5%)     | 4.255 (-8.1%)      | 1.502         | 1.464 + 1.503 (+98%)  | 1.290 + 1.528 (+88%)   |
| juggernaut | item  | 4.464      | 4.316 (-3.3%)     | 3.884 (-13.0%)     | 4.302         | 4.192 + 4.324 (+98%)  | 3.978 + 4.562 (+99%)   |
| juggernaut | crowd | 4.624      | 4.467 (-3.4%)     | 4.013 (-13.2%)     | 1.781         | 1.687 + 1.784 (+95%)  | 1.413 + 1.833 (+82%)   |
| aged       | item  | 4.552      | 4.480 (-1.6%)     | 4.231 (-7.1%)      | 2.149         | 2.112 + 2.155 (+99%)  | 2.030 + 2.229 (+98%)   |
| aged       | crowd | 4.709      | 4.634 (-1.6%)     | 4.373 (-7.1%)      | 1.419         | 1.377 + 1.419 (+97%)  | 1.228 + 1.434 (+88%)   |

## Cost in ms

`scout-ray.md` puts the item row loop (row starts, no entries) at 8.2-9.6% of a 4.32 ms kernel for 4.46 rows per creature, about 26 ns per row visit, and the entries at about 18-21%.
Mixed at 3300, cell gather: 0.13 rows saved per creature (item plus crowd), 430 row visits a tick, about 0.011 ms.
Block gather (best case, needs a reorder): 0.74 rows per creature, about 0.06 ms; juggernaut block about 0.15 ms.
Against that the scratch list doubles the entries touched (copy, then the narrow scan with a column filter), plus a pre-pass per group for the union window. At even 3 ns per copied entry that is +0.07 ms on mixed, so the cell gather loses and the block gather is about break-even.
Upper bound of the whole idea: all item and crowd row overhead together is about 9.1 rows per creature, roughly 0.8 ms at 3300, and a gather removes only the share of it that neighbours have in common (1.4-3.4% per cell, 7-13% per block).

## Verdict

Reject without a build. The 1 ms gate is out of reach by a factor of about 90 for the cell gather and 7-17 for the block gather, before their extra cost, and the extra cost (entries touched about doubled) cancels the saving.
The premise fails on density: 93-97% of creatures are alone in their cell in all three worlds.
A gather would pay only at several creatures per cell, 50x denser than the cap world. That is not the engine's general case, and the per-entry tests, the larger cost, stay the same.
