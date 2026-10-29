# Record-ordered item candidate lists in the sense kernel (idea 139, "candlists")

Branch `pl-moonshot3` (perf-live 0b07f93 merged, engine equal to perf-live 5767e22). Exact: fingerprints equal in every run. Built from idea 1 of `moonshot3.md`. Verdict: reject, the tick does not move.

## What changed (+329 -43 in 8 files, tests +237)
- `sense.wat`: with lists on, each creature reads the list it kept from the call before: anchor, list radius R = far + 0.2 L, and the items within R of the anchor in walk order (f32 x, y, cell column and row, kind).
  - The list is valid while |pos - anchor| + far <= R (margin 1e-6 R), R is within what the stamps cover, and no item cell within the stamp reach of the anchor cell changed before this call.
  - A valid list is scanned with the walk's own tests: window cell, distance, wedge. A kind table stands in for `itemKind[index]` at a hit. The list is copied into this call's pool.
  - Otherwise a rebuild walks the R window as row runs with a cell pointer. Today's window cells give the candidates, and every item within R joins the new list. Over 64 entries, or no room left in the pool, means no list, and the creature rebuilds next call.
- `fill.wat`: per record, the row's list address when the call before wrote it (else 0), in record order. Reading it from the row inside `sense` stalled the walk by 0.36 ms. The record also gets its row address (REC_ROW, the free word at 60).
- `senser.ts`:
  - Two pools written in turn, sized from last use (1.5x, 2x after an overflow).
  - A bit per item cell, set within floor(cover / cell) + 1 cells of each dirty cell from `syncItems` and cleared next call. A list passes this test in every call from its build on, so one bit map is enough.
  - A full repack, a new world (restore) or the generation wrap voids every list, so fill passes generation -1. The stamp reach comes from the longest ray seen at attach.
- `senseKernels.ts`, `residentStep.ts`: lists on for the every-tick batch. With thinkEvery above 1 the old walk runs, since a creature that skipped a call would rebuild every think.
- Worst case memory: a full list is 1056 bytes. At 5000 creatures that is 5.3 MB per pool in use, under 26 MB for both regions with their headroom. Live use is 0.43-0.51 MB per pool, plus a 20 KB bit map and 4 bytes per creature.

## Kernel harness (`scratchpad/ms3/harness3.ts`, live state at call 300, p25 ms, hash equal)
| Variant                                                       | Mixed | Cap  |
|---------------------------------------------------------------|------:|-----:|
| base (perf-live sense.wat)                                    | 3.65  | 4.75 |
| lists, final                                                  | 3.48  | 4.55 |
| lists, every check passed as valid (inexact bound)            | 3.12  |      |
| every creature rebuilds                                       | 5.51  |      |

- Per call 92-95% of the lists are valid. Rebuilds: 5% from moves, 2.3% from stamps. A rebuild costs 0.56 us more than today's walk (it was 0.73 with a per-cell loop).
- The probe of `moonshot3.md` (-0.68 ms net) left out the validity check, the cell test that keeps the window exact, and the copy. It also priced a rebuild as today's walk.
- Skin 0.15, 0.2, 0.3 and 0.45 L were all within 0.03 ms of each other. 0.2 kept.

## Whole tick (liveBench `--profile`, base = perf-live worktree, alternating, load 7-14)
| Case       | Base cpuMsPerTick (median)     | Lists                          | Ratio | Senser base / lists | Brain base / lists  | Peak RSS MB          |
|------------|--------------------------------|--------------------------------|------:|---------------------|---------------------|----------------------|
| mixed 60 s | 11.067 11.391 11.297 (11.297)  | 11.243 11.180 11.349 (11.243)  | 0.995 | 4.017 / 3.951       | 4.35 / 4.37         | 216-222 / 216-222    |
| cap 60 s   | 13.033 13.033 13.130 (13.033)  | 13.192 13.102 13.162 (13.162)  | 1.010 | 5.023 / 4.971       | 4.10 / 4.16         | 253-257 / 253-258    |
| mixed 600 s| 10.306                         | 10.173                         | 0.987 | 3.275 / 3.211       | 4.17 / 4.14         | 223 / 226            |

Fingerprints 708687555, 10334191 and 164690887 are equal in every run. The senser gains 0.05-0.07 ms in the tick, a third of the harness gain. The brain phase loses 0.03-0.07 ms at the cap, probably from the two pools in the cache. I stopped the 1800 s pair in its base run, since the 60 s and 600 s results already decide it.

## Tests
- `tests/typescript/candLists.test.ts` (7 tests): differential against the walk (lists off, own kernels and world) over 300 ticks in 4 configurations. The configurations cover 1, 4, 8 and 13 rays, ray lengths 30-400 against cells of 40-170, item radius 0-10, fans of 0 to 360 degrees, and worlds of 2000 to 6000 wide.
- Every tick of the differential test has moves (small, past the skin, off the world), eating next to creatures and regrowth. Along the way come a repack of over 1024 cells, a world replaced by a copy, deaths with reused slots and rows, and resets to a new ray length. Brain inputs are compared word for word, and over 40% of the lists must be reused.
- Unit tests: skin (kept at 19.9, rebuilt at 22.5 and sees the item that then enters), dirty cells (kept for a far change, rebuilt for a near add and remove), and a restore (a new world and a reset of the kernels rebuild every list).
- Red without the stamp check (4 fail) and without the skin check (4 fail). The ecoLive save-restore test (wasm, 0 and 3 helper threads) runs the lists path.
- Full suite (load 31): 1263 of 1267 passed, exit 1. The 4 failures hit their own 20 s limits (three spawn tests in `cli.test.ts`, one in `liveReset.test.ts`). Run alone, `liveReset` passes and the two `cli` bench tests time out again at load 30. They spawn the bench, so the lists path is not their cause, but this is not proven.

## Verdict suggestion
Reject. It is exact and tested, but the tick is within noise (-0.5% mixed, +1% cap, -1.3% at 600 s) for 330 lines. A rebuild plus the per-creature validity check costs about what the row walk does. The item walk has no list-shaped saving left at this density.
