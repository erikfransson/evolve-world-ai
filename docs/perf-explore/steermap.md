| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| keepOut clear-of-rock raster (100 unit squares, one byte each, built lazily per creature radius) | memory and steer 12.8 ms (median of 3), tick 73.6 ms | 11.0 ms, tick 71.6 ms | steer 1.16x, tick 1.03x | yes | +100 KB at 40000 x 25000 | 32 (+16 test) | Keep |
| remember(): two loops (short, long) instead of a per-unit ternary | steer 10.99 ms | 10.52 ms | within noise | yes | none | 4 | Rejected |
| Ground value lookup cache per creature | already there (`Creature.ground()` caches by position; sense reads it, steer hits the cache) | | | | | 0 | Nothing to do |

Inland Sea, 10000 creatures, serial wasm, `--seconds 15`, load 20-23, 3 alternating pairs of cpuMsPerTick: base 68.3, 73.6, 75.5 against new 69.8, 71.8, 71.6. Memory and steer: base 11.9, 12.8, 13.1 against new 10.7, 11.0, 11.2. Fingerprint 830514026 in all six runs. Peak RSS 337-389 MB both sides.

## Profile (cpuprofile, self time, share of the whole run)

stepBody 4.4%, keepOut 2.6%, finishTick (remember, steer, thrustCommand and agingFactor inlined) 5.9%, GroundField.valueAt 1.4% (called from the sense phase, not steer). The map has 3855 rock discs (largest radius 338 world units), so keepOut's cell range spans 3x3 to 5x5 rock cells of 300 units for every creature, rock near or not. The raster answers "no disc can reach this 100 unit square" with one byte read.

What is left in memory and steer is about 1.1 us per creature, object field reads across 10k creature objects and the two libm calls (cos, sin) in stepBody. No ground or rock work remains there.

## Exactness

The raster marks a square when the distance from the square to a disc centre is under disc radius + creature radius + 1. keepOut only moves a body when its centre is under that distance of some disc, so a body in an unmarked square is untouched on pass 0 and the old code returned there too. Positions outside the world or NaN take the full path. Test: `keepOut moves exactly the bodies that touch rock` in tests/typescript/terrain.test.ts (fails if the radius is left out of the raster).
