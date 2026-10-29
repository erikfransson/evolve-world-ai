# Perf explorations

One note per Live World speed idea (what was tried, numbers, verdict), plus the `framepath/` probe scripts and `prefilter4-superset.py`.
[live-campaign.md](live-campaign.md) is the campaign log: the ideas table with every verdict and the factor history.
Shared-memory helper mode was removed on 2026-10-11 (`docs/perf-notes.md`), so notes mentioning shared helpers or `--shared` describe a retired mode.
Verdict words: merged, parked (branch kept, not merged), rejected, study (no code).

## Sense kernel
- [rays](rays.md): skip wall math, block-stamp ray cache, about 1.05x, exact; merged.
- [sense](sense.md): f64x2 item prefilter and item-grid row order, tick 1.05x at 38k; merged.
- [cells](cells.md): items packed per grid row in list order, kernel 1.2x, tick 4-7%; merged.
- [wasm](wasm.md): one-call WASM sense, about 1.36x; merged.
- [sensecuts](sensecuts.md): pooled ray offsets, rock table, v128 store, senser 5.2 to 4.5 ms; merged.
- [senselive](senselive.md): sense cost per part at the live setting; study, queued sensecuts.
- [senseempty](senseempty.md): early-out for creatures that see nothing; merged.
- [missout](missout.md): early-out when item candidates miss every ray; no gain, rejected.
- [raycache](raycache.md): kernel-side item candidate cache, +222 lines; rejected.
- [rays2](rays2.md): per-ray passes two rays wide; rejected.
- [rays8](rays8.md): per-ray passes two rays per step, general version; merged.
- [raytests](raytests.md): two-ray exact test, inline fills, senser -5%; merged.
- [subtract](subtract.md): three subtractions removed; merged as a free extra.
- [gather4](gather4.md): gathers four entries per step; rejected.
- [split](split.md): `$sense` split per phase against spills; rejected.
- [sensetidy](sensetidy.md): address and branch tidy bundle (idea 126); merged.
- [sensepf](sensepf.md): touch next creature's lines; every variant slower, rejected.
- [hints](hints.md): WASM branch hints; inside noise, rejected.
- [constsense](constsense.md): v128 constants in locals; merged as hygiene.
- [emitbytes](emitbytes.md): fewer bytes emitted; exact and flat, rejected.
- [emitstage](emitstage.md): emit, early-out and wall stages; 1.0-1.1% alone, bundled into sensesmalls.
- [emitany](emitany.md): pair emit and lean merge loop for every stride; merged.
- [itempairs](itempairs.md): item walk two items per step; parked, then bundled into sensesmalls.
- [sensesmalls](sensesmalls.md): itempairs plus emitstage bundle; merged.
- [cellorder](cellorder.md): records in crowd cell order, tick 1.02x; merged.
- [cellgather](cellgather.md): per-cell candidate gather; 93-97% alone in cell, rejected.
- [candlists](candlists.md): record-ordered item candidate lists; tick does not move, rejected.
- [rockcost](rockcost.md): rock stage by parts, one exact cut, kernel -2%; merged.
- [rockfine](rockfine.md): finer rock lower-bound table; rejected.
- [senserock](senserock.md): rock is about 2 ms of the senser, 1.02x; no merge.
- [prefilter4](prefilter4.md): four-ray f32x4 prefilter; exact but slower, dropped.
- [rowstride](rowstride.md): test order in the walks; already optimal, rejected.
- [sensecopy](sensecopy.md): per-batch item grid copy under 1% of a tick; rejected.
- [sensebudget](sensebudget.md): instruction budget at the head; scout, bundle built as sensetidy.
- [fillcut](fillcut.md): senser wrapper data movement by parts; narrowing merged, rest flat.
- [steermap](steermap.md): kernel output fetched once for memory and steer; merged.
- [steer](steer.md): copy-out and slot-order batch, 1.11x at 50k; merged.

