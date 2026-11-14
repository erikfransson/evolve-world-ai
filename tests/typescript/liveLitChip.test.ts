// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { litLabel, syncLitChip } from "../../src/typescript/src/live/litChip.ts";

describe("lit family switch-off on the Selected card", () => {
  const page = (): HTMLElement => {
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8"); // vitest runs from src/typescript
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
    return document.getElementById("litFamily")!;
  };

  it("is a hidden button on the page until a family is lit", () => {
    const chip = page();
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.hidden).toBe(true);
    expect(chip.closest("#selectedCard")).not.toBeNull();
  });

  it("shows the family name as text only, and hides again when nothing is lit", () => {
    const chip = page();
    syncLitChip(chip, litLabel(7, new Map([[7, "<img src=x onerror=alert(1)>"]])));
    expect(chip.hidden).toBe(false);
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(chip.getAttribute("aria-label")).toContain("Switch off");
    syncLitChip(chip, litLabel(9, new Map()));
    expect(chip.textContent).toContain("Founder #9");
    syncLitChip(chip, null);
    expect(chip.hidden).toBe(true);
  });

  // live.ts runs on import and cannot be loaded here, so the wiring is read from the source.
  it("is wired to World view and its own click, through the one setHighlight helper", () => {
    const src = readFileSync(join(process.cwd(), "src/live.ts"), "utf8");
    const handler = (id: string): string => src.slice(src.indexOf(`$("${id}").addEventListener`)).split("\n});")[0]!.split("\n").slice(0, 4).join("\n");
    expect(handler("worldView")).toContain("setHighlight(-1)");
    expect(handler("litFamily")).toContain("setHighlight(-1)");
  });
});
