# The Great Hunt cost (predators)

Note: the Great Hunt page was removed in 0.1.1. The two-species engine it measures stays (`ecoBench --predators`).

Branch `worktree-agent-a680a8b1fc4ef00ba`, 2026-10-11, based on main at 8d5fff1. Load 16 to 27 during runs, so wall-clock phase times are inflated; shares of the tick are the usable numbers.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Prey mask and hunt search on the grid's own positions (no states read for non-prey or far candidates) | 8.79, 8.61, 8.88 ms CPU/tick (median 8.79) | 8.58, 9.05, 9.04 (median 9.04) | none measurable (about 1.5% of tick is hunt search, so at most about 0.7% gain) | yes, fingerprint 195577398 at width 20000 | none | about 10 | Not worth it, reverted |
| Crowd rebuild with hoisted locals (`rebuildFrom`) | 491 us CPU per rebuild | 456 us | within noise | yes | none | 0 net | Not worth it, reverted |
| Share the hunt grid with collisions | n/a | already done (`collideAll(gridded)`) | n/a | n/a | n/a | n/a | Already in main |
| Skip hunt grid when no hunter is near prey | n/a | n/a | n/a | n/a | n/a | n/a | Rejected: the grid is also the collision grid, so it is not extra |
| Cheaper species feature encoding (`encodeInputs`) | n/a | n/a | n/a | n/a | n/a | n/a | Rejected: a loop over species flags per ray, not measurable |

## Phase split, `--predators --width W --pop 600 --seconds 10 --threads 0`

Wall ms over 300 ticks, one profiled run each, instrumented locally and removed again.

| Phase | 20000 Great Hunt | 20000 plain | 30000 Great Hunt | 30000 plain |
|-------|-----------------|-------------|------------------|-------------|
| prepare (grid of tick start) | 251 | 125 | 520 | 485 |
| sense (rays, think) | 3005 | 1871 | 3593 | 3572 |
| motion (memory, steer) | 591 | 290 | 553 | 562 |
| eat | 270 | 195 | 315 | 366 |
| hunt grid (positions after motion) | 244 | in collide | 466 | in collide |
| hunt search | 63 | 1 | 47 | 1 |
| collide (grid reused for Great Hunt) | 347 | 413 incl. grid | 827 | 1418 incl. grid |
| births, settle, regrow | 250 | 80 | 245 | 180 |

Mean population: Great Hunt 723 (60 predators), plain 590 at 20000. Peak RSS at 20000 and 30000: Great Hunt 137 and 140 MB, plain 131 and 134 MB.

## Findings

- The hunt search is about 1.5% of a Great Hunt tick. The grid it uses is the one collisions use, so the hunt adds no grid cost when collisions are on.
- Sense is about 55% of the tick in both modes. Per creature-tick the Great Hunt sense is about 31% dearer (13.9 vs 10.6 microseconds at 20000). This includes the predators' different body plan, which was not separated, so the cause is unverified.
- Each tick builds two grids in both modes (prepare and the post-motion grid). Most of a rebuild is passes over empty cells: 800 creatures on a 300 by 188 grid took about 0.45 ms CPU, of which about 0.4 ms is cell passes. Shrinking that needs a sparse grid, or a larger cell, which changes candidate order and so is not bit-exact. Not tried.
- The prey-mask variant kept fingerprint 195577398 at width 20000 for 10 s. The pinned `--predators --seconds 40` check was not run, since that variant was reverted.