## Brain kernel
- [brain](brain.md): sparse input packing, in-place outputs, tanh without clamps, kernel 1.33x; merged.
- [brain2](brain2.md): round 4, no exact kernel speedup left; study.
- [brain3](brain3.md): software touch of the next brain's weights; merged.
- [brainblock](brainblock.md): 24-wide blocks and tanh in its own loop, kernel 1.10x; merged.
- [brainbudget](brainbudget.md): budget by stage and exact bundle, tick 1.01-1.03x; merged.
- [braingen](braingen.md): brain.wat generated from templates, bytes identical; merged.
- [brainorder](brainorder.md): run brains by weight-block address, gain grows with age; merged.
- [boustro](boustro.md): alternate run direction; worse, rejected.
- [revrun](revrun.md): repeat of boustro; rejected.
- [bf16](bf16.md): bf16 weights, kernel 1.00x or worse; rejected.
- [compact16](compact16.md): 16-wide zero skip in `$compact`, small win; merged.
- [compactio](compactio.md): inputs and outputs out of weight blocks; within noise, rejected.
- [dense](dense.md): dense layers without the index list; rejected.
- [descs](descs.md): aligned descriptor array; rejected at the pre-check.
- [hitmask](hitmask.md): hit mask steering `$compact`; rejected on the bound, not built.
- [nzlist](nzlist.md): senser emits non-zero list; senser pays more than brain saves, rejected.
- [pairs](pairs.md): two same-shape brains in lockstep; rejected.
- [pfrows](pfrows.md): touch skips dead first-layer rows; rejected.
- [touch6](touch6.md): touch stream in 5- and 6-vector loops; rejected.
- [touchdist](touchdist.md): touch distance, spread, extra targets; no variant beats the stream, rejected.
- [unroll](unroll.md): inputs unrolled by two; rejected.
- [tanhil](tanhil.md): tanh latency overlap; no exact speedup left, study.
- [packarena](packarena.md): chunked dense brain arena with compaction; merged with splitblocks.
- [splitblocks](splitblocks.md): ray rows of layer 0 in their own region; merged with packarena.
- [pagepack](pagepack.md): weights and 4 KB pages; study, not the TLB, the 24 MB spills the L3 share.
- [residency](residency.md): weight residency and dead rows; study, spawned splitblocks.
- [scout-brain](scout-brain.md): what bounds brain.wat; scout, tanh and compact constants in locals merged.
- [genomecopy](genomecopy.md): drop the JS weight copy of kernel-backed brains; merged.

## Step
- [stepk](stepk.md): step cost per part, one-bit-per-square raster; merged.
- [stepparts](stepparts.md): step by parts, one exact cut, step -3 to -5%; merged.
- [stepbudget](stepbudget.md): step, crowd, fill, members and touch budget and tidy bundle; merged.
- [stepcuts](stepcuts.md): micro-cut bundle; rejected.
- [trig](trig.md): WASM sin and cos alone gain nothing; rejected, see trigport.
- [trigbatch](trigbatch.md): batch sin and cos host calls; rejected.
- [trigport](trigport.md): fdlibm sin and cos inside step.wat, step -15 to -19%; merged.
- [kernelsmalls](kernelsmalls.md): two-lane sin/cos and u16 cellStart; parked, piece B bundled into smallsbundle.
- [smallsbundle](smallsbundle.md): groundorder, jsbundle and kernelsmalls piece B together; merged.
- [wasmstep](wasmstep.md): steer in WASM is exact but copies eat the gain; study, resident state might give 1.13-1.28x.
- [wasmphys](wasmphys.md): step, crowd grid, item lookup, collisions in WASM over resident rows, Inland 10k 1.13x; merged.
- [resident](resident.md): resident creature rows (lite), 1.15x; merged.
- [serial](serial.md): item lookups and collisions in f64 WASM, 1.05-1.08x; not merged.
- [wattidy](wattidy.md): exact tidy of the kernels; merged.
- [codegen](codegen.md): V8 codegen audit of the hot loops, tick about 1%; merged as cleanup.
- [deopt](deopt.md): V8 JIT audit of the tick JS; clean, rejected.

## Crowd and fill
- [crowd](crowd.md): radix-sort crowd rebuild and dirty-list item sync, 1.7x at 50k; merged.
- [crowdcount](crowdcount.md): skip crowd walk for a lone creature; rejected.
- [crowdsparse](crowdsparse.md): cellStart writes under 1% of a tick; no merge.
- [cell](cell.md): item and crowd grid cell size; rejected.
- [cell16](cell16.md): u16 cellStart; senser slower, rejected.
- [gridreuse](gridreuse.md): reuse the shared-phase grid at tick start; merged.
- [gridpatch](gridpatch.md): patch grid for births and deaths, 200 lines; rejected.
- [gridmove](gridmove.md): move only creatures that changed cell, 190 lines; rejected.
- [gridslots](gridslots.md): grid reuse and fused fill not worth it or not exact; study.
- [occgate](occgate.md): dilated crowd occupancy gate, 284 lines; rejected.
- [rebuildparts](rebuildparts.md): grid rebuild by parts, rebuild -12 to -14%; merged.
- [prep](prep.md): prepareRows into the fill kernel, first try; rejected.
- [prepfill](prepfill.md): prepareRows arithmetic and ground lookup in fill, slots 0.87 to 0.36 ms; merged.
- [onecall](onecall.md): body inputs in fill.wat, 1.016x for +66 lines; rejected, later redone as prepfill.
- [fusedio](fusedio.md): moving memory, ground and y writes out of the fill loop; noise, no merge.
- [glue](glue.md): senser fill loop is bound by object reads; study.
- [fuse](fuse.md): fuse tick-start passes; rejected.
- [redo](redo.md): audit of work the tick repeats; crowd pack stores energy, merged.
- [groundorder](groundorder.md): ground lookup in cell order rejected; quiet-block mask built instead (smallsbundle).
- [itemsync](itemsync.md): item grid patches in one kernel call, syncItems 0.24 to 0.08 ms; merged.
- [bundle](bundle.md): three small exact wins; split, itemsync merged on its own, exp2 parked.
- [jsbundle](jsbundle.md): small JS pieces between kernels, 3% but cold misses; parked, bundled into smallsbundle.
- [exp2](exp2.md): two-lane exp for crowd pack, 0.3% of tick; parked on `pl-exp2`.

