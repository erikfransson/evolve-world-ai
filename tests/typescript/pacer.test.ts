import { DutyController, FALLBACK_DUTY, MIN_DUTY, Pacer, gentleCount, gentleController, idleMs } from "../../src/typescript/src/worker/pacer.ts";
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

  it("starts from a fixed duty where there is no pressure API", () => {
    expect(new DutyController(FALLBACK_DUTY).duty()).toBe(0.9);
    expect(gentleController().duty()).toBe(FALLBACK_DUTY); // Node has no PressureObserver
  });
});
