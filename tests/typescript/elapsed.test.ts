import { formatElapsed } from "../../src/typescript/src/ui/elapsed.ts";

describe("formatElapsed", () => {
  it("formats seconds, minutes, hours and days compactly", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(35)).toBe("35s");
    expect(formatElapsed(59.9)).toBe("59s");
    expect(formatElapsed(60)).toBe("1m 0s");
    expect(formatElapsed(155)).toBe("2m 35s");
    expect(formatElapsed(3600 + 35 * 60 + 48)).toBe("1h 35m 48s");
    expect(formatElapsed(86400 + 4 * 3600 + 3 * 60 + 59)).toBe("1d 4h 3m");
  });

  it("treats negative and non-finite input as zero", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(NaN)).toBe("0s");
  });
});
