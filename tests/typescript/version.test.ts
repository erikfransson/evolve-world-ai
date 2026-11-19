import { readFileSync } from "node:fs";
import { VERSION } from "../../src/typescript/src/version.ts";
import { parseVersionFile } from "../../src/typescript/src/live/freshness.ts";
import { liveVersionFile } from "../../src/typescript/vite.config.ts";

it("the shown version matches package.json and the latest release notes", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../src/typescript/package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.version).toBe(VERSION);
  expect(readFileSync(new URL("../../docs/changes.md", import.meta.url), "utf8")).toContain(`## ${VERSION}`);
});

it("the build writes live/version.json with the same version, in a form the page accepts", () => {
  const emitted: { fileName?: string; source?: unknown }[] = [];
  (liveVersionFile.generateBundle as unknown as (this: unknown) => void).call({ emitFile: (f: { fileName?: string; source?: unknown }) => emitted.push(f) });
  expect(liveVersionFile.apply).toBe("build");
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.fileName).toBe("live/version.json");
  expect(parseVersionFile(String(emitted[0]!.source))).toBe(VERSION);
});
