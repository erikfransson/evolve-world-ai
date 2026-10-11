import { DutyController, MIN_DUTY, Pacer, gentleCount, idleMs, runProbe } from "../../src/typescript/src/worker/pacer.ts";
import { defaultHelpers } from "../../src/typescript/src/worker/ecoPool.ts";
import { defaultThreads } from "../../src/typescript/src/worker/evalPool.ts";

describe("pacer", () => {
  it("idles w * (1 - d) / d, so work is the share d of the total", () => {
    expect(idleMs(12, 0.75)).toBeCloseTo(4);
    expect(idleMs(30, 0.5)).toBeCloseTo(30);
    expect(idleMs(12, 1)).toBe(0);
    expect(idleMs(0, 0.75)).toBe(0);
    expect(idleMs(-3, 0.75)).toBe(0);
    expect(Number.isFinite(idleMs(10, 0))).toBe(true);
  });

  it("makes the next job wait out the idle time", () => {
    let t = 100;
    const pacer = new Pacer(() => t);
    expect(pacer.wait()).toBe(0);
    t = 112;
    pacer.finished(100, 0.75); // 12 ms of work, 4 ms of idle
    expect(pacer.wait()).toBeCloseTo(4);
    t = 114;
    expect(pacer.wait()).toBeCloseTo(2);
    t = 120;
    expect(pacer.wait()).toBe(0);
    pacer.finished(112, 1);
    expect(pacer.wait()).toBe(0);
  });

  it("keeps threads plus the coordinator within cores - 1 when gentle", () => {
    expect(defaultHelpers(8, true)).toBe(4);
    expect(defaultHelpers(8)).toBe(4);
    expect(defaultHelpers(4, true)).toBe(2);
    expect(defaultHelpers(4)).toBe(3);
    expect(defaultHelpers(2, true)).toBe(1);
    expect(defaultThreads(16, true)).toBe(8);
    expect(defaultThreads(8, true)).toBe(6);
    expect(defaultThreads(8)).toBe(7);
    expect(defaultThreads(2, true)).toBe(1);
    expect(gentleCount(1, 1)).toBe(1);
  });
});

describe("DutyController", () => {
  const feed = (c: DutyController, ms: number, n: number) => { for (let i = 0; i < n; i++) c.probe(ms); };

  it("runs flat out when nominal or fair and steps down for serious and critical", () => {
    const c = new DutyController();
    expect(c.duty()).toBe(1);
    c.setPressure("fair");
    expect(c.duty()).toBe(1);
    c.setPressure("serious");
    expect(c.duty()).toBe(0.6);
    c.setPressure("critical");
    expect(c.duty()).toBe(MIN_DUTY);
    c.setPressure("nominal");
    expect(c.duty()).toBe(1);
  });

  it("stays at 1 while probes keep their usual time, also with small noise", () => {
    const c = new DutyController();
    for (let i = 0; i < 100; i++) c.probe(1 + (i % 3) * 0.05);
    expect(c.duty()).toBe(1);
  });

  it("backs off in steps when probes get slower, never below the minimum, and ramps back", () => {
    const c = new DutyController();
    feed(c, 1, 5);
    feed(c, 4, 1); // smoothed 1.9 times the best
    expect(c.duty()).toBeCloseTo(0.9);
    feed(c, 4, 30);
    expect(c.duty()).toBe(MIN_DUTY);
    feed(c, 1, 60);
    expect(c.duty()).toBe(1);
  });

  it("holds the duty between the back-off and recovery thresholds", () => {
    const c = new DutyController();
    feed(c, 1, 5);
    feed(c, 4, 30);
    expect(c.duty()).toBe(MIN_DUTY);
    feed(c, 1.35, 60); // ratio about 1.3, in the hysteresis band
    expect(c.duty()).toBe(MIN_DUTY);
  });

  it("takes the lower of pressure and contention and ignores empty probes", () => {
    const c = new DutyController();
    c.probe(0);
    expect(c.duty()).toBe(1);
    c.setPressure("serious");
    feed(c, 1, 5);
    feed(c, 3, 20);
    expect(c.duty()).toBe(MIN_DUTY);
  });

  it("times a fixed probe that runs", () => {
    expect(runProbe()).toBeGreaterThan(0);
  });
});
