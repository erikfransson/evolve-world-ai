// @vitest-environment node
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { STOP_BUDGET_MS, STOP_PACK_MS, Saves, stopVerifyMs } from "../../server/src/saves.ts";
import { PACK_TIMEOUT_MS, TooBig, VERIFY_TIMEOUT_MS, WorkerFailed } from "../../server/src/saveParse.ts";
import { StateStore } from "../../server/src/state.ts";
import { smallConfig } from "./liveHelpers.ts";

// packSave is replaced by a script of outcomes; "real" runs the real packer.
const mocks = vi.hoisted(() => ({ outcomes: [] as unknown[], calls: 0, inFlight: 0, maxInFlight: 0, packMs: [] as unknown[], verifyMs: [] as unknown[], delay: 0, gate: null as Promise<void> | null }));
vi.mock("../../server/src/saveParse.ts", async (original) => {
  const real = await original<typeof import("../../server/src/saveParse.ts")>();
  return {
    ...real,
    parseSave: (...args: unknown[]) => {
      mocks.verifyMs.push(args[4]);
      return (real.parseSave as (...a: unknown[]) => unknown)(...args);
    },
    packSave: async (...args: Parameters<typeof real.packSave>) => {
      mocks.calls++;
      mocks.packMs.push(args[2]);
      if (mocks.gate) await mocks.gate; // held by the test, so no pack timeout is running on the fake clock
      if (mocks.delay) await new Promise((r) => setTimeout(r, mocks.delay)); // on the fake clock, ended by the test
      mocks.inFlight++;
      mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
      try {
        const next = mocks.outcomes.shift();
        if (next === undefined || next === "real") return await real.packSave(...args);
        throw next;
      } finally {
        mocks.inFlight--;
      }
    },
  };
});

const MIN = 60_000;
const realTimeout = setTimeout; // the tests fake setTimeout
const [R1, R2, R3] = LIMITS.saveRetryMs;
const timeout = (): WorkerFailed => new WorkerFailed("packing the save took too long");

