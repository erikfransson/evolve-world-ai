// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { CUSTOM, ECO_LOCKED, ECO_PRESETS, TRIALS_LOCKED, TRIALS_PRESETS, withEcoPreset, withTrialsPreset } from "../../src/typescript/src/sim/presets.ts";
import { buildForm } from "../../src/typescript/src/ui/settingsForm.ts";
import type { FormHandle } from "../../src/typescript/src/ui/settingsForm.ts";
import { ECO_FORM } from "../../src/typescript/src/ui/ecoSettingsForm.ts";
import { TRIALS_FORM } from "../../src/typescript/src/ui/trialsForm.ts";

let form: FormHandle<EcoConfig>;
// Trials form under test, rebuilt by each describe.
let trials: FormHandle<SimConfig>;
const readConfig = (): SimConfig => trials.read();
const fillForm = (c: SimConfig): void => trials.fill(c);
const buildTrials = (): FormHandle<SimConfig> => (trials = buildForm(document.getElementById("settings")!, TRIALS_FORM));
import { initPresetPanel } from "../../src/typescript/src/ui/presetPanel.ts";
import type { PresetPanel } from "../../src/typescript/src/ui/presetPanel.ts";
import { Scoreboard, TOP, describeSettings, insertEntry, settingsOf, withSettings } from "../../src/typescript/src/ui/scoreboard.ts";
import type { Entry } from "../../src/typescript/src/ui/scoreboard.ts";
import { initSettingsIO, parseWithPreset, serialise } from "../../src/typescript/src/ui/settingsIO.ts";
import type { SettingsIO } from "../../src/typescript/src/ui/settingsIO.ts";

const page = (name: string): string => readFileSync(resolve(import.meta.dirname, `../../src/typescript/${name}/index.html`), "utf8").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "").replace(/<script[\s\S]*?<\/script>/g, "");

const entry = (run: string, score: number): Entry => ({ run, score, date: "2026-10-11", settings: settingsOf(DEFAULT_CONFIG) });

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
}
const throwing = {
  getItem: (): string | null => { throw new Error("blocked"); },
  setItem: (): void => { throw new Error("quota"); },
};

describe("Top 3 list", () => {
  it("sorts best first and keeps three", () => {
    let list: Entry[] = [];
    for (const [run, score] of [["a", 10], ["b", 50], ["c", 30], ["d", 40], ["e", 5]] as const) list = insertEntry(list, entry(run, score));
    expect(list.map((e) => e.score)).toEqual([50, 40, 30]);
    expect(list).toHaveLength(TOP);
  });

  it("lets a run improve its own entry and ignores a lower score", () => {
    let list = insertEntry([], entry("a", 10));
    list = insertEntry(list, entry("b", 20));
    list = insertEntry(list, entry("a", 30));
    expect(list.map((e) => [e.run, e.score])).toEqual([["a", 30], ["b", 20]]);
    expect(insertEntry(list, entry("a", 5))).toEqual(list);
  });
});

describe("Scoreboard storage", () => {
  it("keeps boards per preset and reloads them", () => {
    const storage = new MemoryStorage();
    const board = new Scoreboard("trials", storage);
    expect(board.submit("normal", entry("a", 12))).toBe(true);
    expect(board.submit("normal", entry("a", 8))).toBe(false);
    expect(board.top("poison")).toEqual([]);
    expect(new Scoreboard("trials", storage).top("normal").map((e) => e.score)).toEqual([12]);
    expect(new Scoreboard("ecosystem", storage).top("normal")).toEqual([]);
  });

  it("works when storage is unavailable or throws", () => {
    for (const storage of [null, throwing]) {
      const board = new Scoreboard("trials", storage);
      expect(board.submit("normal", entry("a", 12))).toBe(true);
      expect(board.top("normal").map((e) => e.score)).toEqual([12]);
    }
  });

  it("starts empty from corrupt or foreign data", () => {
    const storage = new MemoryStorage();
    storage.setItem("evolve.scores.v1.trials", "{not json");
    expect(new Scoreboard("trials", storage).top("normal")).toEqual([]);
    storage.setItem("evolve.scores.v1.trials", JSON.stringify({ normal: [entry("a", 3), { run: "x", score: "high" }, null] }));
    expect(new Scoreboard("trials", storage).top("normal").map((e) => e.run)).toEqual(["a"]);
  });

  it("round-trips the creature and brain settings", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.seed = 9;
    c.creature.rayCount = 5;
    c.creature.raySpread = (120 * Math.PI) / 180;
    c.brain.hiddenLayers = [12, 12];
    const s = settingsOf(c);
    expect(describeSettings(s)).toBe("5 rays · 120° · range 150 · hidden 12+12 · memory 0.25 · seed 9");
    const back = withSettings(structuredClone(DEFAULT_CONFIG), s);
    expect(back.creature.rayCount).toBe(5);
    expect(back.brain.hiddenLayers).toEqual([12, 12]);
    expect(back.creature.raySpread).toBeCloseTo(c.creature.raySpread);
    expect(back.world).toEqual(DEFAULT_CONFIG.world);
  });
});

