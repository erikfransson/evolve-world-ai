# The eat phase at the live setting

Branch `pl-eat`. `Ecosystem.sharedPhase`, `crowd.wat`.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Crowd rebuild fills `cellStart` four cells per store (SIMD) | 3300 case: 15.645 ms CPU/tick (median of 3 pairs, base 15.38/15.65/15.70); 4900 case: 19.442 (19.44/19.39/19.53). Phases: crowd grid 0.555, eat 1.14 | 3300: 15.851 (15.46/15.98/15.85); 4900: 19.363 (19.45/19.36/19.33). Phases: crowd grid 0.425, eat 1.00 | phases -0.27 ms/tick (about 1.7%); whole tick not resolved (ratio 1.013 and 0.996, noise is +-2%) | yes: 708687555 and 10334191 | none (217 to 250 vs 217 to 257 MB) | +14 wat | Merge as a small win (phase numbers), not visible in the tick total |

## Split of the 1.05 ms (3300 creatures, temporary laps, `--profile`)
- Crowd rebuild (WasmCrowd.rebuild, all in the kernel, JS setup and bind 0.04): 0.57
- `touch` kernel: 0.41
- Hits list 0.02, eat loop 0.065 with 33 touching creatures a tick (so `eatAt`, `removeItem` and `World.log` together are under 0.065 ms; not worth touching)

## Inside the rebuild (warm, 500 calls in a loop, n = 3300, 69 800 cells, two 9-bit radix passes)
- Keys and setup 115 us, radix sort 150 us, sorted arrays plus `cellStart` fill 257 us.
- The fill of `cellStart` wrote all 69 800 entries one by one (about 200 us). Four per `v128.store` brings the rebuild from 520 to 377 us warm. The loop leaves no overshoot (vector stores only while four cells are left).
- It runs twice a tick (tick start and moved positions), so about 0.27 ms of the tick, as the phases show.

## Not done
- Gathering x, y, energy in the key loop (sequential row reads) so the sorted loop avoids 192 B strided rows: -7% of the rebuild, about 0.03 ms, under 1%.
- Fusing the two radix histograms: estimated 30 us a rebuild, under 1%.
- Skipping the second rebuild or updating it in place: a tick moves some creature across a cell border nearly every tick, and the order inside a cell (stable by index) must stay equal for the collision sweep to be exact.
- Cheaper `touch` for creatures with no item near: the lookup is 120 ns a creature and no sense output bounds the moved position exactly; not tried.
- `removeItem` and `World.log`: under 0.065 ms together, rejected.
