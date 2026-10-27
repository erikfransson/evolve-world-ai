# Late: what dominates the tick in an aged live world (idea 43)

Branch `pl-late` (perf-live 2ec51cb + 1 line in `server/src/liveBench.ts`: each `--profileEvery` window also prints `weightsPerCreature`, `eco.weights / eco.population` at the window end). Study only, no engine change.

## How measured
`liveBench --seconds 1800 --profile --profileEvery 300`, one run at a time, pinned to CPUs 2,3,6,7 at nice 19 with 5 other benches running. Cap case `--only juggernaut --copies 4900`, mixed case `--copies 800`. Columns are CPU ms per tick per 1000 creatures (window mean population), the phases sum to the total within 1%, so nothing is outside them.
Absolute levels are about 10-20% above `aging.md` (same mixed fingerprint 847136415, so identical results; this laptop was slower under the pin). Compare windows within one run. Repeating the cap case for 600 s (`--copies 1300`, but births refill it to 4259 within 300 s) gave 3.94 / 4.35 against 3.65 / 4.13 in the long run, so run-to-run drift is about 6%.

## Cap case (Juggernaut x 4900), ms per tick per 1000 creatures
| Window s | Pop  | Weights/creature | Food  | Total | Crowd | Slots | Senser | Brain | Mem+steer | Eat   | Coll  | Settle | Births | Regrow |
|----------|------|------------------|-------|-------|-------|-------|--------|-------|-----------|-------|-------|--------|--------|--------|
| 0-300    | 4356 | 1236             | 21282 | 3.65  | 0.139 | 0.265 | 1.300  | 1.037 | 0.377     | 0.311 | 0.060 | 0.038  | 0.101  | 0.015  |
| 300-600  | 2897 | 1236             | 19328 | 4.13  | 0.173 | 0.289 | 1.389  | 1.151 | 0.486     | 0.348 | 0.065 | 0.042  | 0.156  | 0.021  |
| 600-900  | 2510 | 1240             | 18805 | 4.20  | 0.165 | 0.297 | 1.399  | 1.190 | 0.518     | 0.350 | 0.066 | 0.041  | 0.140  | 0.024  |
| 900-1200 | 2031 | 1241             | 18243 | 4.39  | 0.162 | 0.325 | 1.439  | 1.258 | 0.550     | 0.371 | 0.071 | 0.041  | 0.134  | 0.027  |
| 1200-1500| 1611 | 1244             | 17917 | 4.52  | 0.160 | 0.345 | 1.475  | 1.286 | 0.572     | 0.391 | 0.074 | 0.041  | 0.130  | 0.030  |
| 1500-1800| 1335 | 1250             | 18110 | 4.64  | 0.153 | 0.366 | 1.508  | 1.313 | 0.584     | 0.413 | 0.076 | 0.041  | 0.126  | 0.033  |

Run: cpuMsPerTick 8.61, peak RSS 368 MB, 66089 births, 69674 deaths, fingerprint 407185467. The population falls from the 4900 seed to 1300 (the seeded clones die off, then the survivors settle).

## Mixed case (4 founders x 800)
| Window s | Pop  | Weights/creature | Food  | Total | Crowd | Slots | Senser | Brain | Mem+steer | Eat   | Coll  | Settle | Births | Regrow |
|----------|------|------------------|-------|-------|-------|-------|--------|-------|-----------|-------|-------|--------|--------|--------|
| 0-300    | 3249 | 1962             | 24613 | 4.31  | 0.071 | 0.272 | 1.510  | 1.522 | 0.446     | 0.332 | 0.062 | 0.026  | 0.040  | 0.019  |
| 300-600  | 3086 | 2074             | 18955 | 4.29  | 0.077 | 0.267 | 1.388  | 1.582 | 0.490     | 0.322 | 0.059 | 0.027  | 0.047  | 0.018  |
| 600-900  | 3020 | 2041             | 15776 | 4.52  | 0.099 | 0.278 | 1.398  | 1.678 | 0.530     | 0.337 | 0.061 | 0.030  | 0.075  | 0.018  |
| 900-1200 | 2956 | 2493             | 13874 | 4.67  | 0.142 | 0.278 | 1.378  | 1.720 | 0.544     | 0.337 | 0.061 | 0.038  | 0.146  | 0.017  |
| 1200-1500| 1749 | 2058             | 17571 | 5.44  | 0.180 | 0.321 | 1.559  | 2.005 | 0.605     | 0.393 | 0.071 | 0.045  | 0.212  | 0.025  |
| 1500-1800| 1403 | 1517             | 17627 | 5.14  | 0.172 | 0.337 | 1.584  | 1.684 | 0.600     | 0.422 | 0.075 | 0.044  | 0.170  | 0.029  |

Run: cpuMsPerTick 11.29, peak RSS 376 MB, 38255 births, 40104 deaths, fingerprint 847136415 (equal to `aging.md`).

