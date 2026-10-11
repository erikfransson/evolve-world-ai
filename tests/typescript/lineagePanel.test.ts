import { LINEAGE_STRIDE, LINEAGE_TOP } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { lineageRows, stackHistory } from "../../src/typescript/src/ui/lineagePanel.ts";

const sample = (time: number, others: number, entries: [number, number, number][]): number[] => {
  const row = [time, others];
  for (let k = 0; k < LINEAGE_TOP; k++) row.push(...(entries[k] ?? [-1, 0, 0]));
  return row;
};

describe("lineageRows", () => {
  it("gives each lineage its share and one row for the rest", () => {
    const rows = lineageRows([{ founder: 4, hue: 10, pool: true, count: 30, species: 0 }, { founder: 9, hue: 200, pool: false, count: 10, species: 0 }], 80);
    expect(rows.map((r) => [r.label, r.origin, r.count])).toEqual([["#4", "pool", 30], ["#9", "random", 10], ["others", "", 40]]);
    expect(rows.map((r) => r.share)).toEqual([0.375, 0.125, 0.5]);
    expect(rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 12);
  });

  it("has no others row when the lineages cover everyone, and survives an empty world", () => {
    expect(lineageRows([{ founder: 1, hue: 0, pool: false, count: 5, species: 0 }], 5).map((r) => r.founder)).toEqual([1]);
    expect(lineageRows([], 0)).toEqual([]);
  });
});

describe("stackHistory", () => {
  it("stacks founders in id order with the rest on top, shares summing to 1", () => {
    const h = Float64Array.from([
      ...sample(0, 0, [[7, 3, 100], [2, 1, 50]]),
      ...sample(10, 4, [[2, 4, 50], [7, 2, 100]]),
    ]);
    expect(h.length).toBe(2 * LINEAGE_STRIDE);
    const s = stackHistory(h);
    expect(s.times).toEqual([0, 10]);
    expect(s.bands.map((b) => b.founder)).toEqual([2, 7, -1]);
    expect(s.bands[0]!.upper).toEqual([0.25, 0.4]);
    expect(s.bands[1]!.lower).toEqual([0.25, 0.4]);
    expect(s.bands[1]!.upper).toEqual([1, 0.6]);
    expect(s.bands[2]!.upper).toEqual([1, 1]);
    for (let i = 0; i < 2; i++) for (let j = 1; j < s.bands.length; j++) expect(s.bands[j]!.lower[i]).toBeCloseTo(s.bands[j - 1]!.upper[i]!, 12);
  });

  it("is empty without samples", () => {
    expect(stackHistory(new Float64Array(0)).times).toEqual([]);
  });
});
