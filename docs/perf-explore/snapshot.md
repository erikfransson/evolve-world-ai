| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Item deltas via world dirty-slot list, full list every 30 snapshots, page keeps a slot mirror (50000 wide) | 4.9-6.1 ms CPU per snapshot, 1575 KB | 3.2-3.4 ms, 494 KB | 1.5x on the snapshot, about 1.5% of sim time | Yes (mirror equals world every snapshot, fingerprints unchanged, same draw order) | none (worker 528-561 MB before, 545-558 after) | about 85 code, 27 test | Merge if wanted, small |
| Same at 20000 wide | 0.84-0.97 ms, 305 KB | 0.52-0.56 ms, 134 KB | 1.7x | Yes | none | same | as above |
| Item deltas by diffing against a shadow copy (no sim change) | 0.93 ms at 20000, 5.3 ms at 50000 | 1.0 ms, 5.4-6.1 ms | none | Yes | +9 B per slot in the worker | about 30 | Rejected, the O(slots) scan costs what the compaction cost |
| Creatures only in the viewport | 36 B per creature | not built | n/a | Not without padding and a camera message | n/a | n/a | Not worth it, see below |

Harness: `scratchpad/opt2/snapshot/h.ts` runs EcoRunner in Node, steps the sim one tick, then calls postSnapshot, measures process CPU of each. Default Ecosystem preset scaled by width (population by area). Load average 25-38 during runs, 3 alternating base/new pairs each, medians. Base is a copy of main's src.

## Numbers

| Width | Creatures | Items live / slots | Tick (CPU) | Snapshot before | Snapshot after | KB before | KB after |
|-------|-----------|--------------------|-----------|-----------------|----------------|-----------|----------|
| 20000 | 2765 | 16.5k / 20k | 24.1 ms | 0.93 ms median (1.3 mean) | 0.54 ms (0.65 mean) | 305 | 134 |
| 50000 | 9975 | 98k / 125k | 104 ms | 4.95-6.1 ms (7.2 mean) | 3.2-3.4 ms (5.0 mean) | 1575 | 494 |

KB are buffer bytes at the 1.25x creature capacity. The mean includes the full refresh every 30th snapshot.
Bytes per second at 50000: about 9 snapshots per second (tick is 104 ms), so 14 MB/s before and 4.4 MB/s after. At 20000: about 30 per second, 9 MB/s to 4 MB/s. The buffers are transferred, not copied, so the byte saving matters for memory bandwidth and the page's cache, not for a copy.
Tick time is unchanged by the change tracking (24.1 vs 24.2 ms, 104 vs 105 ms).

## Where the rest goes

At 50000 the snapshot is about 3.3 ms: readCreatures 1.9 ms, age and depth loop 0.7 ms, the rest (selected details, buffer, messages) about 0.7 ms. Items no longer register. The snapshot is 5% of the sim thread before and 3% after, so sim speed gains about 1.5-2%. At 20000 about 1.7%.

## What the page does

Creatures: the page needs all of them for the whole-world view, `births.observe` (new ids anywhere), picking and the highlight. Viewport culling would need a camera message to the worker, padding for pan latency (so the picture could lag), and keeps the whole-world case (the worst one) unchanged. Not built.
Packing: 36 B per creature (id, x, y, heading, energy, hue, age, founder, species). Lossless savings are small (species to u8 saves 3 B, 8%). Founder, species and hue are fixed per creature, so they could go as deltas by id, but that adds a keyed mirror on the page for 12 B of 36. Energy and age could be quantised, but the bucket edges and the detailed view would then differ, so not exact. Not built.

## Design of what was built

World: `trackChanges()` and `takeChanges(out)` keep a dirty flag per slot and a list of slots touched by setItem and removeItem (32 lines). Works with helper threads, since it is separate from the journal.
Runner: each snapshot lists either the changed slots, or every live item every 30th snapshot (`itemsFull`, also the first of a run). Entries are (slot, x, y, kind), 13 B each, kind 0 frees. The buffer is sized by entry count. A changed slot is sent with its current value, so several changes in between coalesce.
Page: `ItemMirror` (protocol file) applies entries to slot-indexed arrays and hands the renderer views over them. The renderer is untouched. It walks slots in ascending order, the same order as the old compacted list, and food/poison are one filled path each, so the picture is identical. It now walks all slots (125k kind bytes at 50000) rather than only live ones, which is cheap and was not measured on the page.
Messages: new fields itemsFull and itemSlots, itemCap is now the entry count.

## Risks and cost

Deltas depend on the page applying every snapshot of a run in order. The page does (stale-run messages are only recycled, and the next run starts with a full list). A dropped message would leave the mirror wrong until the next full list, at most 30 snapshots. There is no sequence number.
Complexity: one new concept (mirror plus full/delta flag), about 85 lines of code and 27 of test, one extra pass of the render loop over free slots. Peak RSS unchanged.

## Exactness

Fingerprints on this branch: ecoBench 30 s pop 600 = 494818766, predators 40 s = 792910110. Full vitest run: 440 pass. Verify mode in the harness compared the mirror to the world on every snapshot at 12000 wide with full lists every 1, 7 and 1000 snapshots, 0 mismatches. Not checked in a real browser.
