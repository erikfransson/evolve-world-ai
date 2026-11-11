// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AddPanel } from "../../src/typescript/src/live/addPanel.ts";
import type { AddRules } from "../../src/typescript/src/live/add.ts";
import { parseFounders } from "../../src/typescript/src/live/founders.ts";
import { cleanMap } from "../../src/typescript/src/live/mapInfo.ts";
import { pickerRegions } from "../../src/typescript/src/live/regionPicker.ts";
import { mapSpec } from "../../src/typescript/src/sim/maps/index.ts";

const NAMES = ["The Crags", "The Blight", "The Mire", "The Bloom", "The Flats", "The Steppe", "The Commons"];
const spec = mapSpec("clock")!;
const rules = (over: Partial<AddRules> = {}): AddRules => ({ maxCopies: 10, everyS: 10, birth: { energy: [100, 500], cost: [50, 250], cooldown: [5, 40] }, costs: { living: 1, ray: 1, neuron: 1 }, spawnRegions: 7, ...over });
const clockMap = (names = NAMES) => cleanMap({ name: "clock", ground: {}, regions: names.map((name) => ({ name, food: 1, poison: 0, ground: "plain", role: "x" })) });
const world = { width: spec.width, height: spec.height };

const setup = () => {
  const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
  const sent: Record<string, unknown>[] = [];
  const panel = new AddPanel(document.getElementById("addPanel")!, { send: (r) => (sent.push(r as never), true), added() {}, minimised() {} });
  panel.setFounders(parseFounders(JSON.parse(readFileSync(join(process.cwd(), "public/live-founders.json"), "utf8"))));
  const name = document.getElementById("addName") as HTMLInputElement;
  name.value = "Probe1";
  const go = (): Promise<void> => (panel as unknown as { go(): Promise<void> }).go();
  const where = document.getElementById("addWhere")!;
  const pick = (v: string): void => {
    for (const o of where.querySelectorAll<HTMLInputElement>("input")) o.checked = o.value === v; // a browser unchecks the rest of the group; happy-dom only the siblings
    const r = where.querySelector<HTMLInputElement>(`input[value="${v}"]`)!;
    r.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return { panel, sent, go, where, pick };
};

describe("the where picker", () => {
  it("is hidden while the server does not advertise support, and adds carry no region", async () => {
    const { panel, sent, go, where } = setup();
    panel.setMap(clockMap(), world);
    panel.setRules(rules({ spawnRegions: undefined })); // an older server
    expect(where.hidden).toBe(true);
    await go();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("region");
  });

  it("is hidden when the page and the hello disagree in count, or the map is unknown, or there is no map geometry", () => {
    const { panel, where } = setup();
    panel.setRules(rules());
    panel.setMap(clockMap(NAMES.slice(0, 6)), world); // six rows against seven
    expect(where.hidden).toBe(true);
    panel.setMap(clockMap(), world);
    expect(where.hidden).toBe(false);
    panel.setRules(rules({ spawnRegions: 6 })); // the server's count differs from the page's geometry
    expect(where.hidden).toBe(true);
    panel.setRules(rules());
    panel.setMap(cleanMap({ name: "no-such-map", regions: [] }), world);
    expect(where.hidden).toBe(true);
    expect(pickerRegions(rules(), cleanMap({ name: "inland-sea", regions: [{ name: "a" }] }))).toBeNull();
  });

  it("shows Anywhere selected by default and a button for each region, named from the hello", () => {
    const { panel, where } = setup();
    panel.setRules(rules());
    panel.setMap(clockMap(), world);
    const radios = [...where.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(["any", "0", "1", "2", "3", "4", "5", "6"]);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["any"]);
    expect([...where.querySelectorAll(".rp-name")].map((e) => e.textContent)).toEqual(["Anywhere", ...NAMES]);
  });

  it("puts the chosen index into the request, and Anywhere back to no field", async () => {
    const { panel, sent, go, pick } = setup();
    panel.setRules(rules());
    panel.setMap(clockMap(), world);
    pick("3");
    await go();
    expect(sent[0]).toMatchObject({ region: 3 });
    panel.reply({ t: "refused", reason: "busy" });
    pick("any");
    await go();
    expect(sent[1]).not.toHaveProperty("region");
  });

  it("drops the choice when the server stops advertising it, so no stale region is sent", async () => {
    const { panel, sent, go, pick } = setup();
    panel.setRules(rules());
    panel.setMap(clockMap(), world);
    pick("2");
    panel.setRules(rules({ spawnRegions: undefined }));
    await go();
    expect(sent[0]).not.toHaveProperty("region");
  });

  it("keeps the choice across a rules update with the same map", () => {
    const { panel, where, pick } = setup();
    panel.setRules(rules());
    panel.setMap(clockMap(), world);
    pick("5");
    panel.setRules(rules({ everyS: 20 }));
    expect(where.querySelector<HTMLInputElement>("input:checked")!.value).toBe("5");
  });

  it("is not part of the training key: changing the region after a refused add reuses the trained brain", async () => {
    const training = await import("../../src/typescript/src/live/training.ts");
    const runs: string[] = [];
    const spy = vi.spyOn(training, "train").mockImplementation((phase, _plan, genome) => {
      runs.push(phase.kind);
      return { done: Promise.resolve(Float32Array.from(genome, (w) => w + 1)), cancel() {}, stoppedHidden: false };
    });
    const scoreSpy = vi.spyOn(training, "heldScore").mockImplementation(() => ({ done: Promise.resolve(1), cancel() {} }));
    try {
      const { panel, sent, go, pick } = setup();
      panel.setRules(rules());
      panel.setMap(clockMap(), world);
      (document.getElementById("addTrainOn") as HTMLInputElement).checked = true;
      pick("1");
      await go();
      const first = runs.length;
      expect(first).toBeGreaterThan(0);
      expect(sent[0]).toMatchObject({ region: 1 });
      panel.reply({ t: "refused", reason: "that region is crowded, try another" });
      pick("4");
      await go();
      expect(runs).toHaveLength(first); // no retraining
      expect(sent[1]).toMatchObject({ region: 4 });
      expect(sent[1]!.genome).toEqual(sent[0]!.genome);
    } finally {
      spy.mockRestore();
      scoreSpy.mockRestore();
    }
  });
});
