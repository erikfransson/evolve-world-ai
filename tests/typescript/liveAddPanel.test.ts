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

describe("add panel review fixes", () => {
  const setup = async () => {
    const { parseFounders } = await import("../../src/typescript/src/live/founders.ts");
    const { LiveWorld } = await import("../../server/src/liveWorld.ts");
    const { smallConfig } = await import("./liveHelpers.ts");
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const sent: { plan: { raySpread: number }; genome: Float32Array }[] = [];
    const panel = new AddPanel(document.getElementById("addPanel")!, { send: (r) => (sent.push(r as never), true), added() {}, minimised() {} });
    panel.setRules(new LiveWorld(smallConfig(), null).addRules());
    const founders = parseFounders(JSON.parse(readFileSync(join(process.cwd(), "public/live-founders.json"), "utf8")));
    panel.setFounders(founders);
    const go = (): Promise<void> => (panel as unknown as { go(): Promise<void> }).go();
    const locked = (): boolean[] => [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('#addPanel input[name="addSource"], #addPanel .founder')].map((e) => e.disabled);
    return { panel, sent, founders, go, locked };
  };

  it("disables the source radios and founder buttons while training and while an add is in flight", async () => {
    const training = await import("../../src/typescript/src/live/training.ts");
    let finish: (g: Float32Array) => void = () => {};
    const spy = vi.spyOn(training, "train").mockImplementation(() => ({ done: new Promise<Float32Array>((res) => (finish = res)), cancel() {}, stoppedHidden: false }));
    try {
      const { panel, go, locked, founders } = await setup();
      expect(locked().every((d) => !d)).toBe(true);
      (document.getElementById("addPretrain") as HTMLInputElement).checked = true;
      const run = go();
      expect(locked().length).toBeGreaterThan(3);
      expect(locked().every(Boolean)).toBe(true); // training
      finish(founders[0]!.genome);
      await run;
      expect(locked().every(Boolean)).toBe(true); // waiting for the reply
      panel.reply({ t: "refused", reason: "busy" });
      expect(locked().every((d) => !d)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives the next fresh add a new brain after a successful add, but keeps it for a refused one", async () => {
    const { panel, sent, go } = await setup();
    panel.setSource("fresh");
    await go();
    panel.reply({ t: "refused", reason: "busy" });
    await go();
    expect(sent[1]!.genome).toBe(sent[0]!.genome);
    panel.reply({ t: "added", ids: [1], name: "MyFresh" });
    await go();
    expect(sent[2]!.genome).not.toBe(sent[0]!.genome);
    expect(sent[2]!.genome).not.toEqual(sent[0]!.genome);
  });

  it("shows an off-step file plan's own values on the frozen sliders and sends them", async () => {
    const { panel, sent, founders, go } = await setup();
    const { freshGenome } = await import("../../src/typescript/src/live/addPanel.ts");
    const plan = { ...founders[0]!.plan, raySpread: 1.0, rayLength: 123.4 };
    const file = new File([JSON.stringify({ format: "evolve-world-creature", version: 1, kind: "forager", name: "Odd", plan, genome: Array.from(freshGenome(plan, 3)), training: {} })], "odd.json");
    panel.setSource("file");
    await (panel as unknown as { readFile(f: File): Promise<void> }).readFile(file);
    expect(document.getElementById("addFileMsg")!.classList.contains("error")).toBe(false);
    const spread = document.getElementById("add-spread") as HTMLInputElement;
    expect(spread.disabled).toBe(true);
    expect(spread.step).toBe("any"); // a browser snaps a range to its step, so a frozen one takes any
    expect(Number(spread.value)).toBeCloseTo(57.2958, 3);
    expect(spread.parentElement!.querySelector("output")!.textContent).toBe("57.3°");
    expect(document.getElementById("add-length")!.parentElement!.querySelector("output")!.textContent).toBe("123.4");
    await go();
    expect(sent[0]!.plan.raySpread).toBe(1.0);
  });

  it("shows a spread under the slider's minimum as it is", async () => {
    const { panel, founders } = await setup();
    const { freshGenome } = await import("../../src/typescript/src/live/addPanel.ts");
    const plan = { ...founders[0]!.plan, raySpread: (3 * Math.PI) / 180 };
    const file = new File([JSON.stringify({ format: "evolve-world-creature", version: 1, kind: "forager", name: "Narrow", plan, genome: Array.from(freshGenome(plan, 3)), training: {} })], "n.json");
    panel.setSource("file");
    await (panel as unknown as { readFile(f: File): Promise<void> }).readFile(file);
    expect(document.getElementById("add-spread")!.parentElement!.querySelector("output")!.textContent).toBe("3°");
  });

  it("shows empty structure sliders for a file mode with no file, and no founder name on a fresh brain", async () => {
    const { panel } = await setup();
    panel.setSource("file");
    for (const id of ["rays", "spread", "length", "neurons", "memShort", "memLong"]) expect(document.getElementById(`add-${id}`)!.parentElement!.querySelector("output")!.textContent, id).toBe("–");
    panel.setSource("fresh");
    expect((document.getElementById("addName") as HTMLInputElement).value).toBe("MyFresh");
    expect(document.getElementById("add-rays")!.parentElement!.querySelector("output")!.textContent).toBe("8");
    expect((document.getElementById("add-spread") as HTMLInputElement).step).toBe("5");
    panel.setSource("founder");
    expect((document.getElementById("addName") as HTMLInputElement).value).toMatch(/^My(?!Fresh)/);
  });

  it("seeds a fresh brain differently on each default call", async () => {
    const { freshGenome } = await import("../../src/typescript/src/live/addPanel.ts");
    const { founders } = await setup();
    expect(freshGenome(founders[0]!.plan)).not.toEqual(freshGenome(founders[0]!.plan));
  });
});
