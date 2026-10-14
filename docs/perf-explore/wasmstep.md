| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| remember + steer + stepBody in WASM (`step.wat`, fdlibm sin/cos, rock keepOut), state copied in and out each tick | 72.6 / 71.4 / 70.3 ms per tick (Inland, 10000) | 72.4 / 71.8 / 72.7 | 0.99x (median 71.4 vs 72.4) | bit-identical (Inland 830514026, pop 600 739359978, predators 410981010) | about 0 (336 to 350 MB, noise) | 360 WAT + 158 TS + 53 elsewhere | Copy version: no gain |
| Same with creature state resident in WASM (not built), estimate | 72.8 | about 57 to 64 | 1.13x (steer only) to 1.28x (steer plus sense gather) | yes if the above holds | about 0 | est. 600 to 900 more | Feasible and exact, but a large refactor; see verdict |

Branch `wasmstep`. Inland Sea, 10000 creatures, serial, wasm on, 15 s, CPU ms per tick without `--profile`, 3 alternating base/step pairs, load average 18 to 29, so noise is about +-3%. Prototype switch: `STEPK=1`.

## Which Math functions does stepBody use?
- Only `Math.sin(heading)` and `Math.cos(heading)`, once per creature per tick. `sqrt` in `keepOut` is exact in WASM, and `abs`, `max`, `floor` are exact. No `atan2`, no `exp` in the phase (`Math.exp` is in `decaysFor`, once per config, and in `energySignal`, which belongs to the sense inputs).
- Sin and cos are the fdlibm port from `trig.wat` (branch of trig.md), 0 mismatches in 8.9e7 inputs against Node 24. It holds for |x| up to 823549 rad. The kernel counts larger headings and the prototype throws, a real version needs a JS fallback for that creature.
- Chrome's Math.sin/cos are glibc, not fdlibm, so the port equals JS only in Node (trig.md). The Live server is Node, so the bar "same as JS" holds there. In a browser the WASM path would be self-consistent, equal to the Node server, and differ from the browser's own JS path (which already differs from the WASM sense path today by f32 rounding).
- Per-species physics (maxThrust, thrustCost, turnCost) live in each creature's own config. The first version used one global config and failed the predators fingerprint (406901372); each record now points to its species' parameter block, and it matches (410981010).

## Prototype (what was built)
- `sim/wasm/step.wat`: one call over a batch of 128-byte records (x, y, vx, vy, heading, turnRate, energy, upkeep with aging, ground factor, cos and sin out), reads the brain outputs in place from the bank memory, does remember, thrust command, turn, sin/cos, drag, ground, `keepInside`, rock `keepOut` (4 passes, rock grid tables), energy. Same operation order as the JS, no fused ops.
- `sim/wasm/stepKernel.ts`: `WasmStepper`, gather before, scatter after. `Creature.packStep/unpackStep`, a hook in `Ecosystem.finishTick`.
- Not ported: the ground field lookup (`GroundField.valueAt`, about 25 lines, the JS still computes it in the gather and hands in the speed factor), aging (JS passes the upkeep).

## Where the time goes (ms per tick, profile, 9760 creatures)
| Phase | JS (base) | Prototype |
|-------|-----------|-----------|
| memory and steer | 12.9 | gather 4.6 + kernel 4.8 + scatter 2.8 = 12.2 |
| senser: creature gather (`senser.run` loop, `writeBodyInputs`, `placeByRow`) | 11.0 | 9.8 (unchanged) |
| senser: WASM kernel | 20.1 | 20.3 |
| eat | 4.6 | 5.3 (noise or cache effect of the scatter, not understood) |

- The kernel is 0.48 us per creature, versus 1.3 us for the whole JS phase. Copy in and out is 7.4 ms, which is what soa.md and serial.md already said: the phase is object field traffic, not arithmetic.
- New finding: the senser's per-creature JS gather is 11 ms, as large as the steer phase. It reads the same state (x, y, cos, sin, vx, vy, turnRate, energy, ground, units) and writes it into the sense records and the brain input vector.

## What the JS side would still need each tick
- Resident layout: x, y, vx, vy, heading, cos, sin, turnRate, energy, ticksAlive, units, species index, ground in one WASM-side SoA, rows kept per creature (free-list on death).
- JS readers and writers of that state: crowd rebuild (x, y, energy, species), eat (`touched` reads x, y; `consume` writes energy), collisions (`collide` writes x, y, vx, vy; `hurt` energy), `hunt` (energy, alive), settle (energy, alive, ticksAlive), births (writes a new row, parent's energy), `keepOut` in `confine`, UI snapshots and the detail panel (x, y, heading, energy), save and restore (`ecoState`), the Trials and RL code that use plain `CreatureState` objects, and the helper-thread mode (ecoShare). All of them can read typed-array columns, but soa.md measured that this is neutral, not faster, so it buys nothing alone.
- The state must be bit-exact for what it feeds: `Math.exp` in `energySignal` (two calls per creature per tick, f32 result) would also need an fdlibm exp port to move the body-input writing into WASM.

## Estimate if resident (not built)
- Steer: 12.9 now, kernel 4.8 (could drop to about 3 with the ground lookup and units in the same pass, but not measured): saves about 8 ms, 11% of a tick, 1.13x.
- Sense gather: 11 ms now. If the senser reads the resident rows and writes the body inputs inside `sense.wat`, JS keeps only slot, self, rays and offsets pointers: est. 2 to 3 ms left, saves about 8 ms more. Needs the fdlibm exp.
- Together 16 ms of 72.8, 1.28x at best, about 1.2x after losing some to column-access cost in eat, collisions and births (the eat phase got slower by 0.7 ms in the prototype). RSS: neutral, the SoA replaces the object fields and the sense records.

## Verdict
- Feasible and exact: yes (done for steer, three fingerprints equal). The only exactness risk is the engine-dependent sin/cos, fine in Node, a start-up probe is needed elsewhere.
- Prototype as built (copy in and out): 0.99x, not worth merging.
- Real gain needs the state resident: about 1.13x for steer alone and up to about 1.2x to 1.28x with the senser gather moved too. Cost: about 1000 lines of WAT and TS plus a `CreatureState` view class for the JS readers (two code paths for Trials, RL, helper threads), exp and sin/cos ports, a start-up engine probe. Complexity is high for 15 to 25%; recommended only if the speed campaign has nothing cheaper left. A cheaper first step is to shrink the 11 ms senser gather (see the new ideas in the report) with no residency.

## New ideas (not tried)
1. Shrink the senser creature gather in JS: it is 11 ms. Write the per-creature record fields straight from the steer loop (steer already has x, y, cos, sin, vx, vy hot), or compute `writeBodyInputs` once in finishTick when the object is hot and keep the f32 values for the next tick's input.
2. Put `GroundField.valueAt` and the exp for `energySignal` in `sense.wat` so the senser needs no ground() call and no per-crowd-entry `Math.exp` (9760 per tick).
3. Verify the eat slowdown seen with the scatter (4.6 to 5.3 ms): visiting creatures in slot order versus random start in eat may be a cache effect worth a look on its own.
