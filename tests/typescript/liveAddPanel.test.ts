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

describe("add panel copies default", () => {
  it("starts at 3 copies in the radio and in the request (#65)", () => {
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const panel = new AddPanel(document.getElementById("addPanel")!, { send: () => false, added() {}, minimised() {} });
    const checked = [...document.querySelectorAll<HTMLInputElement>('#addPanel input[name="addCopies"]:checked')];
    expect(checked.map((r) => r.value)).toEqual(["3"]);
    expect((panel as unknown as { copies: number }).copies).toBe(3);
  });
});

describe("add panel after training stopped in a hidden tab", () => {
  it("keeps the result and adds only when the visitor presses Add again", async () => {
    const training = await import("../../src/typescript/src/live/training.ts");
    const runs: string[] = [];
    const spy = vi.spyOn(training, "train").mockImplementation((kind, _plan, genome) => {
      runs.push(kind);
      return { done: Promise.resolve(Float32Array.from(genome, (w) => w + 1)), cancel() {}, stoppedHidden: kind === "pretrain" };
    });
    const { parseFounders } = await import("../../src/typescript/src/live/founders.ts");
    const { LiveWorld } = await import("../../server/src/liveWorld.ts");
    const { smallConfig } = await import("./liveHelpers.ts");
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const sent: unknown[] = [];
    const panel = new AddPanel(document.getElementById("addPanel")!, { send: (r) => (sent.push(r), true), added() {}, minimised() {} });
    panel.setRules(new LiveWorld(smallConfig(), null).addRules());
    panel.setFounders(parseFounders(JSON.parse(readFileSync(join(process.cwd(), "public/live-founders.json"), "utf8"))));
    (document.getElementById("addPretrain") as HTMLInputElement).checked = true;
    (document.getElementById("addFinetune") as HTMLInputElement).checked = true;
    const go = (): Promise<void> => (panel as unknown as { go(): Promise<void> }).go();
    try {
      await go();
      expect(runs).toEqual(["pretrain"]); // fine-tune skipped: the visitor is away
      expect(sent).toEqual([]); // and nothing added
      expect(document.getElementById("addMsg")!.textContent).toMatch(/stopped while this tab was hidden/);
      await go(); // the visitor is back and presses Add
      expect(runs).toEqual(["pretrain"]); // the kept result, not trained again
      expect(sent).toHaveLength(1);
      // A run that ends another way (a worker error) while the tab is hidden waits too.
      spy.mockImplementation((kind, _plan, genome) => {
        runs.push(kind);
        return { done: Promise.resolve(Float32Array.from(genome)), cancel() {}, stoppedHidden: false };
      });
      panel.reply({ t: "refused", reason: "busy" }); // the server answered the add
      (document.getElementById("addPretrain") as HTMLInputElement).checked = false; // another set of kinds: trained afresh
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      await go();
      expect(runs).toEqual(["pretrain", "finetune"]);
      expect(sent).toHaveLength(1);
    } finally {
      spy.mockRestore();
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    }
  });
});
