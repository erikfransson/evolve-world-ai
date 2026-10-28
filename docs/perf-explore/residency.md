# Brain weight residency, dead rows and footprint levers (idea 122, study)

Branch `pl-residency` (from perf-live 6f81ad5), docs only, no engine change.
Questions: (1) what streams through the cache between two brain passes, and how much of the weight stream could survive to the next tick; (2) can the dead layer-0 rows be stored so the stream skips them cheaply; (3) any other exact lever on the footprint.

## How measured
- `perf` is not available (`perf_event_paranoid` 4). Everything is timing (process user CPU), `/proc/self/clear_refs` plus `smaps` Referenced, and counters on the live state.
- Live harnesses run the server's `LiveWorld` (liveConfig, seed 1, 4 founders x 800 or juggernaut x 4900, frames at the server's 5 Hz). Kernel harnesses use the tick-600 dumps of `touchdist.md` with today's brain.wat; one tick's real run, 48 MB eviction, input and descriptor lines read back, median of 21-31, outputs compared word for word (equal in every layout below).
- Load 9-13 during all runs, cores 2,3,6,7 at idle priority, shared with 4-6 other campaign jobs (on the same physical cores, so L2 is shared too).
- Scripts in the session scratchpad `res/` (not committed): `probe.ts` (extra brain pass at tick points), `pages.ts` (pages per phase), `jumps.ts` (dead-row pattern), `persist.ts` (hit-ray persistence), `ora2.ts` with `gen2.py`/`gen3.py` (layout bounds and kernel variants).

## (1) What survives between two brain passes

Extra brain pass inside the live tick (same run list and inputs, so the same outputs; fingerprint with probes 351626573, equal to the run without them). The pass reruns either the whole list or only its tail, the blocks streamed last. Median ms, 37-57 samples per point, 40 s runs with frames.

| Rerun at                         | Mixed, all brains | Cap, all brains | Mixed, last 2 MB | Cap, last 2 MB | Mixed, last 4 MB | Cap, last 4 MB |
|----------------------------------|-------------------|-----------------|------------------|----------------|------------------|----------------|
| right after the brain pass       | 4.160             | 4.091           | 0.371            | 0.348          | 0.776            | 0.696          |
| after step                       | 4.155             | 4.241           | 0.378            | 0.356          | 0.768            | 0.693          |
| after grid and touch             | 4.224             | 4.201           | 0.381            | 0.354          | 0.777            | 0.704          |
| after eat, hunt, collisions      | 4.204             | 4.121           | 0.393            | 0.357          | 0.774            | 0.699          |
| after settle, births, regrow     | 4.208             | 4.263           | 0.386            | 0.354          | 0.776            | 0.697          |
| after live.step and frames       | 4.157             | 4.166           | 0.395            | 0.364          | 0.779            | 0.693          |
| after next tick's crowd grid     | 4.199             | 4.135           | 0.386            | 0.361          | 0.783            | 0.710          |
| after a 48 MB eviction (cold)    | 4.125             | 4.137           | 0.392            | 0.364          | 0.775            | 0.704          |
| the tick's own brain pass        | 4.212             | 4.251           |                  |                |                  |                |

- Even with nothing in between, the last 2 MB of weights rerun only 4-5% faster than cold, and the last 4 MB not at all. In-cache brains run about 30% faster (`pagepack.md`, K = 64), so under this load the process keeps well under 1 MB of its weights past L2. No phase is "the evictor": nothing is left for the phases after the brain to evict.
- Bound for any cross-tick residency trick on this machine at this load (idea 120 included): 4-5% of the first 2 MB of the next pass, about 0.02 ms per tick. On a quiet machine (`pagepack.md` knee at 4-8 MB) the bound is about (resident MB / 24 MB) x 1.2 ms of DRAM cost, so 0.2 ms (2%) at 4 MB, before the other phases take their share below.

Pages touched per phase (`clear_refs` before, `smaps` Referenced after, MB of 4 KB pages, 18 sampled ticks; the smaps read itself adds about 1.6 MB of JS heap pages to every row):

| Phase                         | Kernel memory, mixed / cap | JS heap and other, mixed / cap |
|-------------------------------|----------------------------|--------------------------------|
| crowd grid (prepareTick)      | 0.98 / 1.35                | 1.76 / 1.61                    |
| fill and senser               | 18.4 / 26.4                | 2.65 / 2.47                    |
| brain forward                 | 25.4 / 26.8                | 1.41 / 1.41                    |
| step                          | 14.5 / 21.4                | 1.62 / 1.68                    |
| grid and touch                | 3.5 / 4.0                  | 1.93 / 1.63                    |
| eat, hunt, collisions         | 0.85 / 1.05                | 2.94 / 3.67                    |
| settle, births, regrow        | 0.70 / 1.02                | 3.17 / 3.09                    |
| rest of live.step and frames  | 0.04 / 0.05                | 1.71 / 2.07                    |

Senser and step touch a page per brain block because each block ends with its input and output vectors, so their page counts overstate their lines. In lines the non-weight working set per tick is about 4-6 MB (in/out vectors 0.94 MB, rows 0.62, unit blocks 0.82, sense records 0.21, descriptors 0.21, item tables of 71k items up to 0.9, crowd grid 0.1-0.2, JS heap work 1-2), against 13-19 MB of weight lines read or touched.

## (2) Dead layer-0 rows

The input layout is ray-major (`inputLayout`: rays x features, then extras and memory), so a ray that sees nothing is already one contiguous run of dead rows. Count at tick 600:

