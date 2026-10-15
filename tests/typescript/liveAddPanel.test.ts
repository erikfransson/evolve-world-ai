// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AddPanel } from "../../src/typescript/src/live/addPanel.ts";

// The add panel on the real page markup, before any hello or founders arrive (a slow or failed fetch).
describe("add panel before the hello", () => {
  it("keeps every slider disabled, so a drag has no plan to change", () => {
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8"); // vitest runs from src/typescript
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const panel = new AddPanel(document.getElementById("addPanel")!, { send: () => false, added() {}, minimised() {} });
    panel.setFounders([]); // the founders fetch failed
    const sliders = [...document.querySelectorAll<HTMLInputElement>('#addPanel input[type="range"][id^="add-"]')];
    expect(sliders.length).toBeGreaterThan(5); // the tuning sliders (the colour has no plan behind it)
    for (const s of sliders) expect(s.disabled, s.id).toBe(true);
  });
});
