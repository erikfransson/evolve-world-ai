import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The build may link the stylesheets in another order than the imports in live.ts, so a Live rule that repeats a selector from a shared stylesheet must not set the same property.
const css = (name: string) => readFileSync(resolve(process.cwd(), "src", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function props(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of source.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    if (m[1].trim().startsWith("@")) continue;
    const names = m[2].split(";").map((d) => d.split(":")[0].trim()).filter(Boolean);
    for (const sel of m[1].split(",").map((s) => s.trim())) {
      const set = out.get(sel) ?? new Set<string>();
      for (const n of names) set.add(n);
      out.set(sel, set);
    }
  }
  return out;
}

describe("live.css rule order", () => {
  it("no selector of live.css sets a property that a shared stylesheet sets for the same selector", () => {
    const live = props(css("live.css"));
    const clashes: string[] = [];
    for (const shared of ["base.css", "style.css", "ecosystem.css"]) {
      for (const [sel, names] of props(css(shared))) {
        for (const n of live.get(sel) ?? []) if (names.has(n)) clashes.push(`${sel} { ${n} } in live.css and ${shared}`);
      }
    }
    expect(clashes).toEqual([]);
  });
});
