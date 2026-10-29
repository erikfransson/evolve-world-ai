# Idea 87: WebAssembly branch hints for sense and brain

Verdict suggestion: reject. Exact (fingerprints equal) but no measurable gain.

Support: wabt 1.0.39 emits the `metadata.code.branch_hint` section with `{ annotations: true, code_metadata: true }` (annotations alone drops it silently). Node 24.18 has `--experimental-wasm-branch-hinting`; without the flag the section is ignored.
Change: `(@metadata.code.branch_hint "\00")` (unlikely) on loop-exit `br_if`s in sense.wat and brain.wat (50 total) and on rare `if`s in sense.wat (wall contact, detail record, rock disc hit, row-bound fixups, any_true, remainder). `wasmAssemble.ts` passes the two features.

Bench (`liveBench --seconds 60`, cpuMsPerTick, 3 alternating triples base / hinted-no-flag / hinted-flag, fingerprints 708687555 and 10334191 equal in all runs, peakRssMB same):

| case                | base                  | hinted, no flag       | hinted, flag          |
| ------------------- | --------------------- | --------------------- | --------------------- |
| copies 800          | 12.501 12.714 12.920  | 12.853 12.923 12.984  | 12.393 12.686 12.333  |
| median              | 12.714                | 12.923 (+1.6%)        | 12.393 (-2.5%)        |
| juggernaut 4900     | 15.775 16.095 16.366  | 15.965 16.652 16.463  | 16.053 16.432 16.288  |
| median              | 16.095                | 16.463 (+2.3%)        | 16.288 (+1.2%)        |

Spread between runs of one arm is about 3%, so the -2.5% on one case is inside noise and the other case goes the wrong way.
Caveat: a vitest run was started and stopped during the second case 800 triple, which may have disturbed it.
Also the server would need the experimental flag in its service file. Not worth it.