describe("preset definitions", () => {
  it("fix the Trials world at 2300 x 1400 and leave other settings alone", () => {
    for (const p of TRIALS_PRESETS) {
      const c = withTrialsPreset(DEFAULT_CONFIG, p.id);
      expect(c.world).toEqual(p.world);
      expect([c.world.width, c.world.height]).toEqual([2300, 1400]);
      expect({ ...c, world: 0 }).toEqual({ ...DEFAULT_CONFIG, world: 0 });
      expect(p.description.length).toBeGreaterThan(10);
    }
    expect(withTrialsPreset(DEFAULT_CONFIG, CUSTOM)).toEqual(DEFAULT_CONFIG);
  });

  it("set only world and regrowth in Ecosystem", () => {
    for (const p of ECO_PRESETS) {
      const c = withEcoPreset(DEFAULT_ECO_CONFIG, p.id);
      expect(c.world.foodDensity).toBe(p.world.foodDensity);
      expect(c.eco.foodRegrow).toBe(p.regrowth.foodRegrow);
      expect({ ...c, world: 0, eco: { ...c.eco, ...DEFAULT_ECO_CONFIG.eco } }).toEqual({ ...DEFAULT_ECO_CONFIG, world: 0 });
    }
    expect(withEcoPreset(DEFAULT_ECO_CONFIG, CUSTOM)).toEqual(DEFAULT_ECO_CONFIG);
  });
});

function expectOnSteps(): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const steps = (Number(r.value) - Number(r.min)) / Number(r.step);
    expect(Math.abs(steps - Math.round(steps)), r.id).toBeLessThan(1e-6);
    expect(Number(r.value), r.id).toBeLessThanOrEqual(Number(r.max));
    expect(Number(r.value), r.id).toBeGreaterThanOrEqual(Number(r.min));
  }
}
const disabled = (id: string): boolean => (document.getElementById(id) as HTMLInputElement).disabled;
const pick = (id: string): void => {
  const s = document.getElementById("preset") as HTMLSelectElement;
  s.value = id;
  s.dispatchEvent(new Event("change", { bubbles: true }));
};
const rows = (): string[] => [...document.querySelectorAll("#presetBoard .top3 li")].map((li) => li.textContent ?? "");

