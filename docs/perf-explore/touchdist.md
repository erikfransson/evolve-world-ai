# Brain touch stream: distance, spread, extra targets (idea 101)

Branch `pl-touchdist`, docs only (no engine change kept). Base `perf-live` 47ed279 (constants in locals).
Question: the scout (`scout-brain.md`) found a second pass over each brain 28-35% faster, so the first pass still pays L1 fills the touch stream (`brain3.md`) does not cover. Is the stream too short-reaching, too late, spread wrongly, or missing targets?

## How measured
- Kernel A/B: world dumped at tick 600 (mixed 3318 brains, juggernaut x 4900), `forward` of the full run list on the dumped memory, one wasm instance per variant, interleaved (order flipped each rep), user CPU, median of 31, cold = 48 MB eviction, after it the input vectors and descriptors are read back (the senser has just written them). Memory hash equal to base in every variant (touches are pure loads). Two copies of base give the noise: 0.985-1.015. Cores 2,3,6,7, load 20-35.
- Tick: `liveBench --seconds 60 --profile`, 3 alternating pairs per case, base = perf-live worktree. Harness and variant generator (`gen.py`, text edits of brain.wat) were in the session scratchpad `td/`, not committed.
- Reads of `pfrows.md`, `touch6.md`, `brain3.md` first: skipping dead rows, touches in the 5-6 vector loops, 3-6 lines, 128-192 B apart are already rejected.

## Kernel A/B (ratio to base, higher is faster; cold, mixed / juggernaut)

| Variant                                                                    | Mixed         | Juggernaut    |
|----------------------------------------------------------------------------|---------------|---------------|
| base (second copy, noise)                                                  | 1.013-1.015   | 0.985-1.006   |
| no touches (control)                                                       | 0.896-0.917   | 0.847         |
| (a) a1: stream over brain i+2 instead of i+1                               | 0.979-1.012   | 0.977         |
| (a) a2: one line per iteration into i+1 and one into i+2 (+64 each)        | 0.852         | not run       |
| (a) a2b: two lines into i+1, one into i+2                                  | 0.922         | not run       |
| (a) a2c: one line into i+1, two into i+2                                   | 0.980-1.000   | 0.949         |
| (b) b1: one line per iteration (+64)                                       | 0.897-0.942   | 0.816         |
| (b) b2: burst at loop start of the share the loop would touch              | 0.962         | not run       |
| (b) b2h: half burst at start, half one line per iteration                  | 0.977         | not run       |
| (b) b3k2: 4 lines every 2nd iteration (+256)                               | 1.017-1.023   | 1.006         |
| (b) b3k4: 8 lines every 4th iteration (+512)                               | 0.986-0.999   | 0.942         |
| (c) c1: at brain start touch next brain's input vector lines                | 0.916         | not run       |
| (c) c2: c1 plus its output line                                            | 0.912         | not run       |
| (d) d1: at brain start touch each layer's first line and bias row (next)    | 0.909         | not run       |
| (d) d1c: d1 plus c2                                                        | 0.924         | not run       |
| (e) own-row lookahead, 2/4/8 list entries ahead, plus the stream           | 0.980-0.989   | 0.914-0.938   |
| (e) same lookahead instead of the stream                                   | 0.871         | 0.742         |

(e) was added: it tests the L1-fill hypothesis directly by touching the current brain's own rows a few iterations ahead (list entries clamped to the input count so every touch is in bounds).

## Whole tick (cpuMsPerTick and brain forward phase, `--profile`, 3 alternating pairs)

| Variant | Case      | Tick base                 | Tick yours                | Brain base               | Brain yours              | Ratio tick / brain | Fingerprint    | Peak RSS MB (base / yours) |
|---------|-----------|---------------------------|---------------------------|--------------------------|--------------------------|--------------------|----------------|----------------------------|
| b3k2    | mixed     | 11.745, 12.001, 12.024    | 11.721, 11.853, 11.886    | 4.29, 4.385, 4.364       | 4.265, 4.338, 4.313      | 1.012 / 1.012      | 708687555 both | 215-218 / 216-221          |
| b3k2    | juggernaut| 14.159, 14.158, 14.439    | 14.212, 14.349, 14.148    | 4.374, 4.373, 4.464      | 4.369, 4.475, 4.36       | 0.996 / 1.001      | 10334191 both  | 253-256 / 252-258          |
| c1      | mixed     | 12.028, 11.855, 11.734    | 12.299, 12.064, 12.566    | 4.409, 4.377, 4.326      | 4.755, 4.689, 4.871      | 0.964 / 0.921      | 708687555 both | 219-221 / 216-221          |
| c1      | juggernaut| 14.567, 14.14, 14.126     | 14.926, 15.136, 15.063    | 4.561, 4.343, 4.32       | 5.132, 5.193, 5.19       | 0.939 / 0.837      | 10334191 both  | 254-256 / 253-256          |
| a1      | mixed     | 11.748, 11.789 (1 run failed, exit 1) | 12.145, 11.993, 11.682 | 4.201, 4.288     | 4.451, 4.399, 4.291      | 0.981 / 0.965      | 708687555 both | 216-217 / 215-219          |
| a1      | juggernaut| 13.467, 14.116, 14.105    | 14.07, 14.342, 14.713     | 4.12, 4.326, 4.356       | 4.428, 4.539, 4.676      | 0.983 / 0.953      | 10334191 both  | 252-256 / 256-258          |

## Findings
- Distance is not the problem. Streaming over brain i+2 (a1) is level or slightly worse; the run list is in block address order, so i+1 is usually the adjacent block and the stream already runs far enough ahead. Splitting the budget between i+1 and i+2 (a2 family) is 2-15% worse: the two streams lose the unbroken ascending run the hardware streamer needs (same cause as `pfrows.md`).
- Spread: the plain 2 lines per iteration is at the optimum. One line per iteration reaches too little (0.82-0.94). Bursts at loop start (b2, b2h) and touch-at-brain-start targets (c, d) all lose 2-9%: a burst of loads that miss stalls retirement, as in `brain3.md`. Four lines every second iteration (b3k2) ties base (tick 1.012 mixed, 0.996 cap, inside the 1.5% bar); eight every fourth is worse.
- (c) Inputs and descriptors: refuted as a target. With them read back after the eviction (as the senser leaves them), touching the next brain's input and output lines costs 8-9% in the kernel and 0.38 / 0.85 ms in the tick; they were already in cache.
- (d) Bias rows and layer starts in run order: -9%, no gain over the linear stream that reaches them anyway.
- (e) Touching the current brain's own rows 2-8 entries ahead cannot beat the stream: -1 to -7% with it, -13 to -26% instead of it. The L1 fills of the first pass are therefore not recoverable by a dropped load in WASM; the loads' own issue cost equals or exceeds the stall they hide. Without perf counters the mechanism behind the scout's 28-35% second-pass gain is still unverified (candidates left: L1 fill bandwidth when each iteration brings a new line, the address-translation cost of 6000 pages).

## Verdict suggestion
Reject all. Nothing is clearly above the noise: best is b3k2 at +1.2% tick (mixed) and -0.4% (cap), under the 1.5% bar, and it adds a branch per iteration. The current stream (2 lines, +128, next brain, 1-4 vector loops) sits at a local optimum for distance, spread and targets. No engine change committed.

## Tests
Engine unchanged. `npx vitest run wasm thinkEvery brain --maxWorkers=2 --testTimeout=300000`: 8 files, 118 tests, exit 0.
