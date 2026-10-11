import { ENV_GROUPS, ENVS, groupOf } from "../../src/typescript/src/sim/rl/envs.ts";
import { BLANK_ENV } from "../../src/typescript/src/sim/rl/env.ts";
import { envFacts, galleryGroups, pickedIn, setEnvs, summaryLine, toggleEnv } from "../../src/typescript/src/ui/envSelect.ts";

describe("galleryGroups", () => {
  it("keeps ENV_GROUPS order, skips empty groups and covers every env once", () => {
    const groups = galleryGroups(ENVS);
    const order = groups.map((g) => ENV_GROUPS.indexOf(g.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(groups.every((g) => g.envs.length > 0 && g.envs.every((e) => groupOf(e) === g.group))).toBe(true);
    expect(groups.flatMap((g) => g.envs.map((e) => e.id)).sort()).toEqual(ENVS.map((e) => e.id).sort());
    expect(groups.some((g) => g.group === "Custom")).toBe(false);
  });

  it("shows Custom last once a custom env exists", () => {
    const custom = { ...BLANK_ENV, id: "custom-1", name: "Mine", tags: ["custom"] };
    const groups = galleryGroups([...ENVS, custom]);
    expect(groups[groups.length - 1]).toEqual({ group: "Custom", envs: [custom] });
    expect(galleryGroups([])).toEqual([]);
  });
});

describe("picking", () => {
  it("toggles one env without mutating the old set", () => {
    const a = new Set(["x"]);
    const b = toggleEnv(a, "y");
    expect([...a]).toEqual(["x"]);
    expect([...b].sort()).toEqual(["x", "y"]);
    expect([...toggleEnv(b, "x")]).toEqual(["y"]);
  });

  it("selects or clears a group and leaves the rest alone", () => {
    const base = new Set(["a", "z"]);
    expect([...setEnvs(base, ["b", "c"], true)].sort()).toEqual(["a", "b", "c", "z"]);
    expect([...setEnvs(base, ["a", "q"], false)]).toEqual(["z"]);
    expect([...base].sort()).toEqual(["a", "z"]);
  });

  it("counts picked envs within a list", () => {
    const picked = new Set([ENVS[0]!.id, "gone"]);
    expect(pickedIn(picked, ENVS)).toBe(1);
    expect(pickedIn(setEnvs(picked, ENVS.map((e) => e.id), true), ENVS)).toBe(ENVS.length);
    expect(pickedIn(setEnvs(picked, ENVS.map((e) => e.id), false), ENVS)).toBe(0);
  });
});

describe("labels", () => {
  it("words the summary", () => {
    expect(summaryLine(0)).toBe("No environment chosen");
    expect(summaryLine(1)).toBe("1 environment chosen");
    expect(summaryLine(3)).toBe("3 environments chosen");
  });

  it("lists size, seconds and rivals", () => {
    expect(envFacts({ ...BLANK_ENV, size: [400, 300], seconds: 30 })).toEqual(["400×300", "30 s"]);
    expect(envFacts({ ...BLANK_ENV, size: [400, 300], seconds: 30, rivals: [{ species: 0, count: 2, source: "random" }, { species: 1, count: 1, source: "random" }] })).toEqual(["400×300", "30 s", "3 rivals"]);
  });
});
