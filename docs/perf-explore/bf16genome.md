# bf16-valued genomes and a 16-bit weight bank (idea 111, moonshot)

Branch `pl-bf16genome` (from perf-live ebf3bfd). A game-rule change for Erik, behind two prototype switches, both off by default (off is today's engine, fingerprint 708687555 as perf-live).
- `EVOLVE_BF16_GENOME=1`: `Brain` rounds its genome copy to the nearest bf16 (round to nearest even) whenever it is built or loaded. Every genome a creature carries (seeded founder, pool copy, upload, child after mutation and remap, restore) passes through it, and children copy the parent's brain genome, so genomes hold and pass on only bf16 values.
- `EVOLVE_BF16_BANK=1`: `WasmBrainBank` stores weights and biases as u16 (the top 16 bits), inputs and outputs stay f32 behind a 16-byte aligned weight area. `brain.wat` gains `$layer16` and `forward16` (today's `$layer` and `forward` untouched, so idea 95 can be compared); every 8 weights are one `v128.load` widened by two `i8x16.shuffle` against zero (V8 emits `punpcklwd`/`punpckhwd`, the shuffle port, which the multiply-adds do not use), then the same f32 multiply-adds in the same order. Any layer width (groups of 6 to 1 vectors, odd last vector by `v128.load64_zero`).
- With rounded genomes the two banks give bit-identical outputs (320 brains of 8 shapes from 1x1 to 93x24x24x24x24x18, 2800 outputs, 0 differences) and equal fingerprints in every bench run below. Against today's unrounded worlds the fingerprint differs by construction.

## Speed
`liveBench --seconds 60 --profile`, cores 2,3,6,7 at idle priority, load 10-13, alternating pairs. Base is this branch with `EVOLVE_BF16_GENOME=1` (f32 bank), so both sides run the same bf16 world.

| Case                  | Side           | cpuMsPerTick           | brain forward       | senser              | peakRssMB     | Fingerprint |
|-----------------------|----------------|------------------------|---------------------|---------------------|---------------|-------------|
| 4 founders x 800      | f32 bank       | 11.18, 11.22, 11.48    | 4.11, 4.10, 4.27    | 4.15, 4.17, 4.20    | 218, 216, 215 | 427688701   |
| 4 founders x 800      | bf16 bank      | 10.83, 10.92, 11.04    | 3.95, 4.00, 4.03    | 4.03, 4.04, 4.09    | 203, 206, 207 | 427688701   |
| Juggernaut x 4900     | f32 bank       | 12.86, 13.42, 13.16    | 4.00, 4.22, 4.14    | 4.97, 5.14, 5.06    | 257, 253, 260 | 98041826    |
| Juggernaut x 4900     | bf16 bank      | 12.74, 12.70, 12.38    | 3.76, 3.76, 3.62    | 5.05, 5.03, 4.91    | 244, 243, 247 | 98041826    |

Ratio of medians: mixed tick 1.027x, brain 1.029x; cap tick 1.036x, brain 1.10x. Peak RSS 10-15 MB lower (the bank holds 6.2 M weights, 12.5 MB fewer bytes). Flags off: 10.64 ms and 708687555, perf-live 10.88 ms and 708687555 in the same session.
Why so little: `pagepack.md`'s footprint sweep is already flat past the knee (0.795 us per brain at 10 MB, 0.817 at 24 MB), so halving 24 MB to 12 MB stays on the plateau; the rest of the kernel is f32 multiply-add throughput, which bf16 does not change. This agrees with `bf16.md` (widening by `load16x4_u` + shift, neutral).

## Ecology
`liveBench --seconds 600 --copies 800 --seed N --every 60`, today's genomes (flags off) against bf16 genomes (both flags on). The f32 rows repeat `think2.md`'s thinkEvery 1 runs exactly.

| Seed | Genome | Births | Deaths | Food left | Pop 60 / 300 / 600 s | Mean age 600 s (s) | Lifespan of dead, last min (s) | Lineage share 600 s (expl / graz / jugg / orac) |
|------|--------|--------|--------|-----------|----------------------|--------------------|-------------------------------|-------------------------------------------------|
| 1    | f32    | 5052   | 5243   | 18955     | 3284 / 3180 / 3009   | 424                | 158                           | 0.110 / 0.271 / 0.321 / 0.298                   |
| 1    | bf16   | 5304   | 5492   | 18970     | 3262 / 3204 / 3012   | 423                | 155                           | 0.128 / 0.275 / 0.297 / 0.299                   |
| 2    | f32    | 4910   | 5099   | 19243     | 3323 / 3233 / 3011   | 426                | 152                           | 0.109 / 0.293 / 0.299 / 0.300                   |
| 2    | bf16   | 4351   | 4587   | 19666     | 3301 / 3139 / 2964   | 447                | 168                           | 0.119 / 0.274 / 0.299 / 0.309                   |
| 3    | f32    | 5878   | 5976   | 18207     | 3331 / 3250 / 3102   | 405                | 153                           | 0.108 / 0.311 / 0.298 / 0.283                   |
| 3    | bf16   | 5081   | 5244   | 18892     | 3291 / 3152 / 3037   | 417                | 143                           | 0.121 / 0.290 / 0.293 / 0.295                   |

- Population, births, deaths, food, mean age, lifespan, speed (72.5-73.3) and turn rate (0.70-0.71) lie inside the seed-to-seed spread of the f32 runs (births 4910-5878 against 4351-5304, the per-seed sign flips).
- One consistent sign: the Explorer lineage ends 1.0-1.8 points higher in all three bf16 seeds (0.119-0.128 against 0.108-0.110). Its share falls from 0.25 in both, the curves overlap until minute 8, so it is small and not established with three seeds; it may come from rounding the trained founders once (mean relative change 0.14%) rather than from evolution.
- Mutation: the live mutation std is 0.3 (rate 0.05). Sampled on the founders' weights, a mutation that rounds back to the parent's value happens 1.1% of the time (step error 0.9% of the step size); at the smallest insert scale (x0.25, std 0.075) 4.2% (3.3%). So steps below about 1/256 relative are lost, but such steps are rare at today's settings; fine-tuning below that resolution is not possible.

## Representability today
- Founders (`live-founders.json`, 7502 values): 0.65-0.91% already bf16, mean absolute rounding error 0.0019-0.0020 against a mean |weight| of 1.34-1.43 (relative 0.14% mean, 0.38% max).
- 600 s save of seed 1, f32 (3009 creatures, 6.24 M values): 0.72% bf16, mean abs error 0.00199, relative 0.14%. The bf16 run's save is 100% bf16 after save and restore.
- Side effect: that save gzips to 8.5 MB against 11.7 MB (-27%).
- No save of the real Live world was at hand, so "live" here means the founders plus a 600 s bench world.

## Tests
`vitest run wasm thinkEvery brain ecoPool --maxWorkers=2 --testTimeout=180000`: flags off 146 of 146, exit 0. Both on: 142 of 146, exit 1; the 4 failures are pins of unrounded values (two pinned fingerprints 81047108 in thinkEvery, one in ecoPool, and the hand-computed network of brain.test, off by 1e-4). Genome flag alone adds 3 wasmKernels failures, because those tests hand raw genomes to the f32 bank while `Brain` rounds; the bf16 bank rounds at `set`, so with both on they pass.

## Verdict suggestion
Not worth a rule change for speed: 1.03x mixed, 1.04x at the cap (under the 5% bar), with 12 MB less bank memory and saves 27% smaller. Ecology at 600 s is inside the seed spread except a small, unproven Explorer shift. If Erik ever wants it (for smaller saves and memory, or determinism), the code is ready behind the two flags; it would need a config field instead of env switches, new pinned fingerprints and a fresh world, and a longer lineage check first. Keep on the branch, do not merge.
