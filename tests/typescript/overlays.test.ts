// @vitest-environment happy-dom
import { initCard } from "../../src/typescript/src/ui/overlays.ts";

describe("overlay cards", () => {
  it("a folded card is marked min (a small chip), opens again on its toggle, and keeps the choice", () => {
    document.body.innerHTML = `<section id="c" class="ov"><div class="ov-head"><h2>Lineages</h2><button class="ov-toggle" type="button"></button></div><div class="ov-body">x</div></section>`;
    localStorage.removeItem("t.card");
    const root = document.getElementById("c")!;
    initCard(root, "t.card", false);
    expect(root.classList.contains("min")).toBe(false);
    root.querySelector<HTMLButtonElement>(".ov-toggle")!.click();
    expect(root.classList.contains("min")).toBe(true);
    expect(root.querySelector<HTMLElement>(".ov-body")!.hidden).toBe(true);
    expect(localStorage.getItem("t.card")).toBe("min");
    const again = document.getElementById("c")!;
    again.classList.remove("min");
    initCard(again, "t.card", false); // a reload: the folded state comes back
    expect(again.classList.contains("min")).toBe(true);
  });
});
