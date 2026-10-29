# Idea 150: --max-semi-space-size for the main server process

Flag study only, no code change. `node --max-old-space-size=768 [--max-semi-space-size=N] src/liveBench.ts --seconds 50 --save 15 --copies 800` (mixed) and `--only juggernaut --copies 4900` (cap), in `server/`, pinned `taskset -c 2,3,6,7`, nice 19, load about 6, Node 24.18. 3 runs per cell, interleaved (default, 4, 8, 16 per round). `exit RSS` is VmRSS at process exit, after both saves (the bench has no steady sample, the 2 s timer starves while ticks run).
Fingerprints equal for every N and run: 303028926 (mixed), 10949528 (cap), as verifymem.md.

| Case  | N       | peakRssMB (median)      | exit RSS (median)   | cpuMsPerTick (median)      | scavenges / ms in them | mark-compacts |
|-------|---------|-------------------------|---------------------|----------------------------|------------------------|---------------|
| mixed | default | 384 401 387 (387)       | 305 317 315 (315)   | 22.53 23.15 21.76 (22.53)  | 511 / 494              | 39            |
| mixed | 4       | 361 365 363 (363)       | 280 288 280 (280)   | 21.72 21.26 22.46 (21.72)  | 558 / 496              | 42            |
| mixed | 8       | 376 383 375 (376)       | 292 303 298 (298)   | 21.12 20.87 21.82 (21.12)  | 348 / 413              | 39            |
| mixed | 16      | 413 412 423 (413)       | 339 331 341 (339)   | 23.99 21.11 22.85 (22.85)  | 258 / 357              | 34            |
| cap   | default | 431 424 457 (431)       | 365 346 334 (346)   | 22.83 23.26 23.18 (23.18)  | 524 / 572              | 37            |
| cap   | 4       | 366 367 367 (367)       | 298 300 290 (298)   | 22.81 22.54 23.43 (22.81)  | 559 / 555              | 45            |
| cap   | 8       | 389 380 386 (386)       | 305 301 309 (305)   | 22.89 22.00 23.81 (22.89)  | 347 / 465              | 41            |
| cap   | 16      | 433 427 435 (433)       | 366 350 369 (366)   | 25.95 22.35 23.73 (23.73)  | 249 / 343              | 33            |

GC counts are from one extra `--trace-gc` run per cell (scavenge ms summed from the trace). Default behaves like 16 or slightly below.

## Verdict
Adopt `--max-semi-space-size=4` in the unit file next to the heap cap: peak -24 MB (mixed) and -64 MB (cap) against default, exit RSS -35 and -48 MB, cpuMsPerTick equal or lower (-3.6% mixed, -1.6% cap, inside run spread of about 2 to 4%), scavenge time per run the same (about 500 to 555 ms of 50 s). N=8 gives -11 and -45 MB peak, also no tick cost. 16 is no better than default. Caveat: measured on 3300 and 4900 creature benches with 3 runs; the live server with real visitors and frame encoding allocates differently, so watch the first soak after the change. Change would be one token in `ExecStart` of `server/evolve-live.service.template` (and wherever the server is launched by hand); needs Erik's decision.
