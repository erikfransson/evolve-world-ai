| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Resident rows with helper threads (coordinator share and helper share run the fill kernel, `stepRows` and a batched item lookup on rows) | 3 helpers: 97.7 CPU ms per tick, coordinator thread about 37 | 75.7 CPU, coordinator thread 24.0 | CPU 1.29x less, critical path about 1.5x shorter | yes | none (627 against 633 MB; 1 helper 508 against 600) | about 150 | Merge |
| Packet filled from and read into rows in bulk (publish by slot order, collect straight into rows) | publish 4.2 ms, collect 4.1 ms | publish 1.8, collect 1.4 | about 5 ms off the critical path | yes | none | about 60 | Merge |
| Memory units stay on the owner (sent once with the birth, not every tick) | publish copies all units, helpers load them | only own units copied for undo, helpers skip the load | about 1 ms critical path, less copied | yes | none | about 25 | Merge |
| `need()` without the per-member loop | 1.0 ms | 0.07 ms | 1 ms critical path | yes | none | -3 | Merge |

Inland Sea, 10000 creatures, ecoBench as in the brief, 15 s, node 24, load 10.7 to 12.5 on 8 cores (above the limit of 8 for wall numbers, so wall is not usable; `cpuPercent` stayed near 100 for every run, the helpers got no extra core). CPU is user CPU of all threads. "Main" is the coordinator thread alone (`mainCpuMsPerTick`, new in ecoBench), which with idle cores is the wall time apart from the wait for the helpers (about 1 ms).

| Threads | CPU before | CPU after | Main thread after | Peak RSS before | Peak RSS after |
|---------|------------|-----------|-------------------|-----------------|----------------|
| 0       | 45.5       | 46.4      | 45.6              | 335 MB          | 333 MB         |
| 1       | 82.4       | 60.7      | 32.3              | 600 MB          | 508 MB         |
| 2       | 90.3       | 67.0      | 26.5              | 585 MB          | 563 MB         |
| 3       | 97.7       | 75.7      | 24.0              | 633 MB          | 628 MB         |

Expected wall on idle cores is the main-thread column plus about 1 ms of waiting plus message latency: about 1.35x, 1.6x and 1.8x faster than serial for 1, 2 and 3 helpers, at 1.3x, 1.45x and 1.65x the CPU (before: 1.8x to 2.1x the CPU for about 1.2x). This is an estimate, not a wall measurement, because the machine never dropped below load 10.

## Where helper time went (3 helpers, thread CPU ms per tick, before)
Coordinator: other 1.0, publish 4.2, copy 0.8, post 0.5, grid 2.2, own sense and step 18.5, wait 0.7, collect 4.1, shared phase 5.2 (36.8). Helper (2500 creatures): crowd rebuild 1.9, load 1.4, sense 11.0, remember, steer and item lookup 5.1 (19.8). Per creature the helper sense was 3.0 ms per 1000 against 1.8 serial (the brain forward was equal at 1.2 against 1.15). The plain-object fill and the JS step were the loss, more than the messaging. `Ecosystem` turned resident rows off with a journal, so each helper paid the 1 ms per 1000 object traffic and a slower step.

After (same split): coordinator other 0.1, publish 1.8, copy 0.5, post 0.5, grid 1.9, own sense 9.9 and step 3.1, wait 1.0, collect 1.4, shared phase 4.6 (24.7). Helper: crowd 1.9, load 1.0, sense 8.7, step and lookup 3.2 (15.5, 0.7 of it receive). Idle waits are small: the coordinator waits about 1 ms for the helpers, and each helper is idle only while the coordinator publishes and runs the shared phase.

## Design
- `Ecosystem` makes resident rows with a journal too. The coordinator's own share is the rows of its creatures (plus the watched creature, sensed but not stepped), taken from the slot list by owner: `senseRows`, then `advanceRows` (`stepRows` and `World.touchedBatch`, the same lookup the serial shared phase uses).
- `ShareHelper` has a `ResidentStore` in its own kernel memory. Owned creatures are resident and attached at birth. Each tick the packet columns are written into the rows, then `prepareRows`, `runRows`, `advanceRows`, and the rows are read back into the packet's output columns. The plain-object path stays for `eco.wasm=false`.
- Memory units: the BORN record's genome block now carries the units after the genome, and the helper keeps them. The coordinator copies only its own creatures' units at publish, for `undoOwn`. `memoryOut` has a fixed stride per creature (the largest plan so far, header slot 12), so the memoryAt array is gone and the published bytes no longer hold a memory area.
- Header slot 6 would have overlapped the aging rule (bytes 24 to 47), so the stride lives in slot 12. The test "helpers follow a live change of the ageing rate" caught it.

## Verification
Fingerprints: `--pop 600 --seconds 30` 739359978 (1 and 3 helpers), `eco.wasm=false` with 2 helpers 877945501, `--predators --seconds 40 --threads 3` 410981010, Inland 10k 830514026 (0, 1, 2 and 3 helpers), `bench.ts --pop 300 --gens 12 --seed 2` 727564408. Vitest: ecoPool, ecosystem, ecoRunner, ecoLive and residentBodies, 132 tests pass. New tests: a restored world with nonzero memory on 2 helpers equals the serial run (both kernels, red when the units are not sent with the birth), and a watched creature owned by a helper has the serial rays.

## Not tried, ideas
1. Coordinator weight in the owner choice (the helpers carry about 3.6 ms of fixed crowd, load and receive cost per tick): about 0.5 ms.
2. Ship the coordinator's built crowd grid in the packet so helpers skip the 1.9 ms rebuild: less CPU (1.2 ms per helper) but more critical path.
3. Collect each helper's reply as soon as it arrives, by cutting the coordinator's own share into slices that yield to the event loop: up to 1.4 ms.
