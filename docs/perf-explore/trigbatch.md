# Idea 25: batch the sin and cos host calls of the step kernel

Branch `pl-trigbatch`. Question: does removing the 6600 wasm to JS transitions per tick (stepk.md: 0.31 ms of the `memory and steer` phase) pay when sin and cos are filled by one JS loop?

## What
`step.wat` is two exports. `heading` (pass 1) computes turn and heading per row with the same f64 ops in the same order as before, stores them in the row and writes the heading to a 24 byte entry (heading, sin, cos) at `P_TRIG`. `stepKernel.ts` then loops `Math.sin(h)`, `Math.cos(h)` over the entries. `step` (pass 2) reads sin and cos from the entry and does the rest unchanged. The `math` imports are gone. The table is a `Region` grown with the row count (24 bytes per row). Exact: the heading fed to Math.sin/cos is the same f64, and the other ops are untouched. Fingerprints equal.

## Results (liveBench `--profile`, 60 s, alternating, nice 19; phase `memory and steer` in ms/tick)

| Case              | Base phase                        | Yours phase                       | Tick base (cpuMsPerTick)     | Tick yours                   | Fingerprint     | Peak RSS (MB) |
|-------------------|-----------------------------------|-----------------------------------|------------------------------|------------------------------|-----------------|---------------|
| Inland Sea, 3300  | 1.152 1.171 1.156 1.167 1.157     | 1.234 1.229 0.962* 1.220 1.222    | 13.14 13.21 13.15 13.17 13.14 | 13.17 13.21 10.14* 13.13 13.14 | 708687555 equal | 214-245 / 216-218 |
| Juggernaut, 4900  | 1.308 1.453 1.449                 | 1.560 1.554 1.555                 | 14.0 15.9 16.1               | 16.1 16.0 16.1               | 10334191 equal  | 253-256 / 251-255 |

\* one run where the whole machine happened to run fast (tick 10.1); ignore.

Phase delta: +0.06 ms (5%) mixed, +0.10 ms (7%) cap. Whole tick unchanged (inside noise).

## Why no gain
The transitions removed are cheaper than the stepk estimate (that figure came from the constants variant, which also drops the dependency chain). Added: a second walk over all rows (loads of species block, output pointer, row heading again), the 24 byte table write and read, and the JS loop's typed array stores. These cost more than the 6600 host calls saved.

## Verdict
Reject. Slower in the phase on both cases, whole tick equal. Tests (nice 19, --maxWorkers=2): `wasmKernels` exit 0 (29), `thinkEvery` exit 0 (8), `residentBodies wasmStep` exit 0 (27).
