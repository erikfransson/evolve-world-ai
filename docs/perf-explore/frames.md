# Frame, delta and stats encoding (idea 11)

The server's own per-tick work besides the engine: `liveBench --frames` encodes the creature frame, the item delta and the stats every frame (FRAME_MS 200), as `public.ts` does for viewers.
Note the bench calls `stats` at 5 Hz, the server at 1 Hz (`statsLoop`), so the bench charges stats five times too much.

## Parts at the live setting (4 x 800, about 3300 creatures, cpu ms per call, loaded machine)

| Part                         | Base  | Now   |
|------------------------------|-------|-------|
| creatureFrame                | 3.2   | 1.7-2.3 |
| takeDelta (no item changes)  | 0.003 | 0.003 |
| stats (1 Hz in the server)   | 6.9   | 6.2   |
| of stats: members offer loop | 3.7   | 2.6   |
| of stats: namedTop           | 2.3   | 2.3   |

collectOps is not in these numbers (it runs inside `step`, counted in cpuMsPerTick); with `--frames` the item changes of this world are few, takeDelta is nothing.

## Changes (bytes identical)

- `creatureFrame`: the age came from `eco.get(id)` (a Map lookup per creature); `readCreatures` lists `eco.members` in the same order, so it reads `members[i]` (and `config.dt` is hoisted).
- `encodeCreatures`: byte writes into the `Uint8Array` instead of a `DataView` call per field; same quantisation and clamps, locals hoisted.
- `Leaderboard.offer`: the `"species:board"` key string is built once, not per call (3 per living creature per stats).
- Test `liveProtocol.test.ts` compares the encoder with the old DataView writer on 3000 records, including NaN, infinities, negatives and values past u32, for plain arrays and typed arrays.

## Speed

`node src/liveBench.ts --seconds 60 --copies 800 --frames`, alternating pairs, load 15-21 on 8 cores.

| Pair | Base frameMsPerTick | Now   | Base cpuMsPerTick | Now    |
|------|---------------------|-------|-------------------|--------|
| 1    | 0.644               | 0.614 | 16.302            | 16.261 |
| 2    | 0.651               | 0.502 | 16.487            | 16.518 |
| 3    | 0.527               | 0.439 | 15.584            | 15.133 |
| median | 0.644             | 0.502 | 16.302            | 16.261 |

Frame work per tick drops 22% (0.14 ms of 16 ms, under 1% of the tick); fingerprint 708687555 equal in all six runs, peak RSS 215-227 MB both.
The bench's stats share is five times too high, so the real saving at 1 Hz stats is smaller than the table; the creature frame (1.5 ms per frame less) is the part that counts.

## Verdict

Small, exact, and safe (no new input path, no limit changed), but worth about 0.1 ms per tick. Merge if the diff is wanted for tidiness, not for speed.
What remains: `namedTop` (2.3 ms per stats, 1 Hz) and the leaderboard offer scan (2.6 ms per stats), both once a second.
