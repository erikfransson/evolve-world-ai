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
