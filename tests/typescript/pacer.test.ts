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
    t = 160;
    pacer.finished(100, 0.75); // 60 ms of work, 20 ms of idle
    expect(pacer.wait()).toBeCloseTo(20);
    t = 170;
    expect(pacer.wait()).toBeCloseTo(10);
    t = 190;
    expect(pacer.wait()).toBe(0);
    pacer.began();
    pacer.finished(190, 1);
    expect(pacer.wait()).toBe(0);
  });

  it("owes small idle times until they are worth a sleep, then sleeps the whole debt", () => {
    let t = 0;
    const pacer = new Pacer(() => t);
    const job = (work: number) => { const start = t; t += work; pacer.finished(start, 0.9); };
    for (let i = 0; i < 11; i++) { job(12); expect(pacer.wait()).toBe(0); } // 12 ms of work owes 1.33 ms: 11 slices stay under 15 ms
    job(12); // 12th: 16 ms owed
    expect(pacer.wait()).toBeCloseTo(16, 1);
  });

  it("books the time really slept, so an overshoot is paid back", () => {
    let t = 0;
    const pacer = new Pacer(() => t);
    const job = (work: number) => { const start = t; t += work; pacer.finished(start, 0.5); };
    job(20); // owes 20 ms
    expect(pacer.wait()).toBe(20);
    t += 24; // the timer overshot by 4 ms
    pacer.began();
    job(20); // owes 20 - 4 = 16 ms
    expect(pacer.wait()).toBeCloseTo(16);
    t += 16;
    pacer.began();
    let total = 0;
    for (let i = 0; i < 50; i++) { const before = t; job(20); const w = pacer.wait(); t += w; pacer.began(); total += t - before; }
    expect(50 * 20 / total).toBeCloseTo(0.5, 1); // the work share stays at the duty
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
