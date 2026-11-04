import { RevealGate } from "../../src/typescript/src/live/revealGate.ts";

describe("the live page's reveal gate", () => {
  it("holds one task per key however many messages arrive before the reveal (a tab opened in the background)", () => {
    const gate = new RevealGate();
    const ran: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      gate.later("stats", () => ran.push(`stats ${i}`));
      if (i % 10 === 0) gate.later("history", () => ran.push(`history ${i}`));
    }
    gate.later("map", () => ran.push("map"));
    expect(gate.waiting).toBe(3);
    expect(ran).toEqual([]);
    gate.reveal();
    expect(ran).toEqual(["stats 99999", "history 99990", "map"]); // the latest of each, once, in the order the keys were first asked
    expect(gate.open).toBe(true);
    gate.later("stats", () => ran.push("now"));
    expect(ran.at(-1)).toBe("now");
    expect(gate.waiting).toBe(0);
  });
});
