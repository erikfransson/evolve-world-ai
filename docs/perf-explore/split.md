# Sense kernel: split `$sense` into per-phase functions (idea 62)

Stopped at the pre-check, nothing built: V8's code for `$sense` has few hot-path spills, so the split cannot reach the 1.5% bar. No production change. Branch `pl-split` from `perf-live` 8e3d177 (this file only).

## Pre-check

Question: does V8 (TurboFan) spill the 25 loop invariants of `$sense` inside the item, rock and crowd walks and the per-ray loops?
Method: the production `sense.wat` assembled with the repo's wabt, instantiated over the tick-400 snapshot of `senselive.md` (3331 creatures), `node --no-liftoff --print-wasm-code` (node 24.18, function index 5, TurboFan, 3130 instructions, frame 0x290 = 656 bytes). Stack-slot accesses are `[rbp-x]` operands (the `cmpq rsp,[r13-0x60]` interrupt check is not one). Static counts are per instruction in the dump; dynamic estimates weight them with the per-creature counts of `senselive.md` (4.5 item rows, 7.7 items scanned, 4.4 rock rows, 4.6 crowd rows, 1.5 crowd entries, 9 rays).

Whole function: 536 stack loads and 251 stores. 172 loads and 79 stores are in the hot code (offsets 0x0 to 0x2c00 of 0x3fa0); the rest sits in out-of-line blocks after it (stack-check slow paths and the call to `memory.fill`), cold.

| Part (offset in dump)                | Stack loads / stores per execution            | Executions per creature | Stack ops per creature |
|--------------------------------------|-----------------------------------------------|------------------------:|-----------------------:|
| Creature head, record load (0x200)   | 14 / 11                                       | 1                       | 25                     |
| Item row loop head (0x580)           | 5 / 1                                         | 4.5                     | 27                     |
| Item inner loop (0x600, 3x unrolled) | 4 loads per 3 items (`r2` and `wedge`), 0 stores | 7.7 items            | 10                     |
| Rock row head (0xb00)                | 2 / 0                                         | 4.4                     | 9                      |
| Rock inner loop (0xb80)              | 0 / 0                                         | 3.3 discs               | 0                      |
| Crowd gather row head (0x2100)       | 5 / 1                                         | 4.6                     | 28                     |
| Crowd gather inner (0x2180)          | 6 loads at the tail of the iteration          | 1.5 entries             | 9                      |
| Crowd early-out walk head (0xf40)    | 8 / 2                                         | 4.6 (when it runs)      | up to 46               |
| Per-ray pair loops (dirs, init, close, features: 0x12c0 to 0x2b40) | 0 to 2 loads, 0 stores | 4.5 pairs | under 10          |
| Straight-line code between the loops (0x300 to 0x580, 0x800 to 0xb00) | about 50 / 25 | 1 | about 50 |

Total about 170 stack ops per creature (about 120 loads, 50 stores), against about 4800 cycles per creature (1620 ns, `senselive.md`) and roughly 12000 instructions. Every hot inner loop (item, rock, crowd, directions, closeness, features) has 0 stores and 0 to 2 loads in 30 to 130 instructions. The spills V8 chose are the cold ones (loop-invariant addresses reloaded at row-loop heads, the 9 record fields saved at the creature head).

## Why a split cannot pay

- A split function reloads its invariants from the call block: the same L1 loads the row heads do now. Loads would not drop, only the stores (about 50 per creature, off the critical path) could.
- Upper bound if all 170 stack ops cost a full cycle each and nothing overlapped: 170 / 4800 = 3.5% of the kernel, 1.3% of the tick (senser phase 5.7 of 15.2 ms, kernel most of it). Realistically they overlap with the cache-miss and branch stalls that `senselive.md` found dominant, so the gain would be well under half of that. A call and the invariant reloads per phase (6 phases, 3300 creatures) eat part of it.
- Lines up with `gather4.md`: adding unused v128 locals to the base kernel cost +1.5% / +2.1% there, but that is a live-set effect inside the hot loops, which are already spill free here.
- The 8 to 12% that the C++ port of `nsense.md` gained (v0, same 128-bit lanes) is therefore not register spilling in the walks; it is more likely scalar details (bounds checks and memory base addressing in every access, f64 compare sequences, loop peeling) that a hand port keeps cheaper.

## Verdict suggestion

Reject, no build. Few spills in the hot path (0 stores and 0 to 2 loads in every inner loop, about 170 stack ops per creature in total), and a split would trade spill reloads for invariant reloads one for one. The bound is under 1.3% of the tick before any call overhead, below the 1.5% bar. No fingerprint, harness or test runs were needed (kernel unchanged).

Reproduce (machine wrapper, scratch only): snapshot with `senselive.md`'s `snap.ts` at tick 400, load `sense.wat` through wabt over the snapshot memory, run it four times under `node --no-liftoff --print-wasm-code`, take the last `wasm-function[5]` block, and count `[rbp-x]` operands by loop (backward-jump ranges).
