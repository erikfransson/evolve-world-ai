# Serial phases: item lookups and collisions in a WASM kernel

Branch `worktree-agent-a930d83104234dc6e`. `serial.wat` (f64, scalar), `serialKernel.ts`, small hooks in `ecosystem.ts`.

World 20000 wide, `--pop 4000`, 20 s, 4 alternating A/B pairs, CPU ms per tick (all threads), median. Load was 18 to 57, so wall time is useless and CPU time still carries about +-5%.

| Idea | Before | After | Speedup | Exact? | Verdict |
|------|--------|-------|---------|--------|---------|
| Item lookups (`eatAt`) + collisions in WASM, serial | 32.5 | 30.2 | 1.08x | bit-identical | Keep |
| Same, 3 message helpers (CPU of all threads) | 47.5 | 45.2 | 1.05x | bit-identical | Keep |
| Typed-array creature state (no gather) | not built | est. 1 to 2 ms more | est. 1.03 to 1.05x | exact | Probably not worth it |
| memory/steer in WASM | | | | needs sin/cos | Dead, see trig.md |

Fingerprints equal to main: pop 600 / 30 s = 417250420 (threads 0 and 3), `--predators` 40 s = 657843665, `eco.collisionDamage=true` 643383674 (also predators + damage). The 20000 runs match too (656593671).

## What changed
- One gather per tick copies x, y, vx, vy, alive of all creatures into WASM memory, plus the item grid (about 0.4 MB).
- `eat` kernel returns the first touched item per creature (same grid order as `World.eatAt`). It feeds the existing `touched` protocol of the helper threads, so an item taken by an earlier creature is re-looked-up in JS exactly as before.
- `run` kernel does the pair walk, `collide`, `hurt` and `keepInside` with the same operation order (sqrt is IEEE-exact). Only creatures that touched are copied back (bit 1 of the alive word).
- The crowd for collisions is rebuilt from the gathered arrays, not from the objects.

## Where the time goes now (4000 creatures, ms/tick, loaded)
gather 0.9, lookup 0.85, collide 1.0, versus main collisions 3.0 and eat about 1.5. The gather reads 5 boxed fields of 4000 scattered objects, about 150 ns per creature, as much as the kernel itself. Keeping x, y, vx, vy, energy in a typed-array slab shared with WASM would remove it and the tick-start crowd gather, est. 1 to 2 ms. It needs a `CreatureState` class with getters over the slab and a member-to-row map, so I did not build it.

## Cost
About 250 lines of WAT, 110 lines of TS, 20 lines in ecosystem.ts, plus a test file (3 cases) comparing against the JS loops. Helper-thread runs gain less because helpers already do the lookups.
