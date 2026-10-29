# Server memory over hours (idea 54, study plus a bound)

Question: what grows on the server over hours (production RSS peaked at 787 MB over 11 h at 1893 creatures; benches show 220-260 MB at 60 s)?

Harness (scratchpad, not committed): LiveWorld plus the public loop's frame (5 Hz: creatureFrame, takeDelta, ItemFeed) and stats (1 Hz, Chronicle with records) work, no network, speed 3, 3200 seeded creatures, sizes after two GCs every 900 s.

| simS | pop  | rss MB | heapUsed MB | external MB | arrayBuffers MB | spare pool (dead creatures kept) |
|------|------|--------|-------------|-------------|-----------------|----------------------------------|
| 0    | 3200 | 201    | 24          | 72          | 33              | 0                                |
| 900  | 3059 | 290    | 21.5        | 110         | 48              | 314                              |
| 1800 | 1351 | 310    | 21.6        | 130         | 62              | 2022                             |
| 2700 | 2376 | 316    | 21.8        | 131         | 63              | 997                              |

## Bounded by a constant (checked in the run)

Population samples ring 1080 (258 at 1800 s, grows 129 per 900 s until full), lineage ring 180, leaderboard 9 entries, item feed 32 frames (40-160 KB), history JSON cache a few KB, item log, ops and captures 0, lineage table follows living lineages (3200 to 42).

## Grows without a bound: the spare pool

`Ecosystem.remove()` pushed every dead creature (brain, genome, memory arrays) onto `spare[species]`; `spawn()` only pops. The pool holds peak deaths minus births, so after a population crash (3059 to 1351 at 1800 s) about 2000 dead creatures stay, and `arrayBuffers` rose 29 MB. Fix built: `MAX_SPARE = 256` per species (births per tick are a handful, so reuse is unaffected in steady state). One test (`ecosystem.test.ts`, "spare creature pool") fails without the cap.
`ecoShare.ts` (helper threads, off on the server) has the same unbounded pool, not changed.

## Unverified

- 7200 s run: run 1 died at its 3600 s save (10 s pack timeout under idle priority), run 2 died early; the 4 h save peak on the real cadence is not measured.
- Measured effect of MAX_SPARE on RSS and speed, fingerprints 708687555 / 10334191 / 81047108: chain script was started, results not yet in this file.

## Verification (orchestrator, 2026-10-28)

- Exactness: fingerprints 708687555 (mixed) and 10334191 (juggernaut cap) unchanged; `thinkEvery ecoPool liveSaves residentBodies wasmStep ecosystem` 132 tests pass; `reset` leaves no field behind, so a reused spare equals a fresh creature.
- Memory, `--seconds 1800 --copies 800` (population 3306 to 1351, the pool fills after the crash), fingerprint 847136415 on both:

| Build     | peak RSS | heapUsed | arrayBuffers | external | RSS at end |
|-----------|----------|----------|--------------|----------|------------|
| perf-live | 293 MB   | 27 MB    | 62 MB        | 131 MB   | 293 MB     |
| MAX_SPARE | 249 MB   | 20 MB    | 36 MB        | 104 MB   | 248 MB     |

- Speed, two alternating 60 s pairs (mixed, load about 15): base 13.85, 13.65 against 13.69, 14.23 ms per tick; within the pair spread. Births after a crash allocate fresh objects once the pool is empty, which is the only mechanism for a cost.

## Helper pools

- `ShareHelper` in `ecoShare.ts` (browser page and tests, 0 helpers on the server) now bounds its dead-creature pool by the same `MAX_SPARE` per species; test "helper spare creature pool" in `ecoPool.test.ts` fails without it.
- Bit-identical: only the number of kept spares changes, never which one a birth pops while the pool is non-empty beyond the cap; thinkEvery pin and helper-vs-serial cases unchanged.

## Kernel resources on drop

Push-gate review: with kernels on, a creature dropped past `MAX_SPARE` kept its brain slot and weight block (about 8 KB), its 192-byte resident row, its units block and a ref on its ray offset table, so each crash and regrow with more than 256 net deaths per species leaked them, and the orphaned rows were still rebound on every memory growth.
Fix: `SenseKernels.release` (called by `Ecosystem.remove` and `ShareHelper.apply` when the pool is full) frees the brain block (`WasmBrainBank.release`, out of the run order), unrefs the offset table and frees the units block, and puts the slot and the `ResidentState` on free lists that `attach` and `ResidentStore.add` take from before growing.
No result depends on slot numbers or block addresses (brains run by address, each from its own block, reused rows are zeroed as new ones), so results are exact.
Also `Creature.reset` now zeroes the JS outputs, which a reused spare carried over from its previous owner until its first think (JS path, visible in saves at thinkEvery above 1).
Tests: "kernel resources of dropped creatures" (`ecosystem.test.ts`, 4 crash-and-regrow cycles) and "frees the kernel resources of dropped creatures for reuse" (`ecoPool.test.ts`, helper) assert that bank memory, `nextSlot`, resident rows and arena top stay flat after the first cycle; both fail on perf-live (836 to 1116 slots, 456 to 656). "gives a reused spare zero outputs" fails without the reset line.

Exact: fingerprints 708687555 (mixed, 4 runs), 10334191 (juggernaut cap), 847136415 (1800 s, both builds), thinkEvery pin 81047108; full suite 1231 tests pass.

Memory, `--seconds 1800 --copies 800`, one run each, MEM line as above:

| Build     | peak RSS | heapUsed | arrayBuffers | external | RSS at end |
|-----------|----------|----------|--------------|----------|------------|
| perf-live | 284 MB   | 25 MB    | 36 MB        | 105 MB   | 284 MB     |
| sparefix  | 259 MB   | 30 MB    | 39 MB        | 101 MB   | 260 MB     |

Speed, two alternating 60 s pairs (mixed): base 13.40, 13.02 against 12.67, 13.44 ms per tick, within the spread.
