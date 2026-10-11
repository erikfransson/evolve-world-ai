// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The repo is public: machine paths and secrets belong in the private operations repo. Patterns are split so this file does not match itself.
const ROOT = join(import.meta.dirname, "../..");
const PATTERNS: [string, RegExp][] = [
  ["home path", new RegExp("/" + "home/[a-z]")],
  ["macOS home path", new RegExp("/" + "Users/[A-Za-z]")],
  ["nvm path", new RegExp("\\." + "nvm/")],
  ["64-hex secret", new RegExp("\\b[0-9a-f]{" + "64}\\b")],
];
const SKIP = /(^|\/)(package-lock\.json|.*\.(png|jpg|ico|wasm|woff2?))$/;

describe("public repo", () => {
  it("tracks no machine paths or secrets", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter((f) => f && !SKIP.test(f));
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), "utf8");
      } catch {
        continue;
      }
      for (const [what, re] of PATTERNS) if (re.test(text)) hits.push(`${f}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});
