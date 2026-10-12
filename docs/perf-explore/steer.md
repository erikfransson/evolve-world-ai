# Memory and steer, copy-out, sort batch (50000 wide, serial)

Branch `worktree-agent-a23186a8866d4a926`. Profiler laps ported by hand (`sim/profile.ts`, `ecoBench --profile`).

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Pass kernel `f32` once to remember/steer (the `memory.buffer` getter ran 3x per creature) | memory and steer 12.5-12.9 ms | 8.8 ms | about 4 ms per tick | yes | none | about 10 | Keep |
| Members in slot order kept incrementally (`bySlot`, `EcoCreature.index`), batch built sorted, sort skipped; remember/steer walk the batch | sort batch 3.0-4.5 ms | 0.01 ms (batch build 0.5 ms) | about 3 ms per tick | yes | about +80 KB | about 40 | Keep |
| Insertion sort of the batch each tick | sort 3.0 ms | 4.3-4.5 ms | slower | yes | none | 25 | Rejected: member order drifts every tick (swap-remove), budget always exceeded |
| Copy-out of brain outputs | 4% in the old profile | 0.33 ms (adoptOutput already reads in place) | none left | yes | none | 0 | Nothing to do |
| Walking creatures in slot order for remember/steer alone | 12.9 ms | 12.5 ms | within noise | yes | none | 0 | Kept only as part of the above |

Whole tick, `--width 50000 --seconds 12 --threads 0`, 3 alternating pairs, CPU ms per tick (load 19-24): base 85.3, 86.5, 85.1 against new 77.9, 76.7, 72.9. Median 85.3 to 76.7, 1.11x. Great Hunt `--width 30000`: 86.6 to 75.6 (1 pair). Peak RSS 329 to 332-339 MB (noise level, new run also carries profiler code).

Fingerprints unchanged: pop 600 serial and `--threads 3` 847633506, `eco.wasm=false` 204227508, predators 303607739, trials 121151891, 50000 wide 12 s 861182876, Great Hunt 30000 995273937. Vitest 681 tests pass; two live server tests fail to import `ws` in the worktree (environment, same without the change).

## Profile findings (50000 wide, 9650 creatures)

- `Kernel.f32` getter reads `memory.buffer` each call, a runtime call. remember and steer fetched it three times per creature, 4% of samples.
- The batch sort was 3 ms of native Float64 sort plus a pointer chase per creature. Maintaining the slot order incrementally (binary search splice on birth and death, append for new objects) removes it.
- What remains in memory and steer, about 0.8 us per creature, is object field reads and the two trig calls; no single hot spot left.

Not changed: helper threads (`ecoShare.ts`) still sort and call `remember()`/`steer()` with the default view.
