# Arena footprint over a long run (idea 47, study)

Branch `pl-arena`, docs only. Question: does the brain bank's arena (one WebAssembly arena holds brain blocks, resident rows, sense tables, crowd and kernel structs) grow beyond its live bytes over hours, and is it bounded?

## How measured
Scratch hook (not committed, `--import`): wraps `Arena.alloc`, `WasmBrainBank.set` and `LiveWorld.step` and prints every 300 simulated s. `brain` is the sum of rounded block bytes of held slots, `other` is arena top minus start minus free minus brain (rows, tables, kernel structs), `free` is the bytes on the free lists, `top` is the bump pointer (the high-water mark, as the arena never lowers it). Run: `liveBench --seconds 7200 --copies 800` (4 mixed founders), wrapped in taskset 2,3,6,7 / nice 19 / idle. 216000 ticks, 169017 births, 168913 deaths, fingerprint 917779520, cpuMsPerTick 9.91 (hook adds nothing per tick), peak RSS 435 MB. A first 600 s run checked the hook.

## Table (MB)
| sec  | pop  | wasm mem | brain live | other live | free list | top   | slots | free blocks | RSS |
|------|------|----------|------------|------------|-----------|-------|-------|-------------|-----|
| 300 | 3180 | 45.0 | 26.0 | 16.6 | 0.8 | 43.3 | 3373 | 134 | 223 |
| 900 | 3059 | 50.6 | 26.5 | 16.8 | 2.0 | 45.4 | 3373 | 355 | 277 |
| 1500 | 1494 | 57.0 | 27.2 | 17.1 | 7.8 | 52.2 | 3373 | 931 | 310 |
| 2100 | 1524 | 57.0 | 23.9 | 17.1 | 12.1 | 53.1 | 3373 | 1096 | 380 |
| 2700 | 2376 | 57.0 | 18.6 | 17.1 | 19.0 | 54.8 | 3373 | 1423 | 390 |
| 3300 | 3151 | 64.1 | 15.2 | 17.1 | 26.0 | 58.4 | 3373 | 2213 | 394 |
| 3900 | 3271 | 64.1 | 14.6 | 17.2 | 27.8 | 59.6 | 3464 | 2393 | 397 |
| 4500 | 2408 | 64.1 | 14.7 | 17.2 | 28.1 | 59.9 | 3464 | 2473 | 403 |
| 5100 | 1566 | 64.1 | 14.9 | 17.2 | 28.0 | 60.1 | 3464 | 2505 | 412 |
| 5700 | 1478 | 64.1 | 14.9 | 17.2 | 28.2 | 60.3 | 3464 | 2543 | 420 |
| 6300 | 2260 | 64.1 | 14.9 | 17.2 | 28.5 | 60.7 | 3464 | 2626 | 430 |
| 6900 | 3208 | 64.1 | 15.0 | 17.2 | 29.2 | 61.4 | 3464 | 2783 | 430 |
| 7200 | 3304 | 64.1 | 15.0 | 17.2 | 29.3 | 61.4 | 3464 | 2795 | 431 |

(Every other 300 s row shown; the full run was in the scratchpad.)

## Findings
1. Kernel memory is flat after the first hour: 64.1 MB from 3000 s to 7200 s (steps 45.0, 50.6, 57.0, 64.1 while the population and brain mix settled). `other live` is constant at 17.2 MB, so rows, sense tables, crowd and item tables do not leak. Slots rise only 3373 to 3464 (up to the peak population).
2. Free-list bytes grow with churn: 0.8 MB at 300 s, 27 MB at 3600 s, 29.3 MB at 7200 s. Most of the rise is in the first hour, while the founders' large brains die and mutated offspring have other rounded sizes, so blocks stay filed under sizes no new brain asks for. After 3600 s the free list rises 2.1 MB in 3600 s (0.6 MB/h) and the top 2.1 MB; both follow the population swing (1343 to 3304) more than time.
3. Fragmentation is therefore not zero (free 29 MB against 15 MB live brain, so the arena holds about twice the live brain bytes), but I see no unbounded growth in 2 h. Free-block count creeps 2346 to 2795 in the second hour.
4. Memory sits outside the V8 heap (`--max-old-space-size=768` does not cover it); only MemoryMax 1G counts. Worst case at 0.6 MB/h reaching +900 MB would take about 62 days, and the creep decelerates and is capped in practice by the number of distinct rounded sizes times peak counts. Unverified beyond 2 h and for the real server's mix of uploads.
5. The cap case (`--only juggernaut --copies 4900`, 3600 s) was not run.

## Verdict suggestion
Plateaus, no code change. Compaction (move blocks, rewrite `blockPtr` and `order`, rows are pinned by Creature so they would stay) is not warranted: the recoverable amount is about 29 MB. If it is ever wanted, the cheap exact fix is at `WasmBrainBank.set`: when a size class's free list is empty, reuse a free block of a larger class instead of bumping (splitting needs a coalescing free list; skip), which keeps forward results bit-identical because the forward reads only block contents. Re-measure with a long real-server mix (uploaded brains of many sizes) before acting.
