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

describe("add panel start modes", () => {
  const BRAIN = ["rays", "spread", "length", "neurons", "memShort", "memLong"];
  const setup = async () => {
    const { parseFounders } = await import("../../src/typescript/src/live/founders.ts");
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const sent: { plan: unknown; genome: Float32Array }[] = [];
    const panel = new AddPanel(document.getElementById("addPanel")!, { send: (r) => (sent.push(r), true), added() {}, minimised() {} });
    const founders = parseFounders(JSON.parse(readFileSync(join(process.cwd(), "public/live-founders.json"), "utf8")));
    panel.setFounders(founders);
    const disabled = (id: string): boolean => (document.getElementById(`add-${id}`) as HTMLInputElement).disabled;
    return { panel, sent, founders, disabled };
  };

  it("freezes the ray and brain sliders for a founder and unfreezes them for a fresh brain, birth sliders stay editable", async () => {
    const { panel, disabled } = await setup();
    for (const id of BRAIN) expect(disabled(id), id).toBe(true);
    for (const id of ["birthEnergy", "birthCost", "birthCooldown", "mutation"]) expect(disabled(id), id).toBe(false);
    panel.setSource("fresh");
    for (const id of BRAIN) expect(disabled(id), id).toBe(false);
    expect(document.getElementById("addFreshHint")!.hidden).toBe(false);
    panel.setSource("file"); // no file chosen yet: nothing to tune, and the brain sliders are frozen again
    for (const id of BRAIN) expect(disabled(id), id).toBe(true);
    panel.setSource("founder");
    for (const id of BRAIN) expect(disabled(id), id).toBe(true);
    expect(document.getElementById("addFreshHint")!.hidden).toBe(true);
  });

  it("shows the founder's own values on the frozen sliders and sends its genome and plan unchanged", async () => {
    const { panel, sent, founders } = await setup();
    const f = founders[0]!;
    expect((document.getElementById("add-rays") as HTMLInputElement).value).toBe(String(f.plan.rayCount));
    const { LiveWorld } = await import("../../server/src/liveWorld.ts");
    const { smallConfig } = await import("./liveHelpers.ts");
    panel.setRules(new LiveWorld(smallConfig(), null).addRules());
    await (panel as unknown as { go(): Promise<void> }).go();
    expect(sent[0]!.genome).toBe(f.genome);
    expect(sent[0]!.plan).toEqual(f.plan);
  });

  it("makes a fresh genome of the right length for the chosen plan, a new one for each structure", async () => {
    const { freshGenome } = await import("../../src/typescript/src/live/addPanel.ts");
    const { genomeLengthIn } = await import("../../src/typescript/src/sim/rl/env.ts");
    const { LiveWorld } = await import("../../server/src/liveWorld.ts");
    const { smallConfig } = await import("./liveHelpers.ts");
    const { panel, sent, founders } = await setup();
    panel.setRules(new LiveWorld(smallConfig(), null).addRules());
    panel.setSource("fresh");
    const go = (): Promise<void> => (panel as unknown as { go(): Promise<void> }).go();
    await go();
    const first = sent[0]!;
    expect(first.plan).toMatchObject({ ...founders[0]!.plan, raySpread: expect.closeTo(founders[0]!.plan.raySpread, 3) }); // the spread goes through whole degrees
    expect(first.genome.length).toBe(genomeLengthIn("ecosystem", founders[0]!.plan));
    expect(first.genome.every(Number.isFinite)).toBe(true);
    expect(first.genome).not.toEqual(founders[0]!.genome); // a new random brain, not the founder's
    panel.reply({ t: "refused", reason: "busy" });
    await go();
    expect(sent[1]!.genome).toBe(first.genome); // same structure, same brain (a retry keeps what was trained)
    const rays = document.getElementById("add-rays") as HTMLInputElement;
    rays.value = String(Number(rays.value) === 5 ? 6 : 5);
    rays.dispatchEvent(new Event("input"));
    panel.reply({ t: "refused", reason: "busy" });
    await go();
    const plan = sent[2]!.plan as typeof founders[0]["plan"];
    expect(plan.rayCount).toBe(Number(rays.value));
    expect(sent[2]!.genome).not.toBe(first.genome);
    expect(sent[2]!.genome.length).toBe(genomeLengthIn("ecosystem", plan));
    expect(freshGenome(plan, 1)).toEqual(freshGenome(plan, 1)); // seeded: same seed, same brain
  });

  it("keys the trained cache on the start mode", async () => {
    const { sameTrainKey } = await import("../../src/typescript/src/live/addPanel.ts");
    const from = new Float32Array(3);
    const key = { mode: "founder" as const, from, plan: "{}", kinds: "addPretrain" };
    expect(sameTrainKey(key, { ...key })).toBe(true);
    expect(sameTrainKey(key, { ...key, mode: "fresh" })).toBe(false);
    expect(sameTrainKey(key, { ...key, mode: "file" })).toBe(false);
  });
});
