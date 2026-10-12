import { readFileSync } from "node:fs";
import { VERSION } from "../../src/typescript/src/version.ts";

it("the shown version matches package.json and the latest release notes", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../src/typescript/package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.version).toBe(VERSION);
  expect(readFileSync(new URL("../../docs/releases.md", import.meta.url), "utf8")).toContain(`## ${VERSION}`);
});
