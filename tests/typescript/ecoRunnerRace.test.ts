import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { snapshotBytes } from "../../src/typescript/src/worker/ecoProtocol.ts";
import type { EcoInMessage, EcoOutMessage, EcoSnapshot } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { EcoRunner } from "../../src/typescript/src/worker/ecoRunner.ts";
import { testRng } from "./helpers.ts";

// Random page-to-worker message sequences, with stale run numbers and buffers the worker never posted.
// The page is simulated honestly about transfer: a posted buffer is detached on the worker side and only the page's copy can come back.
function cfg(pop: number): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return { ...d, world: { ...d.world, width: 500, height: 500 }, eco: { ...d.eco, initialPopulation: pop, foundersVary: false, planDrift: 0, structuralRate: 0 } };
}

const SPEEDS = [0.5, 1, 8, 64, "max"] as const;
const BOARDS = ["age", "children", "eaten", "kills"] as const;
const MAX_IN_FLIGHT = 3;

describe.each([1, 2, 3, 4, 5, 6])("EcoRunner under random messages (seed %i)", (seed) => {
  it("stays consistent: no throw, in-flight count right, pool without duplicates, snapshots only for the current run", () => {
    const rng = testRng(seed * 7919);
    const pick = <T>(a: readonly T[]): T => a[rng.int(a.length)]!;
    let clock = 0;
    let current: number | null = null; // run of the last start, kept after a reset
    let alive = false; // a run exists: started and not reset
    let model = 0; // snapshots of the current run the page has not acknowledged
    const held: { buffer: ArrayBuffer; run: number }[] = []; // what the page holds
    const posted: EcoSnapshot[] = [];
    let lastTick = -1;
    const runner = new EcoRunner((msg: EcoOutMessage, transfer) => {
      if (msg.type !== "snapshot") return;
      expect(msg.run, "snapshot of a run that is not current").toBe(current);
      expect(msg.buffer.byteLength, "posted buffer too small or detached").toBeGreaterThanOrEqual(snapshotBytes(msg.creatureCap, msg.itemCap));
      expect(held.some((h) => h.buffer === msg.buffer), "buffer posted while the page holds it").toBe(false);
      expect(msg.count).toBe(msg.population);
      expect(msg.tick).toBeGreaterThanOrEqual(lastTick);
      lastTick = msg.tick;
      const moved = msg.buffer.transfer(); // the page's copy
      expect(transfer).toContain(msg.buffer);
      held.push({ buffer: moved, run: msg.run });
      posted.push(msg);
      model++;
    }, () => (clock += 2));
    const internals = runner as unknown as { inFlight: number; pool: ArrayBuffer[] };

    const give = (msg: EcoInMessage): void => {
      if (msg.type === "start") { current = msg.run; alive = true; model = 0; lastTick = -1; } // begin() resets the count, then posts once (counted by post)
      runner.handle(msg);
    };
    const check = (what: string): void => {
      expect(internals.inFlight, `inFlight after ${what}`).toBeGreaterThanOrEqual(0);
      expect(internals.inFlight, `inFlight after ${what}`).toBe(model);
      const pool = internals.pool;
      expect(pool.length, `pool after ${what}`).toBeLessThanOrEqual(MAX_IN_FLIGHT);
      expect(new Set(pool).size, `duplicate buffer in the pool after ${what}`).toBe(pool.length);
      for (const b of pool) expect(held.some((h) => h.buffer === b), `pool holds a buffer the page also holds, after ${what}`).toBe(false);
    };

    for (let i = 0; i < 300; i++) {
      const kind = rng.int(14);
      const stale = rng.int(3) === 0;
      const run = current === null ? 1 : stale ? current + pick([-2, -1, 1, 5]) : current;
      const before = posted.length;
      let what: string = String(kind);
      switch (kind) {
        case 0:
          what = "start";
          give({ type: "start", config: cfg(2 + rng.int(25)), run: current === null || rng.int(2) ? (current ?? 0) + 1 + rng.int(3) : current });
          break;
        case 1: give({ type: "pause" }); what = "pause"; break;
        case 2: give({ type: "resume" }); what = "resume"; break;
        case 3: give({ type: "speed", speed: pick(SPEEDS) }); what = "speed"; break;
        case 4: give({ type: "select", id: rng.int(3) === 0 ? null : rng.int(40) }); what = "select"; break;
        case 5: give({ type: "selectBest", by: pick(BOARDS), request: i }); what = "selectBest"; break;
        case 6:
          what = "reset";
          give({ type: "reset" });
          alive = false;
          break;
        case 7: case 8: case 9: { // acknowledge a held buffer: with its run, stale, or without a run
          what = "recycle";
          const h = held.length ? held.splice(rng.int(held.length), 1)[0]! : null;
          const withRun = rng.int(3);
          const ackRun = h ? (withRun === 0 ? undefined : stale ? h.run - 1 : h.run) : run;
          if (h) give({ type: "recycle", buffer: h.buffer, ...(ackRun === undefined ? {} : { run: ackRun }) });
          else give({ type: "recycle", run });
          if (ackRun === undefined || ackRun === current) model = Math.max(0, model - 1);
          break;
        }
        case 10: { // a buffer the worker never posted, of any size
          what = "recycle unknown";
          const buffer = new ArrayBuffer(pick([0, 1, 100, 1 << 20]));
          const ack = pick([undefined, run] as const);
          give({ type: "recycle", buffer, ...(ack === undefined ? {} : { run: ack }) });
          if (ack === undefined || ack === current) model = Math.max(0, model - 1);
          break;
        }
        case 11: { // a render worker hands back a held buffer, or an unknown one
          what = "refill";
          const h = held.length ? held.splice(rng.int(held.length), 1)[0]! : null;
          give({ type: "refill", buffer: h ? h.buffer : new ArrayBuffer(pick([0, 64, 1 << 20])) });
          break;
        }
        default: // step the clock and the simulation
          what = "pump";
          clock += rng.int(60);
          runner.pump();
      }
      if (kind === 4 || kind === 5) expect(posted.length - before).toBe(alive ? 1 : 0); // a selection posts one snapshot when a run exists
      if (!alive) expect(runner.pump()).toBe(-1);
      check(what);
    }
    expect(posted.length).toBeGreaterThan(10); // the sequence did run the simulation
  });
});