| Per brain                               | Mixed (3318) | Cap (4900) |
|-----------------------------------------|--------------|------------|
| inputs / non-zero                       | 64.5 / 11.4  | 55 / 7.8   |
| rays / dead rays                        | 9 / 8.1      | 8 / 7.2    |
| zero lanes inside hit rays              | 3.4          | 2.9        |
| zero runs / runs of 128 B or more       | 2.87 / 1.89  | 2.69 / 1.84 |
| dead MB per tick (in runs of 128 B+)    | 11.4 (11.2)  | 14.1 (13.9) |
| layer-0 MB read / later layers and biases | 2.95 / 9.9 | 2.33 / 6.65 |

Hit rays persist: 75-77% of the rays that hit were hit the tick before; 50-58% of brains see nothing at all (0.70-0.81 hit rays per brain).
So the layout the brief asked about already exists: 98% of the dead bytes sit in under two runs per brain, and `pfrows.md`'s gap skip was already one jump per dead cluster. Regrouping has nothing left to group.

Layout bounds on the dumps (blocks rebuilt by the harness, not timed; ratio to the real layout, higher is faster, two to four runs each):

| Layout (kernel)                                                                 | Stream MB mixed / cap | Mixed cold      | Cap cold        |
|---------------------------------------------------------------------------------|-----------------------|-----------------|-----------------|
| packed back to back (brain.wat)                                                 | 24.0 / 23.1           | 1.01-1.04       | 1.02-1.07       |
| oracle: this tick's dead rays dropped, inputs compacted (brain.wat)             | 13.5 / 10.1           | 1.14-1.19       | 1.24-1.34       |
| oracle, in-core part only (64 brains cycled, in L2)                             |                       | 1.08-1.11       | 1.00-1.06       |
| split kernel on the real layout (control)                                       | 24.0 / 23.1           | 0.975-1.010     | 0.975-1.014     |
| split, dense parts left in place, holes where the ray rows were                 | 12.4 / 8.75           | 0.915-0.937     | 0.939-0.951     |
| split, dense parts packed back to back, ray rows in their own region            | 12.4 / 8.75           | 1.026-1.066     | 1.065-1.115     |
| same, with the hit rays' rows also in the streamed part (perfect slots, heavier kernel, one run) | 13.5 / 10.1 | +3.5% over split | +5% over split |

"Split" is a static layout: each block keeps a dense part (the extras and memory rows of layer 0, its bias row, the hidden and output layers) and the rays' rows of layer 0 go to a region of their own. Layer 0 runs as two calls of `$layer` on the same column groups: bias plus the ray entries of the non-zero list (rows at the ray base), stored to scratch, then that partial sum plus the remaining entries (rows in the dense part) and tanh. The adds stay in today's order and an f32 store and reload is lossless, so the bits are the same; the kernel change costs 0-2.5% (control row).
- The dead-row bytes are worth a lot in memory time (oracle 0.5-0.7 ms per tick), but only a packed dense stream keeps it: holes in the stream lose 5-8% (as `pfrows.md` found for skips), and the hit rays' rows read on demand give back about half of the oracle.
- Starting the touch stream after the next block's ray rows without moving anything is the "holes" row, so it is rejected by measurement.

## (3) Other levers checked
- Line sharing: the arena starts on a 64-byte line (16960) and every block is a multiple of 256 bytes, so no two blocks share a line; descriptors are one 64-byte line per slot. Nothing to align.
- Descriptors copied into run order (one sequential table per tick): 1.003 cap, 1.015 mixed. Rejected.
- Interleaving sense and brain in chunks (each chunk's input and descriptor lines read just before its brain call, chunks of 32 against all up front): 0.97-1.04 over six runs, no gain. Inputs are not evicted before use.
- Packing alone is `packarena.md` (parked); bf16 bytes is `bf16genome.md` (a rule change); both measured before.

## Ranked ideas (exact, bounds from the harness, cold)
1. Split blocks on a packed dense arena: the ray rows of layer 0 in a ray arena, the dense parts back to back (packarena's chunked bump allocator), layer 0 as the two exact passes above, descriptor words for the ray-input count and the ray-row base (layer limit 12 to 10 sizes; the plan allows 6 layers). Bound: cap 1.065-1.115x brain kernel (about 0.35 ms, 3% of the cap tick), mixed 1.03-1.07x (0.12-0.25 ms, 1-2%); packing alone is 1.02-1.07 of that. The stream shrinks from 23 to 9-12 MB, which also leaves more cache to the other phases (not measured). General: the split point is rays x ray features from the plan, any ray count, feature count and layer sizes; brains without rays have an empty ray part. Risk: packarena's in-tick gain was below its harness gain; holes in the dense arena after deaths cost 5-8% (measured), so compaction is required; about 200 lines in the bank and kernel.
2. On top of 1, touch the next brain's hit-ray rows (their non-zero list computed one brain ahead) so they are not demand misses. Bound: about 5% of the cap kernel and 3.5% mixed (perfect-slot row, one run), so 1.2-1.6% of the cap tick before the touches' cost; `touchdist.md` found bursts of missing loads cost 2-9%. Only worth a try once 1 is in.
3. Nothing from residency: on this machine the bound is about 0.02 ms per tick (table 1), and at most about 2% on a quiet one. Idea 120's gain will be limited by the same bound, so its pairs should be read against it.

The oracle's in-core part (1.08-1.11 mixed, compact scanning about 11 inputs instead of 64) supports the scout candidate "sense kernel emits the first-layer non-zero list".

## Verdict suggestion
Study done. Idea 1 clears the bar at the cap on the bound (3%) and is the only one; build it after the packarena decision, since it needs that allocator. Ideas 2 and 3 are below the bar or unproven.
