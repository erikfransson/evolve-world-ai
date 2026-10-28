# Scout: the 25% outside the two big kernels (study, nothing built)

Branch `pl-scout-js` from `perf-live` 531a215. Mixed case 3300 creatures, cap case 4900 Juggernauts, taskset 2,3,6,7 nice 19 idle, load 7-12. Experiments were reverted; only this file is committed.

## Where the time is
`node --cpu-prof --cpu-prof-interval 200 src/liveBench.ts --seconds 60 --copies 800 --profile` (first 30% of samples dropped): wasm 92.6% of samples, plain JS 7.4% (cap: 91.7 / 8.3). Of the JS, `cpuUsage` (the bench's profile timer) is 2.6% and does not exist in production. Real JS: `patchCell` 0.89%, `sharedPhase` 0.58%, `forwardRun` 0.50%, `step` wrapper 0.27%, GC 0.14%, everything else under 0.15%. So the "plain JS 5%" is 20 functions with none above 0.9%, as `capprof.md` found.
Allocation (`--trace-gc`, 1 MB semispace, steady state): 3.5 scavenges per 5 s window (about 18 per 1000 ticks, 18 KB per tick, 0.4 ms each), 0 mark-compacts. Nothing to remove.

Per-call kernel cost with `src/kernelTimers.ts --copies 800 --ticks 400` (thread CPU, each timer adds about 1 us; mixed, ms per tick):
| Item | ms | Item | ms |
|------|----|------|----|
| step (1.0 call) | 1.20 | crowd rebuild (1.3 calls, 0.52 each) | 0.68 |
| touch | 0.50 | fill | 0.49 |
| prepare | 0.33 | pack | 0.25 |
| syncItems (58 `patchCell` at 4 us) | 0.33 | eat JS (43 calls) | 0.27 |
| sweep | 0.16 | refresh (0.7 calls) | 0.10 |
| births 0.15, regrow 0.12, settle 0.07, forwardRun JS 0.07 | | | |

## Idea 1: sin and cos inside `step.wat` (fdlibm port from `trig.wat`, probe-gated)
Port of V8's fdlibm `sin`/`cos` into `step.wat` as `$sincos`, falling back to the imported `Math.sin/cos` for |x| above 823549 (where the port stops); the 32-word `npio2_hw` table sits next to the P block. Exact in Node (`trig.md`: 0 mismatches in 8.9e7 inputs); other engines need a start-up probe of a few thousand angles that selects the import path (a 3.3% mismatch rate on Chrome's glibc copy makes 2000 probes certain to catch it). `wasmStep` 19 tests pass, fingerprint 708687555 equal.
3 alternating pairs, mixed, `--profile`: step phase base 1.304 1.344 1.361, port 1.177 1.246 1.233 (median -0.111 ms, -8%); cpuMsPerTick base 13.248 13.614 13.890, port 12.931 13.702 13.598 (ratio of medians 0.999, unresolved). Peak RSS 213-220 vs 219-221 MB.
The ablation of `stepk.md` (constants instead of trig) predicts -0.48 ms; the port keeps 0.37 of it as its own cost (about 110 ns a pair in the tick against about 50 ns for V8's native code).
A two-pass variant (loop 1: turn, heading, `$sincos`; loop 2: the rest) was much slower: step phase 1.841 1.748 1.806 against base 1.323 1.323 1.299, tick 13.66 against 13.29 (medians). Rejected.
Expected: 0.11 ms (0.8%) for about +190 lines wat, +15 TS (table, probe), +test for |heading| above 823549. Below the bar on its own.
Same idea for `pack`'s `Math.exp`: ablation (exp replaced by a multiply) takes `crowd.pack` from 0.255 to 0.086-0.108 ms, so the host call costs 0.15-0.17 ms (50 ns each); an fdlibm `exp` port (about 60 lines, exact on every V8 engine since Chrome's libm switch covers only sin and cos) would keep perhaps half: about 0.08 ms. Together with sin/cos about 0.2 ms (1.5%) for about 250 lines. Mergeable as a bundle if every 1% counts; not built.

## Idea 2 (negative): the crowd rebuild is the `cellStart` table, not the sort
At the live setting the table has 500 x 313 = 156k cells (626 KB) for 3300 creatures, 21 cells per creature; `crowdsparse.md` measured 0.85% at 10k creatures and 100k cells, which does not carry over. Ablations of `rebuild` in the tick (kernelTimers, microseconds per call, base 520):
| Variant (results wrong where it removes work, timing only) | us per call |
|------|------|
| no sorted-array gather | 430-470 |
| no `cellStart` gap and tail fill | 253-264 |
| no gap fill but a plain `memory.fill` of the table | 339-392 |
So the fill costs about 260 us a call (0.34 ms a tick at 1.3 calls, 2.4%), and a bare memset of the table is 80-130 us of it: the table is cold after the brain stream (24 MB of weights through a 12 MB L3) and the machine is loaded.
Tried, exact: stable counting sort straight on the cell id (counts in `cellStart`, inclusive prefix pass, reverse scatter turns ends into starts; removes the radix sort and the gap loops, `wasmCrowd` 29 tests pass): 575 and 600 us per call, slower than 520, because it makes two more passes over the cold table. Reverted.
What would help is fewer table bytes per rebuild (u16 entries or a coarser first level) and every reader (sense.wat crowd walk, sweep, JS hunt, refresh) would change; not built. The 0.3 extra rebuilds a tick come from births and deaths renumbering members (`gridpatch.md` rejected patching).

## Idea 3 (small): `forwardRun` stamp-and-walk, 0.065 ms
`kernelTimers`: `forwardRun` 4.527 ms against 4.458 for the wasm `forward` call, so the two JS loops (mark the run slots, walk `order` in block order) cost 0.07 ms (0.5%; `capprof.md` 0.115). A shortcut for `count === held` is useless because the spare pool keeps up to 256 brains per species in `order`. Moving the stamp and walk into the `forward` export (it already loops the slots) would save at most half. 0.03 ms, not worth a kernel change.

## Checked and left alone
- `patchCell` 0.23 ms with timers (0.11 by cpu-prof): 58 patches a tick at 4 us, each shifting the rest of a grid row; the wasm version lost in `intercept.md`, a gap layout would break the one-run-per-row walk of touch and sense.
- Eat loop JS 0.27 ms with timers (43 calls, about 3 us net each, item list unlink and log): cache misses on member and item arrays.
- Collisions (0.16 ms sweep, `collide3.md`), births (`births.md`), step micro-cuts (`stepcuts.md`), fusing passes (`fuse.md`), touch (idea 86 `pl-touchbit` is running): no new angle.

## Verdict
The non-kernel 25% is flat: about 12 items of 0.1-0.7 ms, no JS function above 0.9%. The only measured exact cut is idea 1 (0.11 ms, 0.8%; 0.2 ms with the exp port). The one item with a real lead is the `cellStart` traffic (0.34 ms a tick at the live setting), which needs a smaller table, not a different sort.
