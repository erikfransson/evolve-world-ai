import { TickClock } from "../../src/typescript/src/ui/tickClock.ts";

describe("TickClock", () => {
  it("carries fractional ticks, caps long gaps and ignores time going back", () => {
    const clock = new TickClock(0);
    expect(clock.advance(25, 60)).toBe(1); // 1.5 ticks due
    expect(clock.advance(50, 60)).toBe(2); // 1.5 more plus the carried half
    expect(clock.advance(10_050, 60)).toBe(15); // capped at a quarter second
    expect(clock.advance(10_000, 60)).toBe(0);
    clock.advance(10_010, 60);
    clock.reset(20_000);
    expect(clock.advance(20_010, 60)).toBe(0); // the carried 0.6 tick was dropped
  });
});