## Findings
1. Per creature the tick gets dearer as the world thins, not as it ages: cap total 3.65 -> 4.64 (+27%) while the population falls 4356 -> 1335, and in ms per tick every phase falls roughly linearly with population but with an intercept. Least squares over the six windows, ms/tick = F + v x kilo-creatures: total F 2.2 (cap) / 2.7 (mixed), v 3.2 / 3.6. Per phase F (cap / mixed): brain 0.64 / 0.75, mem+steer 0.50 / 0.36, senser 0.45 / 0.41, slots 0.20 / 0.17, eat 0.21 / 0.24, crowd 0.05 / 0.27, births 0.08 / 0.39. At 1300 creatures that intercept is 35% of the tick. Whether F is a real per-tick fixed cost or per-creature cost that rises at low density (cache, branch behaviour) is not separated; population and age move together here.
2. Late shares (1500-1800 s), cap / mixed: senser 32% / 31%, brain 28% / 33%, mem+steer 13% / 12%, eat 9% / 8%, slots 8% / 7%, crowd 3% / 3%, births 3% / 3%, collisions 2%, settle 1%, regrow 0.7%. The first cap window (0-300 s) has senser 36%, brain 28%: the senser share falls a little late, the brain share is flat, mem+steer and eat rise (+55% and +33% per creature in the cap run, identical brains).
3. Senser follows creature density, with a small food term. Cap: food falls 21.3k -> 18.1k (-15%) and senser per kilo rises 16% while the population falls 69%. Mixed: windows 1-4 hold the population (3249 -> 2956) while food falls 44% and senser per kilo falls 9%; windows 5-6 lose 41% of the creatures, food rises 27% and senser per kilo rises 13%. In ms per tick the senser is 1.21 (cap) to 1.29 (mixed) per 1000 creatures plus about 0.4 intercept (about 20 ns per food item, unverified).
4. Brain forward per creature: in the cap world the brains do not change size (weights/creature 1236 -> 1250, +1% in 1800 s), yet forward per creature rises 27% (1.037 -> 1.313, 0.84 -> 1.05 ms per tick per million weights). The rise is not cache pressure (6.6 MB of weights at the end fits the 12 MB L3 where 24 MB did not at the start). The 600 s repeat shows the first step (+10-11%) again, so it is not noise. Mixed: the weights/creature column follows founder selection (1962 -> 2493 -> 1517), not growth, and brain per creature follows it (1.52 -> 1.72 at 2493, 1.68 at 1517). So at the ages reached in 30 min structural mutation does not move brain cost; selection among founders does. Longer ages (days) are not covered.
5. Births, settle and regrow late: births are 0.10-0.21 per kilo, 2.7-3.3% of the tick (about 0.3-0.4 ms CPU per birth; 1.2 / 0.7 births per tick in the two runs), settle and deaths 0.9-1.0%, regrow 0.5-0.7% (but doubled per creature, 0.015 -> 0.033). Births are small, not negligible, and are the one phase that grows in the mix at 900-1500 s (0.04 -> 0.21).

## Which campaign ideas matter late
- More: sense ideas (36 rays8, 41 missout, 14 early-out, 35 touchskip): the senser is a third of the tick and the world is sparser, so more creatures have nothing in reach. Brain ideas (38 unroll, 42 widths, 9 blocks): brain is 28-33%, and the cap-case brains are small (1236 weights, short column loops), so loop overhead per call counts more than weight bandwidth.
- Less: idea 17 stream-touch (weights fit L3 when the population thins, fresh gain was 1.19x on the cap), 33 / 40 grid reuse (crowd is 3%), 22 save stall already done, 1 / 18 stay at the same proportion.
- Unaffected: eat kernel, collisions, regrow (under 2% each).

## New ideas the late mix suggests (none built)
1. Study first: what is the 2.2-2.7 ms per tick intercept? Profile a 100-creature world with 18k food (expected: item grid and per-tick JS setup). If half is removable this is 1.5-2x as large as any remaining kernel idea at 1300 creatures, 5-8% of the tick; phase: spread over senser, brain, mem+steer.
2. Memory and steer per creature +55% with age/thinning in a single-shape world: find what scales (expected: a branch on age or memory state, or the sin/cos host calls); size up to 0.2 ms/tick late, 2%.
3. Cheaper births (0.3-0.4 ms each): reuse the parent's genome buffers and bank slot instead of building plan, genome and brain separately; expected 1-2% late, less fresh.
4. Brain forward fixed cost per call: batch the block-iteration setup for small brains (cap Juggernaut); expected up to 0.3 ms/tick if the 0.64 ms intercept is call overhead, to be confirmed by timing a run with the kernel call count.

## Verdict suggestion
Keep the `weightsPerCreature` window field (bench only). The late tick is the same phases in the same order as the fresh one; no phase newly dominates, so the campaign's sense and brain ideas stay the right ones, and the fixed-per-tick intercept (finding 1) is the study worth doing next.
