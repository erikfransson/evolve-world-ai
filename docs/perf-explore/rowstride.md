# Per-entry test order in the crowd and item walks (idea 102)

Study only, no code change. Branch `pl-rowstride` from `perf-live` e58a4a9 (no diff).

## Load order today (`sense.wat`)

| Walk | Loads per entry before the distance reject | After it |
|------|--------------------------------------------|----------|
| item | `xy` pair only (one 8-byte read, one array) | none: the candidate stores the item index, `kind` and `id` are read later at a hit |
| crowd | `sx`, `sy`, and `own` (unconditional, the final mask is `i32.and` of own, distance and wedge) | `sig` and `species` are not touched in the walk at all |

So the item walk already reads only the x/y line. In the crowd walk only `own` is read ahead of the reject, and only because the candidate write is branch-free.

## Pass rate of the distance test (temporary exported counters, reverted; 30 s runs, warm-up included)

| Case | item entries visited / pass distance | crowd entries visited / pass distance / pass distance and not self |
|------|--------------------------------------|----------------------------------------------------------------------|
| 4 founders x 800 | 23.07 M / 10.46 M (45%) | 3.76 M / 3.17 M (84%) / 0.67 M (18%) |
| juggernaut x 4900 | 29.79 M / 13.39 M (45%) | 5.54 M / 4.47 M (81%) / 1.28 M (23%) |

The crowd rows are the grid cells covering the sensing circle, so 81-84% of entries pass the distance test. Moving the `own` load behind it would skip it for 16-19% of entries, and needs a branch the branch-free walk was built to avoid. `own` is a 4-byte stream indexed by the same `k` as `sx` and `sy` (16 entries per line), so it adds one sequential line per 16 entries, not a miss per entry. Bound on the gain is well under the 0.1 ms noise of the senser phase.

## Verdict

Reject without a build: nothing to reorder in the item walk, and the crowd walk's `own` read is needed for 82% of entries anyway. Not benchmarked.
