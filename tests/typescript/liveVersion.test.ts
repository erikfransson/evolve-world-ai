import { versionLabel } from "../../src/typescript/src/live/versionLabel.ts";
import { VERSION } from "../../src/typescript/src/version.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { smallConfig } from "./liveHelpers.ts";

describe("live version label", () => {
  it("shows the page's version, and the server's only when it differs", () => {
    expect(versionLabel(VERSION)).toBe(`Evolve World v${VERSION}`);
    expect(versionLabel("0.0.9", "0.1.0")).toBe("Evolve World v0.1.0 · server v0.0.9");
  });

  it("ignores anything from the server that is not a plain version", () => {
    for (const bad of [null, undefined, 5, "", "1.2", "1.2.3.4", "<b>1.2.3</b>", "1.2.3 ", "v1.2.3", "99999.1.1", { a: 1 }]) expect(versionLabel(bad, "0.1.0")).toBe("Evolve World v0.1.0");
  });

  it("the server's hello carries its version", () => {
    const live = new LiveWorld(smallConfig(), null);
    expect(live.hello(10).serverVersion).toBe(VERSION);
  });
});
