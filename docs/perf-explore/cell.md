# Item and crowd grid cell size (idea 20): rejected

Question: the item grid (`World.cell`) and the crowd grid (`Crowd.cell`) take the engine config's ray length (liveConfig: 100) while the live founders' plans see 170, so the sense kernel visits about 4.5 rows x 4.4 cells per creature. Does a larger cell cut the senser phase and the tick?

Setup: scratch factors `CELL_ITEM_F` and `CELL_CROWD_F` multiplied into the two constructors (reverted, nothing kept). `liveBench --seconds 60 --copies 800 --profile` and the cap case (`--only juggernaut --copies 4900`), variants rotated per round, ms per tick is user CPU. Load was 10-12 on 8 cores, so a run sometimes lands at 10 ms for no reason (outliers 9.8-11.8 hit base and variants alike); medians are used. Plan ray length range is 50-250 (`eco.rayLengthRange`), so 2.5x would be the "largest plan" cell.

## Mixed case (3300 creatures), base cells 100 / 100

| Item x | Crowd x | Pairs | cpuMsPerTick median | Ratio | Senser median | Ratio | Fingerprint |
|-------:|--------:|------:|--------------------:|------:|--------------:|------:|-------------|
| 1      | 1       | 8     | 13.13 / 13.03       | 1.000 | 4.83 / 4.79   | 1.000 | 708687555   |
| 1.25   | 1       | 5     | 12.91               | 0.991 | 4.75          | 0.991 | 452473710   |
| 1.5    | 1       | 3 + 5 | 12.15 / 12.95       | 0.926 / 0.994 | 4.38 / 4.72 | 0.906 / 0.985 | 131872259 |
| 2      | 1       | 3 + 5 | 12.92 / 12.92       | 0.984 / 0.992 | 4.67 / 4.70 | 0.967 / 0.980 | 500818788 |
| 3      | 1       | 3     | 13.01               | 0.991 | 4.79          | 0.991 | 417044420   |
| 1      | 1.5     | 3     | 12.85               | 0.979 | 4.75          | 0.983 | 708687555   |
| 1      | 2       | 3     | 12.89               | 0.982 | 4.75          | 0.983 | 150870810   |
| 1      | 3       | 3     | 12.88               | 0.981 | 4.79          | 0.991 | 708687555   |
| 1.5    | 1.5     | 5     | 12.80               | 0.982 | 4.67          | 0.974 | 131872259   |

(Two entries are two batches; the first batch had fast outlier runs that flatter 1.5x.) Crowd grid phase 0.41 -> 0.33-0.36, eat 0.94 -> 0.85-0.88 at crowd 1.5-3x, senser -0.05 ms at best.

## Cap case (4900 juggernauts), 4 pairs

| Item x | Crowd x | cpuMsPerTick median | Ratio | Senser median | Ratio | peakRssMB | Fingerprint |
|-------:|--------:|--------------------:|------:|--------------:|------:|----------:|-------------|
| 1      | 1       | 15.84               | 1.000 | 6.06          | 1.000 | 258       | 10334191    |
| 2      | 1       | 15.70               | 0.991 | 5.91          | 0.976 | 254       | 798861315   |
| 1.5    | 1.5     | 15.59               | 0.984 | 5.87          | 0.969 | 253       | 518709133   |

## Exactness

Not exact. The ray results take the nearest candidate and do not depend on cell order, but `touchedBatch` and the WASM touch kernel return the first touching item in cell and list order. Scratch counter over a 60 s mixed run (1800 ticks, 5.95 M creature-ticks): 63.4k creature-ticks touch an item, of which 175 (0.3%) touch two or more at once, in 168 of 1800 ticks (9%). At 1.5x: 183 / 174 ticks, at 2x: 176 / 168. Those few ties are the only place the item cell order enters, so the fingerprint change (every factor, 1.25x to 3x) is a tie-break, not a bug. A crowd cell change reorders the cell-sorted creature order (collision sweep order), and changes the fingerprint at 2x, not at 1.5x and 3x. Memory is unchanged within noise (peakRssMB 213-219 mixed, 253-258 cap); `rowCap` in senser.ts follows the widest row, rows get fewer as cells widen, so the packed total stays about the same.

## Verdict

Reject. Best case is 1-2% of the tick (about 0.2 ms) and 2-3% of the senser, within the spread of the pairs, and it changes the fingerprints. The walk cost is not set by the cell count: bigger cells cut loop entries but scan more items per cell. Crowd 1.5x alone gives -2% for free of the item tie-break, but it also lands inside the noise. No production change, nothing committed but this note; tests were not run because no code is kept.
