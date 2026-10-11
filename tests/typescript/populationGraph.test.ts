import { formatDuration } from "../../src/typescript/src/ui/populationGraph.ts";

describe("formatDuration", () => {
  it("picks seconds, minutes, hours or days", () => {
    expect([0, 45, 119, 120, 605, 3599, 3600, 5400, 86399, 86400, 172800].map(formatDuration)).toEqual(["0 s", "45 s", "119 s", "2:00", "10:05", "59:59", "1 h", "1.5 h", "24 h", "1 d", "2 d"]);
  });
});
