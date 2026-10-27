# Peak memory: where perf-live's extra 75 MB at 1800 s comes from

Branch `pl-mem` (from perf-live c665844), docs only. Question: perf-live peaked at 373-375 MB RSS in 1800 s runs against 299 MB on perf-base (60 s: 214-219 both). Leak or timing?

## How measured
`node --import <hook> --expose-gc src/liveBench.ts --seconds N --copies 800`, one run at a time, nice 19. The hook (scratch, not committed) wraps `WebAssembly.Instance` to catch the kernel memory and at exit prints `process.memoryUsage()` before and after two `gc()` calls plus the WebAssembly.Memory byte length. Only one memory exists (the kernels share the bank's). Fingerprint 847136415 in all 1800 s runs.

## Numbers (MB)

| Run                     | peak RSS | heapTotal | heapUsed | external | wasm memory | cpuMsPerTick |
|-------------------------|----------|-----------|----------|----------|-------------|--------------|
| base 900 s, run 1       | 273.6    | 92.0      | 15.6     | 109.7    | 45.9        |              |
| base 900 s, run 2       | 272.4    | 92.8      | 15.6     | 109.0    | 45.9        |              |
| perf-live 900 s, run 1  | 274.0    | 92.5      | 16.2     | 111.2    | 50.6        |              |
| perf-live 900 s, run 2  | 271.9    | 93.3      | 16.2     | 111.2    | 50.6        |              |
| base 1800 s             | 296.7    | 89.2      | 10.9     | 132.0    | 58.1        | 10.68        |
| perf-live 1800 s        | 373.1    | 156.7     | 11.5     | 132.2    | 57.0        | 8.94         |
| perf-live 1800 s, `--max-old-space-size=80` | 264.5 | 63.7 | 11.4 | 130.9 | 57.0 | 9.05 |

(heapTotal, heapUsed, external before the forced gc.) After the forced gc: heapUsed 10.4 (perf-live) vs 9.9 (base), heapTotal 143 vs 78, rss 360 vs 275.

## Findings
1. At 900 s there is no difference (272-274 both). The gap exists only in the 1800 s run.
2. Not the kernel memory: 57.0 vs 58.1 MB at 1800 s (50.6 vs 45.9 at 900 s, +4.7 MB, from the order/mark arrays, rock table and the offset tables, then equal). So the pooled offset tables, arena free lists and the brain bank arrays are bounded and are not the cause. External (wasm buffer plus ArrayBuffers) is equal, 132 MB.
3. It is the V8 heap capacity: heapTotal 157 vs 89 MB while live data (heapUsed after gc) is 10-11 MB on both. `--trace-gc`: both runs do 6 mark-compacts and about 295 scavenges (same allocation rate). On perf-live the 6th mark-compact (559 s) ran at 68.5 MB used of 173 MB total and freed 57 MB of promoted garbage, on base the heap stayed near 98 MB. V8 sized the old space up before that collection and does not give it back. Timing of when a mark-compact happens decides the peak; the live set did not grow.
4. Confirmation: the same run with `--max-old-space-size=80` has peak RSS 264.5 MB (below base), same fingerprint, cpuMsPerTick 9.05 (vs 8.94 and 9.01 uncapped, noise). So the 75 MB is reclaimable heap slack, not a leak, and not growing: it is capped by V8's heuristic and the server's `--max-old-space-size=768` / MemoryMax 1G.

## Verdict suggestion
No code change. The extra 75 MB is V8 heap slack from GC timing in a deterministic run (RSS of identical runs has varied 217-250 MB before). If the slack matters on the server, a lower `--max-old-space-size` in `server/evolve-live.service.template` would bound it, but the real server heap (viewers, saves) is larger than the bench's 11 MB, so it needs its own measurement; not done here.