## Births and eat
- [births](births.md): tight mutate scan, no label arrays; merged.
- [birthcost](birthcost.md): candidate scan was 58-75% of births, births phase -50 to -60%; merged.
- [smallphases](smallphases.md): birth scan reads an energy mirror, births 1.29 to 0.77 ms; merged.
- [smallphases2](smallphases2.md): the small phases, what is left; scout, pool dry.
- [churn](churn.md): births, deaths and records each under 0.5% of a tick; merged small reuse.
- [eatlive](eatlive.md): eat phase at the live setting, cellStart fill four cells per store; merged.
- [eatrows](eatrows.md): eating over the touched list from packed rows, 1.04x; merged.
- [eatwasm](eatwasm.md): touched items in WASM, 1.009x for 117 lines; no merge.
- [eatcost](eatcost.md): one eat costs 2.2 us, first-touch misses; rejected.
- [eatlist](eatlist.md): compact hit list from the touch kernel; closed, nothing to save.
- [touchbit](touchbit.md): item cell occupancy bitmap pre-reject; rejected.
- [touchskip](touchskip.md): skip touch walk out of reach, +133 lines; rejected.
- [touchbatch](touchbatch.md): touch kernel once per tick; already so, closed.
- [collide](collide.md): collisions and eat on gridded arrays, 1.048x; held, duplicates physics.
- [collide2](collide2.md): redo as one array-culled `collideAll`, 1.039x; merged.
- [collide3](collide3.md): third look at collisions; rejected, no 1% to give.

## Memory
- [memory](memory.md): lazy JS-path scratch, RSS 508 to 322 MB at 50k wide; merged.
- [mem](mem.md): perf-live's extra 75 MB at 1800 s is timing, not a leak; study.
- [memscout](memscout.md): where resident memory sits and what could shrink; study.
- [memset](memset.md): heap cap and unit memory settings vs peak RSS; study, leave unit as is.
- [heap](heap.md): server heap growth over hours, spare pool capped at 256; merged.
- [arena](arena.md): brain arena occupancy over 7200 s; study.
- [savepeak](savepeak.md): save-worker transient copies trimmed; merged.
- [savestall](savestall.md): save off the tick loop with a pack worker; merged.
- [saveretry](saveretry.md): retry a failed periodic save, longer pack budget on stop; merged.
- [packstream](packstream.md): stream save JSON into gzip; parked on `pl-packstream`.
- [verifymem](verifymem.md): cut the save peak in verify and pack workers; merged.
- [semispace](semispace.md): `--max-semi-space-size` for the main process; added to the unit template.

## Server, viewers and threads
- [frames](frames.md): frame, delta and stats encoding; rejected.
- [framepath](framepath.md): viewer frame path budget; scout, bundle built as framebundle.
- [framebundle](framebundle.md): frame path bundle (idea 138); merged.
- [noviewers](noviewers.md): idle skip with no viewer; parked on `pl-noviewers`, too small for the push gate.
- [behindpath](behindpath.md): setImmediate instead of setTimeout(0) on the behind path; merged.
- [offscreen](offscreen.md): render worker with OffscreenCanvas, page busy 111% to 10%; merged.
- [render](render.md): pixel-layer items 14x faster but change pixels; prototype only.
- [render50](render50.md): tiled item cache 1.25x but not pixel-identical; held.
- [draw](draw.md): one culling pass over items, 1.2-1.7x per zoomed frame; merged.
- [gpu](gpu.md): WebGPU compute at most 1.2x and not bit-exact; not worth it.
- [snapshot](snapshot.md): item deltas cut bytes 60-70% but 1.5-2% of sim; rejected for now.
- [parallel](parallel.md): helpers doing memory, motion and item lookup, 1.2x at 20k; merged.
- [layout](layout.md): sense batch in heap order 1.10x; merged, spatial and random order rejected.
- [helpers](helpers.md): genomes only to the owning helper, start timeout; merged.
- [helpers2](helpers2.md): resident rows on helpers, 3 helpers 1.29x less CPU; merged.
- [helpers3](helpers3.md): coordinator weight not measurable, balance under 3%; no merge.
- [node](node.md): V8 flags change nothing, 3 helpers 1.39x wall for 1.75x CPU; study.
- [flagslive](flagslive.md): Node and V8 flags for the server; none beats baseline, rejected.
- [flags2](flags2.md): 19-flag sweep, 120 runs; add nothing for speed.
- [gcmap](gcmap.md): GC about 1-2%, frame encode about 5% of a core; study.
- [alloc](alloc.md): per-tick allocation audit, GC 0.04-0.2%; parked on `pl-alloc`.
- [v8](v8.md): no JS-engine hot spot worth a change; study.

