// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { litLabel, litSwitches, syncLitChip } from "../../src/typescript/src/live/litChip.ts";
import { initCard } from "../../src/typescript/src/ui/overlays.ts";

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
    expect(chip.getAttribute("aria-label")).toMatch(/^Family lit: .*, switch off$/); // the spoken name starts with the visible text
    syncLitChip(chip, litLabel(9, new Map()));
    expect(chip.textContent).toContain("Founder #9");
    syncLitChip(chip, null);
    expect(chip.hidden).toBe(true);
  });

  // A folded Selected card hides its body, and the switch-off there with it: the chip carries its own copy.
  it("stays reachable when the Selected card is folded", () => {
    page();
    const card = document.getElementById("selectedCard")!;
    localStorage.removeItem("t.selected");
    initCard(card, "t.selected", false);
    card.querySelector<HTMLButtonElement>(".ov-toggle")!.click();
    expect(card.classList.contains("min")).toBe(true);
    const css = readFileSync(join(process.cwd(), "src/live.css"), "utf8");
    const shown = (el: HTMLElement): boolean => {
      for (let e: HTMLElement | null = el; e; e = e.parentElement) if (e.hidden) return false;
      return true;
    };
    const label = litLabel(7, new Map([[7, "<b>Bob</b>"]]));
    const chips = [...card.querySelectorAll<HTMLElement>("button[id^=litFamily]")];
    for (const c of chips) syncLitChip(c, label);
    const reachable = chips.filter((c) => shown(c));
    expect(reachable.map((c) => c.id)).toEqual(["litFamilyMin"]);
    expect(reachable[0]!.closest(".ov-head")).not.toBeNull();
    expect(reachable[0]!.querySelector(".lit-name")!.textContent).toBe("Family lit: <b>Bob</b>");
    expect(reachable[0]!.querySelector(".lit-x")!.textContent).toBe("✕"); // its own span, so a cut name keeps it
    expect(reachable[0]!.querySelector("b")).toBeNull();
    expect(css).toMatch(/\.ov-selected:not\(\.min\) \.lit-family-min\b[^{]*\{ display: none; \}/); // on the open card only the 0.10.2 controls show
    syncLitChip(reachable[0]!, null);
    expect(reachable[0]!.hidden).toBe(true);
  });

  // 0.10.2 hid the open card's switch-off whenever a creature was selected, even one from another family: no off switch in sight.
  it("the open card offers the switch-off unless its own family toggle is the pressed one", () => {
    expect(litSwitches(null, false)).toEqual({ card: null, chip: null });
    expect(litSwitches("Grazer", false)).toEqual({ card: "Grazer", chip: "Grazer" }); // nothing selected, or another family's creature
    expect(litSwitches("Grazer", true)).toEqual({ card: null, chip: "Grazer" }); // the toggle reads "Family lit" and is the off switch
    const css = readFileSync(join(process.cwd(), "src/live.css"), "utf8");
    expect(css).not.toMatch(/has-sel \.lit-family\b/);
    expect(readFileSync(join(process.cwd(), "src/live.ts"), "utf8")).toContain('syncLitChip($("litFamily"), lit.card)');
  });

  // live.ts runs on import and cannot be loaded here, so the wiring is read from the source.
  it("is wired to World view and its own click, through the one setHighlight helper", () => {
    const src = readFileSync(join(process.cwd(), "src/live.ts"), "utf8");
    const handler = (id: string): string => src.slice(src.indexOf(`$("${id}").addEventListener`)).split("\n});")[0]!.split("\n").slice(0, 4).join("\n");
    expect(handler("worldView")).toContain("setHighlight(-1)");
    expect(handler("litFamily")).toContain("setHighlight(-1)");
    expect(handler("litFamilyMin")).toContain("setHighlight(-1)");
    // Letting go of a creature, or picking another, hides or resets the card's family toggle: the switch-off must follow at once, not at the next stats.
    const body = (fn: string): string => src.slice(src.indexOf(`function ${fn}(`)).split("\n}\n")[0]!;
    expect(body("clearSelection")).toContain("syncFamily()");
    expect(body("select")).toContain("syncFamily()");
    expect(src).toContain('syncLitChip($("litFamilyMin"), lit.chip)');
  });
});