describe("Trials preset panel", () => {
  const storage = new MemoryStorage();
  const board = new Scoreboard("trials", storage);
  let panel: PresetPanel;
  let io: SettingsIO;
  let inputs = 0;
  let written = "";

  beforeAll(() => {
    document.body.innerHTML = page("trials");
    const form = document.getElementById("setup") as HTMLFormElement;
    buildTrials().fill(DEFAULT_CONFIG);
    trials.init(form, () => { inputs++; });
    panel = initPresetPanel({
      container: document.getElementById("settings")!,
      form,
      presets: TRIALS_PRESETS,
      locked: TRIALS_LOCKED,
      board,
      formatScore: (s) => `${s.toFixed(1)} s`,
      read: readConfig,
      fill: fillForm,
      withPreset: withTrialsPreset,
      apply: (t) => io.apply(t),
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { written = t; return Promise.resolve(); }, readText: () => Promise.reject(new Error("denied")) } });
    io = initSettingsIO({ mode: "trials", form, read: readConfig, fill: fillForm, preset: { get: panel.current, set: panel.select } });
  });

  it("lists every preset and Custom with a description", () => {
    const names = [...document.querySelectorAll("#preset option")].map((o) => o.textContent);
    expect(names).toEqual(["Normal", "Poison everywhere", "Starvation", "Sparse giants", "Custom"]);
    panel.select("starvation");
    expect(document.getElementById("presetDesc")!.textContent).toBe(TRIALS_PRESETS[2]!.description);
  });

  it("applies the preset world and locks exactly the world fields", () => {
    pick("poison");
    expect(panel.current()).toBe("poison");
    const c = readConfig();
    expect(c.world).toEqual(TRIALS_PRESETS[1]!.world);
    expect(c.world.width).toBe(2300);
    for (const id of TRIALS_LOCKED) expect(disabled(id), id).toBe(true);
    for (const id of ["rayCount", "raySpread", "rayLength", "layers", "neurons", "memory", "popSize", "mutationRate", "seed", "selection"]) expect(disabled(id), id).toBe(false);
    expect(document.getElementById("worldWidth")!.closest(".field")!.classList.contains("preset-locked")).toBe(true);
    expectOnSteps();
  });

  it("Custom after a preset keeps that preset's world values", () => {
    pick("giants");
    pick(CUSTOM);
    const c = readConfig();
    const giants = TRIALS_PRESETS[3]!.world;
    expect([c.world.itemRadius, c.world.foodEnergy, c.world.foodDensity]).toEqual([giants.itemRadius, giants.foodEnergy, giants.foodDensity]);
  });

  it("carries item size and energy per food", () => {
    pick("giants");
    expect(readConfig().world).toEqual(TRIALS_PRESETS[3]!.world);
    expect(readConfig().world.itemRadius).toBe(9);
    expectOnSteps();
  });

  it("tells the page to rebuild when a preset is picked", () => {
    const before = inputs;
    pick("normal");
    expect(inputs).toBeGreaterThan(before);
  });

  it("unlocks everything in Custom and keeps the world values", () => {
    pick("poison");
    pick(CUSTOM);
    for (const id of TRIALS_LOCKED) expect(disabled(id), id).toBe(false);
    expect(document.querySelector(".preset-locked")).toBeNull();
    expect(readConfig().world.poisonDensity).toBe(TRIALS_PRESETS[1]!.world.poisonDensity);
    expect(document.getElementById("presetBoard")!.hidden).toBe(true);
  });

  it("shows the Top 3 and loads an entry's settings without touching the world", () => {
    pick("normal");
    expect(rows()).toEqual(["No scores yet. Start a run to set one."]);
    const c = structuredClone(DEFAULT_CONFIG);
    c.creature.rayCount = 3;
    c.brain.hiddenLayers = [10];
    for (const [run, score] of [["a", 61.5], ["b", 200], ["c", 90], ["d", 12]] as const) board.submit("normal", { run, score, date: "2026-10-11", settings: settingsOf(c) });
    panel.refresh();
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toContain("200.0 s");
    expect(document.querySelector("#presetBoard summary")!.getAttribute("title")).toContain("3 rays");
    document.querySelector<HTMLButtonElement>("#presetBoard button")!.click();
    const loaded = readConfig();
    expect(loaded.creature.rayCount).toBe(3);
    expect(loaded.brain.hiddenLayers).toEqual([10]);
    expect(loaded.world).toEqual(TRIALS_PRESETS[0]!.world);
    expect(disabled("worldWidth")).toBe(true);
  });

  it("loads a saved run's full settings, world and preset included", () => {
    const c = withTrialsPreset(DEFAULT_CONFIG, "giants");
    c.population.size = 77;
    c.brain.memory = 0.5;
    const e: Entry = { run: "full", score: 999, date: "2026-10-11", settings: settingsOf(c), config: serialise("trials", c, "giants") };
    pick(CUSTOM);
    board.submit("giants", e);
    pick("giants");
    pick("normal");
    pick("giants");
    document.querySelector<HTMLButtonElement>("#presetBoard button")!.click();
    expect(panel.current()).toBe("giants");
    expect(readConfig().population.size).toBe(77);
    expect(readConfig().brain.memory).toBe(0.5);
    expect(readConfig().world).toEqual(TRIALS_PRESETS[3]!.world);
  });

  it("loads old entries that only have creature and brain over the current settings", () => {
    pick("starvation");
    const c = structuredClone(DEFAULT_CONFIG);
    c.creature.rayCount = 7;
    c.population.size = 77;
    board.submit("starvation", { run: "old", score: 5, date: "2026-10-11", settings: settingsOf(c) });
    fillForm(withTrialsPreset(DEFAULT_CONFIG, "starvation"));
    panel.refresh();
    document.querySelector<HTMLButtonElement>("#presetBoard button")!.click();
    expect(readConfig().creature.rayCount).toBe(7);
    expect(readConfig().population.size).toBe(DEFAULT_CONFIG.population.size);
    expect(readConfig().world).toEqual(TRIALS_PRESETS[2]!.world);
  });

  it("writes the preset into copied settings and selects it on paste", async () => {
    pick("starvation");
    document.getElementById("copySettings")!.click();
    await Promise.resolve();
    expect(JSON.parse(written).preset).toBe("starvation");
    pick(CUSTOM);
    document.getElementById("pasteSettings")!.click();
    (document.getElementById("ioText") as HTMLTextAreaElement).value = written;
    document.getElementById("ioApply")!.click();
    expect(panel.current()).toBe("starvation");
    expect(disabled("foodDensity")).toBe(true);
    expect(readConfig().world).toEqual(TRIALS_PRESETS[2]!.world);
  });

  it("restores the preset's world when the pasted world differs, and unlocks for Custom or no preset", () => {
    const paste = (text: string): void => {
      document.getElementById("pasteSettings")!.click();
      (document.getElementById("ioText") as HTMLTextAreaElement).value = text;
      document.getElementById("ioApply")!.click();
    };
    const edited = structuredClone(DEFAULT_CONFIG);
    edited.world.foodDensity = 0.99;
    paste(serialise("trials", edited, "giants"));
    expect(panel.current()).toBe("giants");
    expect(readConfig().world.foodDensity).toBe(TRIALS_PRESETS[3]!.world.foodDensity);
    paste(serialise("trials", edited, CUSTOM));
    expect(panel.current()).toBe(CUSTOM);
    expect(readConfig().world.foodDensity).toBe(0.99);
    paste(serialise("trials", edited, "poison"));
    paste(serialise("trials", edited));
    expect(panel.current()).toBe(CUSTOM);
    expect(disabled("foodDensity")).toBe(false);
    paste(JSON.stringify({ mode: "trials", preset: "nope", version: 1 }));
    expect(document.getElementById("ioMsg")!.textContent).toMatch(/Unknown preset "nope"/);
  });
});

