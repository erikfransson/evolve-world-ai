# Idea 137 memscout: where the server's resident memory sits, what could shrink

Branch `pl-memscout` (perf-live b06bb0e), docs only, nothing built. Scratch hook (not committed) wraps `Arena.alloc/release` with a call-site tag, samples `/proc/self/status` every 200 ms, and at exit prints `memoryUsage`, the arena free lists, the biggest `/proc/self/smaps` mappings and writes a V8 heap snapshot (retainer paths of the ArrayBuffer data). Runs: `liveBench --frames --save N` (the server's `Saves`, pack and verify workers included), pinned, nice 19, load 15-28. Not covered: viewers and their socket buffers (bounded in `budget.ts`), the admin channel.

## Runs
| Run | Case | Saves | End RSS / HWM (MB) |
|-----|------|-------|--------------------|
| mixed | 4 founders x 800, 600 s, population 3000-3300 | every 150 s (3 of 4 hit the 10 s pack timeout under load 26, so fewer worker passes than a real server) | 370 / 446 |
| cap | juggernaut x 4900, 600 s | every 150 s, all 4 saved | 450 / 502 (population crashed 4900 to 2900 at 220 s, so not at the cap at the end) |
| cap150 x3 | juggernaut x 4900, 150 s (population 4900 throughout) | every 60 s, 2 saves, 40 MB JSON | 462, 400, 400 / 546, 483, 484 |
| cap150 env x3 | same with `MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072` | same | 323, 316, 287 / 484, 491, 430 |
Without saves the bench peaks at 220 (3300) and 256 (cap): the running footprint. Saves add the rest.

## Breakdown (MB, end of run, after the saves)
| Part | mixed 3250 | cap 4900 (cap150 median run) | Where |
|------|-----------:|-----------------------------:|-------|
| node binary and libs (file-backed) | 58 | 58 | fixed |
| V8 heap used | 25 | 32-41 | strings 10-13 (module source: `kernels.generated.ts` 3.6 MB, node internals), code 5, objects 10; Creature/EcoCreature/Brain/ResidentState about 2 MB per 3000 |
| V8 heap total | 34 (98 during saves) | 42-47 (102-109 during saves) | slack up to 70 MB while a save runs; one of six cap150 runs ended with 109 still held |
| wasm linear memory | 45.7 | 48.4 (resident 34, the rest never touched) | brain blocks 26.4 / 25.1; senser regions 13.2 / 14 (of which `rCand` 9 is the candidate scratch, sized for every item, only its first KB is written, so not resident); item tables 3.4; rows 2.1 + units 0.8-1.2; crowd 1.3; offset tables 0.4-0.5; free list 1.9 / 0.7 (4780 blocks, 13 after the crash); arena top equals 45.6 / 44.6 |
| `Brain.weightsGenome` Float32Arrays (JS copy of every genome) | 26.6 | 23.1 | 3253 / 4900 backing stores, retained by `Brain.weightsGenome` |
| World item arrays, terrain, ground field, map weights | 12 | 12 | fixed by world size (cap-sized) |
| glibc retained after the save workers (RSS minus the above) | about 195 | about 210 | main-arena `[heap]` 75-79 plus thread arenas (64 + 54 + 34 + small = 176 in the first cap150 run); the live malloc data in them is the 35 MB of buffers above |

The V8 heap is small. The two things that dominate the resident set are the glibc memory that the save workers leave behind (about 200 MB) and the transient save peak. The wasm memory and genomes are 70-75 MB together.

## Save peak (cap150 median run, 40 MB JSON, running 256 MB)
RSS time series: 295 before, 439 at the end of the snapshot and pack (+145), then back to 310, then a verify plateau of 415-435 for about 20 s (the verify worker rebuilds the whole world: its own wasm 48 MB, genomes, World arrays; `heap.md`/idea 69 measured it at 205 MB). Main thread meanwhile: `arrayBuffers` 34 to 64 (the snapshot columns, transferred to the pack worker), `heapUsed` up to 53-78. HWM 483-484 (546 in the run that also kept 109 MB of V8 heap slack). So the save adds 225-290 MB over the running footprint and leaves 140-210 MB behind.

## Candidates (exact, none built)
| # | Candidate | Measured bound | Lines | Notes |
|---|-----------|---------------:|------:|-------|
| 1 | Kernel-backed creatures drop the `Brain.weightsGenome` copy; `Brain.genome` is rebuilt on demand from the brain block (the block holds the same f32 values, transposed and padded, so the read-back is bit-exact) | -23 MB at the 4900 cap, -26.6 MB at 3250 mixed; also removes one malloc per birth | about 60: `brain.ts` (length kept, getter via a source callback), `brainKernel.ts` (inverse of `set`), `senseKernels.ts`/`creature.ts` wiring, scratch use in `ecoState.ts` and `ecoShare.ts` loops | Readers of the genome are births (`ecosystem.ts:622`), saves (`ecoState.ts:113`), helper-thread share (`ecoShare.ts:284`), the viewer's genome request (`liveWorld.ts:268`); none per tick. JS-only creatures (RL, tests) keep the copy. No save-format change. Needs a bit-equality test block vs genome and the three fingerprints |
| 2 | Unit file environment `MALLOC_ARENA_MAX=2` plus fixed `MALLOC_MMAP_THRESHOLD_` and `MALLOC_TRIM_THRESHOLD_` of 131072 | steady RSS after the saves: median 400 to 316 (-84 MB; runs 462/400/400 vs 323/316/287); HWM unchanged (484 vs 484, runs 546/483/484 vs 484/491/430) | 3 (template) | Not code. Lowers the plateau, not the save peak, so MemoryMax margin at save time is the same. Three pairs, one case (cap, 150 s); cpuMsPerTick equal (19.5 vs 19.4 in the first pair). Idea 68 had one run per arm and cap 256 mixed in; this isolates the malloc part. Verify in a long run (soak) before the unit changes |
| 3 | Save peak: verify worker keeps the rebuilt world's wasm and arrays for its whole run | up to +120-135 MB for about 20 s of the 225-290 MB peak | not sized | Needs the verify design looked at (check a hash or a streaming restore instead of `restoreState`); idea 78 (stream the JSON) only lowers the pack worker |
| 4 | Main heap `--max-old-space-size` 128 instead of 768 | removes up to 70 MB of V8 slack at save time (heapTotal 102-109 vs used 31-41); mem.md saw -110 MB with 80 | 1 | Main `heapUsed` max 78 in these runs, but the real server heap with viewers is not measured here; ask Erik first (restrictive is safer, but a too low cap kills the world) |

Not worth doing: wasm free list (0.7-13 MB; 29 MB after 2 h of churn, `arena.md`, compaction parked in `packarena.md`), `rCand` (9-13 MB mapped, not resident), strings (static source), World arrays (cap-sized, 12 MB).

## Headroom of the 768 MB heap cap
V8 `heapUsed` is 25-35 MB at 3300 and 32-41 at the cap in steady state, 78 at most during a save, and did not rise over the 600 s runs (mixed 25 to 26 after 4 saves). Worst total `heapTotal` seen: 113 MB. The cap has a factor 7 headroom, and what the heap holds is bounded (chronicle rings, spare pools, `MAX_SPARE`). What trends up in the soak is not the V8 heap: reading the running 12 h soak's `samples.csv` (read only, 5.6 h in) the hourly mean RSS is 346, 374, 426, 391, 440, 447 and the HWM 587 (a save at 3-5 h). The plateau drifts +5 to +10 MB an hour after hour 3, which matches glibc retention after the saves (candidate 2) and not heap growth; the wasm free list adds about 0.6 MB an hour (`arena.md`). `MemoryMax` 1 G covers heap, wasm, glibc and workers together, and the 587 MB HWM leaves 400 MB.

## Verdict suggestion
Take 2 first (no code, -84 MB steady, check it against the 12 h soak's plateau) and 1 second (-23 to -27 MB exact, about 60 lines). 3 is where the peak lives but needs a design look. No leak found; the heap cap is safe.