describe("periodic save retry", () => {
  let saves: Saves;
  let dir: string;
  let lines: string[];
  const run = (): Promise<void> => saves.periodic((l) => lines.push(`log ${l}`), (l) => lines.push(`err ${l}`));
  const files = (): number => readdirSync(dir).filter((n) => n.endsWith(".json.gz")).length;
  // The real packer and verify run on workers, in real time: wait for them with the fake clock stopped.
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 3000 && !done(); i++) await new Promise((r) => realTimeout(r, 20));
    expect(done()).toBe(true);
  };
  const retryLines = (): string[] => lines.filter((l) => l.includes("save retry"));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.outcomes = [];
    mocks.calls = 0;
    mocks.packMs = [];
    mocks.verifyMs = [];
    mocks.delay = 0;
    mocks.maxInFlight = 0;
    dir = mkdtempSync(join(tmpdir(), "evolve-retry-"));
    const live = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 5; i++) live.eco.step();
    saves = new Saves(live, new StateStore(dir));
    lines = [];
  });
  afterEach(async () => {
    saves.stopRetries();
    await until(() => mocks.inFlight === 0);
    vi.useRealTimers();
  });

  it("the waits are bounded, whole minutes and rising", () => {
    expect(LIMITS.saveRetryMs.length).toBeGreaterThan(0);
    expect(R1).toBeLessThan(LIMITS.stateEveryMs);
    expect(LIMITS.saveRetryMs.every((w, i, a) => w > 0 && w < LIMITS.stateEveryMs && (i === 0 || w >= a[i - 1]!))).toBe(true);
  });

  it("a pack that times out is retried after the first wait, then the next, the last repeating, and a success resets", async () => {
    mocks.outcomes = [timeout(), timeout(), timeout(), timeout(), "real", timeout(), "real"];
    await run();
    expect(mocks.calls).toBe(1);
    expect(files()).toBe(0);
    expect(retryLines()).toEqual([`err save retry 1 in ${R1! / MIN} min`]);
    await vi.advanceTimersByTimeAsync(R1! - 1);
    expect(mocks.calls).toBe(1); // not before the wait
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(R2!);
    expect(mocks.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(R3!);
    expect(mocks.calls).toBe(4);
    await vi.advanceTimersByTimeAsync(R3! - 1);
    expect(mocks.calls).toBe(4); // capped: the third wait repeats
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.calls).toBe(5);
    await until(() => files() === 1);
    await vi.advanceTimersByTimeAsync(10 * R3!);
    expect(mocks.calls).toBe(5); // saved: no more retries
    // The backoff starts over after the success.
    lines = [];
    await run();
    expect(retryLines()).toEqual([`err save retry 1 in ${R1! / MIN} min`]);
    await vi.advanceTimersByTimeAsync(R1!);
    await until(() => files() === 2);
    expect(mocks.calls).toBe(7);
  }, 120_000);

  it("a pack that cannot be saved for good is not retried: too big, a full state directory, a world that would not restore", async () => {
    mocks.outcomes = [new TooBig(60e6)];
    await run();
    expect(lines.join("\n")).toContain("not saved");
    const cap = LIMITS.maxStateDirBytes;
    LIMITS.maxStateDirBytes = -1;
    try {
      await run();
    } finally {
      LIMITS.maxStateDirBytes = cap;
    }
    expect(lines.join("\n")).toMatch(/not saved.*cap/);
    mocks.outcomes = [new Error("a bad world")];
    await run();
    await vi.advanceTimersByTimeAsync(10 * R3!);
    expect(retryLines()).toEqual([]);
    expect(mocks.calls).toBe(3); // one pack per try, none after
  });

  it("a verify worker that times out is retried, a verify that judges the save bad is not", async () => {
    const live = new LiveWorld(smallConfig(), null);
    const store = new StateStore(dir);
    saves = new Saves(live, store);
    const write = vi.spyOn(store, "writeGzipped");
    write.mockRejectedValueOnce(new WorkerFailed("parsing the save took too long")); // writeGzipped's own failures are not retried...
    await run();
    expect(retryLines()).toEqual([`err save retry 1 in ${R1! / MIN} min`]);
    write.mockRejectedValueOnce(new Error("it would not restore: bad")); // ...nor a plain Error
    await vi.advanceTimersByTimeAsync(R1!);
    expect(retryLines().length).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * R3!);
    expect(retryLines().length).toBe(1);
  });

  it("never more than one save in flight: a retry that falls due during a manual save waits its turn, and a periodic tick replaces the timer", async () => {
    mocks.outcomes = [timeout(), "real", "real"];
    await run();
    let open!: () => void;
    mocks.gate = new Promise<void>((r) => (open = r));
    const manual = saves.save();
    await vi.advanceTimersByTimeAsync(R1!); // the retry falls due while the manual save runs
    expect(mocks.calls).toBe(2); // only the manual save has reached the packer
    mocks.gate = null;
    open();
    await manual;
    await until(() => files() === 2);
    expect(mocks.maxInFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * R3!);
    expect(mocks.calls).toBe(3);
    mocks.outcomes = [timeout(), timeout()];
    await run();
    await run(); // the 4 h tick lands with a retry pending: that one timer is replaced, not doubled
    await vi.advanceTimersByTimeAsync(R2!);
    expect(mocks.calls).toBe(6);
    await until(() => files() === 3);
  });

  it("a manual save that succeeds cancels the pending retry, and the stop path schedules none", async () => {
    mocks.outcomes = [timeout()];
    await run();
    await saves.save();
    await vi.advanceTimersByTimeAsync(10 * R3!);
    expect(mocks.calls).toBe(2);
    mocks.outcomes = [timeout()];
    saves.stopRetries();
    lines = [];
    await run();
    await vi.advanceTimersByTimeAsync(10 * R3!);
    expect(mocks.calls).toBe(2);
    expect(retryLines()).toEqual([]);
  });

  it("the stop path packs for up to STOP_PACK_MS when no save was in flight, the periodic path keeps PACK_TIMEOUT_MS", async () => {
    expect(STOP_PACK_MS).toBeGreaterThan(PACK_TIMEOUT_MS);
    await run();
    expect(mocks.packMs).toEqual([PACK_TIMEOUT_MS]);
    expect(mocks.verifyMs).toEqual([VERIFY_TIMEOUT_MS]);
    await saves.save(true);
    expect(mocks.packMs).toEqual([PACK_TIMEOUT_MS, STOP_PACK_MS]);
    expect(mocks.verifyMs[1]).toBeGreaterThan(VERIFY_TIMEOUT_MS - 2000); // the budget used so far is tiny
    expect(mocks.verifyMs[1]).toBeLessThanOrEqual(VERIFY_TIMEOUT_MS);
  });

  it("a stop asked while another save is in flight: that save went through after the stop, so the stop save is skipped", async () => {
    mocks.delay = 1000;
    const other = saves.save();
    const stop = saves.save(true);
    await vi.advanceTimersByTimeAsync(1000);
    await other;
    mocks.delay = 0;
    await expect(stop).resolves.toMatch(/already saved/);
    expect(mocks.calls).toBe(1);
    expect(mocks.packMs).toEqual([PACK_TIMEOUT_MS]);
    expect(files()).toBe(1);
  });

  it("a stop asked while another save is in flight that then fails still saves, with the normal pack budget, when budget remains", async () => {
    mocks.outcomes = [timeout(), "real"];
    mocks.delay = 1000;
    const other = saves.save().catch((e: unknown) => e);
    const stop = saves.save(true);
    await vi.advanceTimersByTimeAsync(0); // the other pack is waiting on its timer now
    mocks.delay = 0; // the stop save must not wait on the fake clock
    await vi.advanceTimersByTimeAsync(1000);
    expect(await other).toBeInstanceOf(Error);
    await expect(stop).resolves.toMatch(/^saved /);
    expect(mocks.maxInFlight).toBe(1);
    expect(mocks.packMs).toEqual([PACK_TIMEOUT_MS, PACK_TIMEOUT_MS]);
    expect(files()).toBe(1);
  });

  it("a stop behind a failed save with the stop budget spent throws without starting a worker", async () => {
    mocks.outcomes = [timeout()];
    mocks.delay = 1000;
    const other = saves.save().catch((e: unknown) => e);
    const stop = saves.save(true);
    const stopFailed = stop.catch((e: unknown) => e);
    const now = performance.now.bind(performance);
    const spy = vi.spyOn(performance, "now").mockImplementation(() => now() + STOP_BUDGET_MS - PACK_TIMEOUT_MS); // less than pack + verify floor left
    await vi.advanceTimersByTimeAsync(1000);
    expect(await other).toBeInstanceOf(Error);
    const e = await stopFailed;
    spy.mockRestore();
    expect(String(e)).toMatch(/not saved.*stop budget is spent, the last good save is kept/);
    expect(mocks.calls).toBe(1);
    expect(mocks.packMs).toEqual([PACK_TIMEOUT_MS]);
    expect(files()).toBe(0);
  });

  it("a stop whose pack takes the whole STOP_PACK_MS still verifies and finishes inside the unit's 60 s", () => {
    for (const packed of [0, 5_000, 10_000, STOP_PACK_MS]) expect(packed + stopVerifyMs(packed)).toBeLessThanOrEqual(STOP_BUDGET_MS);
    expect(stopVerifyMs(0)).toBe(VERIFY_TIMEOUT_MS);
    expect(stopVerifyMs(STOP_PACK_MS) + STOP_PACK_MS + 5_000).toBeLessThan(60_000); // pack, verify, and a few seconds of write and exit
    expect(stopVerifyMs(STOP_BUDGET_MS * 2)).toBeGreaterThan(0); // never zero or negative: a late stop still gets its floor
    expect(stopVerifyMs(STOP_BUDGET_MS * 2)).toBeLessThanOrEqual(5_000);
  });

  it("a stop pack that times out writes nothing and ends, bounded by the pack timeout", async () => {
    mocks.outcomes = [timeout()];
    await expect(saves.save(true)).rejects.toThrow(/not saved.*took too long/);
    expect(files()).toBe(0);
    expect(mocks.packMs).toEqual([STOP_PACK_MS]);
  });
});