describe("preset in settings JSON", () => {
  it("is parsed, validated per mode and optional", () => {
    expect(parseWithPreset(serialise("trials", DEFAULT_CONFIG, "poison"), "trials").preset).toBe("poison");
    expect(parseWithPreset(serialise("trials", DEFAULT_CONFIG), "trials").preset).toBeNull();
    expect(parseWithPreset(serialise("ecosystem", DEFAULT_ECO_CONFIG, "crowded"), "ecosystem").preset).toBe("crowded");
    expect(() => parseWithPreset(serialise("trials", DEFAULT_CONFIG, "crowded"), "trials")).toThrow(/Unknown preset "crowded"/);
    expect(() => parseWithPreset(JSON.stringify({ mode: "trials", version: 1, preset: 3 }), "trials")).toThrow(/Unknown preset 3/);
  });
});

describe("Ecosystem preset panel", () => {
  const board = new Scoreboard("ecosystem", new MemoryStorage());
  let panel: PresetPanel;
  let io: SettingsIO;

  beforeAll(() => {
    document.body.innerHTML = page("ecosystem");
    form = buildForm(document.getElementById("settings")!, ECO_FORM);
    form.fill(DEFAULT_ECO_CONFIG);
    panel = initPresetPanel({
      container: document.getElementById("settings")!,
      form: document.getElementById("setup") as HTMLFormElement,
      presets: ECO_PRESETS,
      locked: ECO_LOCKED,
      board,
      formatScore: (s) => `${s} s`,
      read: form.read,
      fill: form.fill,
      withPreset: withEcoPreset,
      apply: (t) => io.apply(t),
    });
    io = initSettingsIO({ mode: "ecosystem", form: document.getElementById("setup") as HTMLFormElement, read: form.read, fill: form.fill, preset: { get: panel.current, set: panel.select } });
  });

  it("offers the four presets and Custom", () => {
    expect([...document.querySelectorAll("#preset option")].map((o) => o.textContent)).toEqual(["Normal", "Poison everywhere", "Scarcity", "Crowded", "Custom"]);
  });

  it.each(ECO_PRESETS.map((p) => p.id))("%s applies the world and regrowth, locks them and stays on slider steps", (id) => {
    pick(id);
    expect(form.read()).toEqual(withEcoPreset(DEFAULT_ECO_CONFIG, id));
    for (const f of ECO_LOCKED) expect(disabled(f), f).toBe(true);
    for (const f of ["initialPopulation", "birthEnergyMin", "rayCount", "neurons", "mutationRate", "collisions", "seed"]) expect(disabled(f), f).toBe(false);
    expectOnSteps();
  });

  it("unlocks in Custom", () => {
    pick("scarcity");
    pick(CUSTOM);
    for (const f of ECO_LOCKED) expect(disabled(f), f).toBe(false);
    expect(form.read().eco.foodRegrow).toBe(ECO_PRESETS[2]!.regrowth.foodRegrow);
  });

  it("loads a Top 3 entry saved with the old single birth settings", () => {
    pick("scarcity");
    const old = JSON.stringify({ mode: "ecosystem", preset: "scarcity", version: 1, config: { eco: { birthEnergy: 130, birthCost: 70, childEnergy: 45, birthCooldown: 8 } } });
    board.submit("scarcity", { run: "old", score: 900, date: "2026-10-01", settings: settingsOf(DEFAULT_ECO_CONFIG), config: old });
    pick("normal");
    pick("scarcity");
    document.querySelector<HTMLButtonElement>("#presetBoard button")!.click();
    const c = form.read();
    expect(c.eco.birthEnergyRange).toEqual([130, 130]);
    expect(c.eco.birthCostRange).toEqual([70, 70]);
    expect(c.eco.birthCooldownRange).toEqual([8, 8]);
    expect(document.querySelector(".io-msg")?.textContent ?? "").toContain("Old settings converted");
  });

  it("lists the best lifetimes with the peak population", () => {
    pick("crowded");
    board.submit("crowded", { run: "a", score: 400, date: "2026-10-11", settings: settingsOf(DEFAULT_ECO_CONFIG), note: "peak 812 creatures" });
    panel.refresh();
    expect(rows()[0]).toContain("400 s");
    expect(document.querySelector("#presetBoard .entry p")!.textContent).toContain("peak 812 creatures");
  });

  it("loads a saved run's birth and aging settings, not only the creature", () => {
    pick("crowded");
    const c = withEcoPreset(DEFAULT_ECO_CONFIG, "crowded");
    c.eco.birthEnergyRange = [61, 120];
    c.eco.initialPopulation = 123;
    board.submit("crowded", { run: "cfg", score: 5000, date: "2026-10-11", settings: settingsOf(c), config: serialise("ecosystem", c, "crowded") });
    pick("normal");
    pick("crowded");
    document.querySelector<HTMLButtonElement>("#presetBoard button")!.click();
    expect(panel.current()).toBe("crowded");
    expect(form.read().eco.birthEnergyRange).toEqual([61, 120]);
    expect(form.read().eco.initialPopulation).toBe(123);
  });
});