## Bench, tooling and profiles
- [prod](prod.md): does liveBench represent the production tick; study, added bench options.
- [intercept](intercept.md): the fixed per-tick intercept; study, bench `--fixed`, `--food`.
- [aging](aging.md): which phases slow as the world ages; study, `--profileEvery`.
- [aged](aged.md): why cost per creature rises with age; study, `--load`, `--keep`.
- [kernelprof](kernelprof.md): sense kernel cost flat across parts; best cut 1.04x kernel, no merge.
- [profile2](profile2.md): per-phase profile at 12k to 30k; PhaseTimer kept.
- [profile3](profile3.md): reference profile at 38k to 70k wide and `--predators`.
- [profile50](profile50.md): reference profile at 20k to 50k; at 50k sense 41%, brain 17%.
- [generality](generality.md): audit of the campaign diff against the generality rule; fixes merged as 153, 154.

## Scouts and studies
- [scout-head](scout-head.md): perf-live head scout; the pool of exact ideas worth 1.5% is dry.
- [scout-js](scout-js.md): the 25% outside the two kernels is flat; study.
- [scout-open](scout-open.md): open scout of the tick; flat, only the trig port clears, huge pages unmeasured.
- [late](late.md): what dominates an aged world; study.
- [capprof](capprof.md): JS hot spots at the cap and in an aged world; study, nothing built.
- [deepprof](deepprof.md): deep profile of the server process; study, setImmediate built.
- [inspector](inspector.md): whole live path read for hidden overhead; study, passed to framebundle.
- [items](items.md): area-scaling costs under 1% of a tick; nothing to cut.
- [startup](startup.md): start-up at 50k is founder genome draws; nothing to change.
- [hunt](hunt.md): the hunt search is about 1.5% of a tick; nothing to gain.
- [lang](lang.md): Rust kernel at best 1.2x on the kernel; no language port worth it.

## Moonshots and parked levers
- [think2](think2.md): think every other tick, 1.5x; merged as an option, thinkEvery stays 1, Erik's call.
- [think3](think3.md): think every tick while another creature is near; rejected.
- [sense2](sense2.md): sense every other tick, 1.12x for 211 lines; parked on `pl-sense2`.
- [dt20](dt20.md): tick length 1/20; study for Erik's decision.
- [dtswitch](dtswitch.md): dt 1/20 as a ready branch `pl-dtswitch`; not merged.
- [deadband](deadband.md): deadband thinking; rejected.
- [fma](fma.md): relaxed-SIMD fused multiply-add, 1.025x, not bit-exact; parked on `pl-fma`.
- [bf16genome](bf16genome.md): bf16 genomes and 16-bit bank, 1.03-1.04x; parked on `pl-bf16genome`.
- [quad](quad.md): four same-shape brains per f32x4, brain 1.06x mixed / 1.20x cap; parked on `pl-quad`.
- [native](native.md): AVX2 brain addon, kernel 1.8x, tick 1.15x; parked on `pl-native`.
- [nativeprod](nativeprod.md): merge-ready opt-in native brain, 3-5%; parked, not worth a g++ step.
- [nsense](nsense.md): C++ AVX2 sense twin, about 1.05x per tick; parked on `pl-nsense`.
- [aot](aot.md): wasm2c addon, 0.66-0.86x of V8; dead.
- [moonshot3](moonshot3.md): architectures for 1.5-3x; scout, candidate lists built as candlists.
- [chunk](chunk.md): sense and brain interleaved in chunks; rejected.
- [soa](soa.md): typed-array creature state, 1.00x; rejected after the study.
- [aos](aos.md): array-of-structs item records; rejected.

## Quality reviews
- [quality2](quality2.md): thermo-nuclear review of the campaign diff; four blockers, fixed as ideas 156-163.
- [quality3](quality3.md): final thermo-nuclear review before the merge; approved.

## Soaks
- [soak](soak.md): 60 min end-to-end soak; passed, runs as a server.
- [soak6](soak6.md): 6 h soak; passed, RSS plateau 400-450 MB.
- [soak12](soak12.md): 12 h creep check; passed, about 3 MB an hour and decelerating.
