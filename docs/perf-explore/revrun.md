# Idea 120: alternate the brain run direction (revrun, repeat of idea 27, rejected)

Branch `pl-revrun`. `WasmBrainBank.forwardRun` walks `order` ascending on one run and descending on the next (per-bank flag), so the last 4-8 MB of one tick's weight stream might still be in L3 when the next tick starts there. Same change as `boustro.md` (idea 27), which was rejected; this repeats it with the 108 motivation. Exact: fingerprints equal. About 6 lines in `brainKernel.ts` plus one unit test (ascending, descending and ascending runs give equal outputs).

Touch logic in `brain.wat` `forward` is direction-safe: `pf` starts at the next listed block's own weights and `pe` is that block's inputs minus 256, both read from the next block's descriptor, so nothing assumes the next block is above the current one.

## Measured
`liveBench --profile`, alternating pairs (base = perf-live in its own worktree), cores 2,3,6,7 idle priority. Brain forward ms / cpuMsPerTick.

| case              | pair | base fwd | base cpu | yours fwd | yours cpu |
|-------------------|------|----------|----------|-----------|-----------|
| mixed 60 s        | 1    | 3.85     | 10.15    | 4.08      | 10.52     |
| mixed 60 s        | 2    | 3.93     | 10.38    | 4.32      | 11.07     |
| mixed 60 s        | 3    | 3.97     | 10.41    | 4.39      | 11.26     |
| mixed 60 s, yours first | 1 | 3.97  | 10.41    | 4.29      | 11.01     |
| mixed 60 s, yours first | 2 | 4.18  | 11.06    | 4.20      | 10.83     |
| mixed 60 s, yours first | 3 | 4.23  | 11.19    | 4.43      | 11.41     |
| cap 4900          | 1    | 4.38     | 13.44    | 4.59      | 13.72     |
| cap 4900          | 2    | 4.25     | 13.20    | 4.61      | 13.63     |
| cap 4900          | 3    | 4.32     | 13.35    | 4.64      | 13.80     |
| mixed 600 s       | 1    | 4.22     | 10.29    | 4.12      | 9.88      |
| mixed 600 s, yours first | 1 | 3.99 | 9.62   | 4.12      | 9.84      |

Medians: mixed 60 s fwd 3.93 -> 4.32 (yours first order: 4.18 -> 4.29), cpu 10.38 -> 11.07; cap fwd 4.32 -> 4.61 (+6.7%), cpu 13.35 -> 13.72 (+2.8%). The 600 s pairs disagree in sign (-2% and +3.5%), so they are noise; the senser, which this does not touch, moves by the same amount there. Fingerprints equal everywhere (708687555 mixed 60 s, 10334191 cap, 164690887 mixed 600 s). Peak RSS equal (216-242 MB mixed, 256 cap).

## Verdict
No gain, consistently a few percent worse in brain forward (mixed and cap), as in idea 27. Do not merge. A fixed order apparently serves the ascending hardware stream across blocks better than the L3 tail reuse helps; the sense and steer phases between brain runs probably evict the tail anyway. The 108 second-pass effect is a same-brain-twice effect (L2), not reachable by ordering across 24 MB.
