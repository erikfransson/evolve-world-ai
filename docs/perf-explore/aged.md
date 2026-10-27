# Aged: why does the cost per creature rise as a world ages? (idea 61)

Branch `pl-aged` (perf-live b14fdf4 + liveBench options). Study only, engine unchanged. Kept in `server/src/liveBench.ts`: `--keep <dir>` (keep the `--save` files), `--load <dir>` (restore the newest save instead of seeding; `--fixed` then caps births at the loaded count), `--reach` (scratch counters at start and end), `--scatter` (scratch, with `--load`: creatures moved to uniform random spots off rock).

## Verdict

1. The rise is not age and not clustering. At equal population and equal food count a 30-minute-old world and a young world cost the same per creature (4.24 vs 4.24 ms per tick per 1000 creatures, medians of 3 alternating runs), phase by phase within 3% except births and regrow. Scattering the aged creatures changed the total by -3.5%, mostly crowd grid.
2. The crowd and item walks are not where per-creature cost sits: aged creatures see 2.5x the neighbours of scattered ones (0.19 vs 0.075 within ray length) and the senser phase is identical (1.32 vs 1.33). Per creature the senser sees under 1 item and 0.2 neighbours, so its cost is the per-ray work, not candidates.
3. What does differ between a thinned late world and a fresh one: births/deaths turnover (births phase 0.17 per kilo aged vs 0.04 early in `late.md`; the aged world turns over a creature in about 80 s), and the fixed 0.6 ms per tick (`intercept.md`) spread over fewer creatures: 0.6 / 1.3 = 0.46 per kilo vs 0.19 at 3200, about +6% of the tick. Together they explain a few percent, not 27%.
4. The rest of the `late.md` rise is most likely machine drift: those windows ran with 5 other benches. Here the aged state at 1300 creatures costs 4.2 per kilo on a quiet pin, below the fresh default case (15.24 ms / 3300 = 4.6). The aging run itself gave cpuMsPerTick 10.77 at steady population 2366 (4.55 per kilo, fingerprint run mixed 1800 s).
5. No exact idea follows from clustering. Nothing to cut in the crowd walk (3% of the tick, candidates already near zero). The only per-creature item is births (0.17 per kilo, 4%), covered by `late.md` new idea 3 (cheaper births).

## How measured

Aged state: `liveBench --seconds 1800 --copies 800 --save 1800 --keep <dir> --reach` (tick 54000, 1351 creatures, 17627 food, mean age 2466 ticks, 8.3 MB save). Then each condition for 60 s with `--fixed --profile --reach`, 3 rounds alternating a, b, c, pinned to CPUs 2,3,6,7 at nice 19:
- a: `--load <dir> --fixed` (aged, clustered).
- b: `--copies 338 --fixed --food 0.1128` (young, 1352 creatures, 17625 food, the aged food count).
- c: `--load <dir> --scatter --fixed` (aged, positions randomized at the start).
- d: `--copies 812 --fixed --food 0.1128` (young, 3248, the size of the early window), 3 runs.
The runs are deterministic, so repeats give the same population and the spread is machine noise only. Table values are CPU ms per tick per 1000 creatures of the steady-window mean population (first quarter of 60 s left out), median of 3. `--fixed` caps births at the start count, so deaths are refilled. In b and d the young creatures starve first (population dips to 924 and 1900 before births refill), so their mean population is below the seeded count; the per-kilo normalisation uses the mean.

## Results (ms per tick per 1000 creatures)

| Phase            | a aged | b young 1352 | c aged scattered | d young 3248 |
|------------------|--------|--------------|------------------|--------------|
| crowd grid       | 0.159  | 0.125        | 0.133            | 0.167        |
| slots            | 0.126  | 0.118        | 0.120            | 0.128        |
| senser           | 1.320  | 1.344        | 1.330            | 1.365        |
| brain forward    | 1.393  | 1.415        | 1.319            | 1.500        |
| memory and steer | 0.432  | 0.416        | 0.427            | 0.493        |
| eat              | 0.372  | 0.369        | 0.361            | 0.373        |
| collisions       | 0.079  | 0.069        | 0.075            | 0.077        |
| settle and deaths| 0.042  | 0.042        | 0.040            | 0.045        |
| births           | 0.173  | 0.207        | 0.137            | 0.198        |
| regrow           | 0.031  | 0.052        | 0.033            | 0.031        |
| total (cpuMsPerKilo) | 4.235 (4.11-4.38) | 4.235 (4.22-4.64) | 4.089 (4.04-4.20) | 4.434 (4.28-4.53) |

A second set of a runs gave 4.17, 4.20, 4.60: machine noise is about +-5%, larger than any difference above except possibly the crowd grid.

## Counters (scratch `--reach`: creatures and items within each creature's own ray length, a disc proxy of the sense candidates)

| State                   | Creatures per creature | Items per creature | Nothing in reach | Rays | Memory | Weights |
|-------------------------|------------------------|--------------------|------------------|------|--------|---------|
| aged start (a)          | 0.19                   | 0.82               | 43%              | 8.61 | 4.14   | 1517    |
| aged end, 60 s later    | 0.20                   | 0.86               | 41%              | 8.59 | 4.12   | 1507    |
| scattered start (c)     | 0.075                  | 0.99               | 41%              | 8.61 | 4.14   | 1517    |
| scattered end           | 0.175                  | 0.72               | 44%              | 8.53 | 3.88   | 1454    |
| young 1352 start (b)    | 0.078                  | 0.97               | 36%              | 9.0  | 5.5    | 1876    |
| young 1352 end          | 0.145                  | 1.13               | 34%              | 8.88 | 5.08   | 1777    |

Aged creatures are not bigger: fewer rays, less memory, 19% fewer weights than the founders (selection toward the grazer and juggernaut shapes). The scattered world re-clusters to 0.175 within 60 s (food draws them), so c is a clean test only for the first seconds; the warm-up quarter is left out, so c mostly measures a half-reclustered crowd. Even so the senser phase is identical in a, b and c at 0.19 vs 0.075 vs 0.145 neighbours, so the result does not depend on that.
