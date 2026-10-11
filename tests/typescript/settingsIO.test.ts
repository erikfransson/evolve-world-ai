// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
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
import { initSettingsIO, parseSettings, serialise } from "../../src/typescript/src/ui/settingsIO.ts";

const page = (name: string): string => readFileSync(resolve(import.meta.dirname, `../../src/typescript/${name}/index.html`), "utf8").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "").replace(/<script[\s\S]*?<\/script>/g, "");

describe("settings JSON", () => {
  it("round-trips both modes with the header", () => {
    const trials = structuredClone(DEFAULT_CONFIG);
    trials.world.width = 1234;
    trials.creature.raySpread = 1;
    const text = serialise("trials", trials);
    expect(JSON.parse(text)).toMatchObject({ mode: "trials", version: 1, angles: "radians" });
    expect(parseSettings(text, "trials")).toEqual(trials);
    const eco = structuredClone(DEFAULT_ECO_CONFIG);
    eco.eco.birthCost = 33;
    eco.eco.seasons = true;
    eco.eco.yearMinutes = 8;
    eco.eco.winterFood = 0.2;
    expect(parseSettings(serialise("ecosystem", eco), "ecosystem")).toEqual(eco);
  });

  it("round-trips The Great Hunt and merges each pasted species over its default", () => {
    const c = structuredClone(DEFAULT_PREDATOR_CONFIG);
    c.species![1]!.speed = 1.6;
    c.species![1]!.rayLengthRange = [60, 200];
    const text = serialise("predators", c, "custom");
    expect(JSON.parse(text)).toMatchObject({ mode: "predators", preset: "custom" });
    expect(parseSettings(text, "predators")).toEqual(c);
    const partial = JSON.stringify({ mode: "predators", version: 1, config: { species: [{ founders: 10 }, { eatBaseline: 5 }] } });
    const merged = parseSettings(partial, "predators");
    expect(merged.species![0]).toEqual({ ...DEFAULT_PREDATOR_CONFIG.species![0]!, founders: 10 });
    expect(merged.species![1]).toEqual({ ...DEFAULT_PREDATOR_CONFIG.species![1]!, eatBaseline: 5 });
    expect(() => parseSettings(serialise("ecosystem", DEFAULT_ECO_CONFIG), "predators")).toThrow(/for Ecosystem, but this page is The Great Hunt/);
  });

  it("rejects pasted species lists of the wrong length, bad prey indices, unknown keys and wrong types", () => {
    const paste = (species: unknown) => () => parseSettings(JSON.stringify({ mode: "predators", version: 1, config: { species } }), "predators");
    expect(paste([{}])).toThrow(/exactly 2 species \(Prey, Predator\), got 1/);
    expect(paste([{}, {}, {}])).toThrow(/exactly 2 species/);
    expect(paste({})).toThrow(/must be a list of 2 species/);
    expect(paste([{}, { prey: [5] }])).toThrow(/species\[1\].prey" must list other species by index, 0 to 1/);
    expect(paste([{}, { prey: [1] }])).toThrow(/must list other species/);
    expect(paste([{ fangs: 3 }, {}])).toThrow(/unknown config key "species\[0\].fangs"/);
    expect(paste([{}, { speed: "fast" }])).toThrow(/species\[1\].speed" must be a number/);
    expect(paste([{}, { rayLengthRange: [1, 2, 3] }])).toThrow(/must be \[min, max\]/);
    expect(() => parseSettings(JSON.stringify({ mode: "ecosystem", version: 1, config: { species: [] } }), "ecosystem")).toThrow(/unknown config key "species"/);
  });

  it("keeps defaults for missing keys", () => {
    const text = JSON.stringify({ mode: "trials", version: 1, config: { world: { width: 900 } } });
    const c = parseSettings(text, "trials");
    expect(c.world.width).toBe(900);
    expect(c.world.height).toBe(DEFAULT_CONFIG.world.height);
  });

  it("rejects a wrong mode, unknown keys, wrong types and bad headers", () => {
    const trialsText = serialise("trials", DEFAULT_CONFIG);
    expect(() => parseSettings(trialsText, "ecosystem")).toThrow(/for Trials, but this page is Ecosystem/);
    const head = { mode: "trials", version: 1 };
    expect(() => parseSettings(JSON.stringify({ ...head, config: { world: { nope: 1 } } }), "trials")).toThrow(/unknown config key "world.nope"/);
    expect(() => parseSettings(JSON.stringify({ ...head, config: { world: { width: "wide" } } }), "trials")).toThrow(/"world.width" must be a number/);
    expect(() => parseSettings(JSON.stringify({ ...head, extra: 1 }), "trials")).toThrow(/Unknown key "extra"/);
    expect(() => parseSettings(JSON.stringify({ ...head, version: 2 }), "trials")).toThrow(/version 2/);
    expect(() => parseSettings("{oops", "trials")).toThrow(/Not valid JSON/);
    expect(() => parseSettings("[]", "trials")).toThrow(/JSON object/);
  });
});

describe("Copy and Paste on the Trials page", () => {
  let written = "";
  beforeEach(() => {
    document.body.innerHTML = page("trials");
    buildTrials().fill(DEFAULT_CONFIG);
    const form = document.getElementById("setup") as HTMLFormElement;
    trials.init(form, () => undefined);
    initSettingsIO({ mode: "trials", form, read: readConfig, fill: fillForm });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t: string) => { written = t; return Promise.resolve(); }, readText: () => Promise.reject(new Error("denied")) },
    });
  });
  const click = (id: string): void => document.getElementById(id)!.click();
  const box = (): HTMLTextAreaElement => document.getElementById("ioText") as HTMLTextAreaElement;

  it("Copy then Paste restores a changed form", async () => {
    const changed = structuredClone(DEFAULT_CONFIG);
    changed.seed = 77;
    changed.world.width = 1200;
    changed.ga.selection = "proportional";
    fillForm(changed);
    click("copySettings");
    await Promise.resolve();
    expect(JSON.parse(written).config.world.width).toBe(1200);
    expect(document.querySelector("#copySettings .mini-text")!.textContent).toBe("Copied");

    fillForm(DEFAULT_CONFIG);
    click("pasteSettings");
    box().value = written;
    click("ioApply");
    expect(readConfig()).toEqual(changed);
    expect((document.querySelector(".io-scrim") as HTMLElement).hidden).toBe(true);
  });

  it("keeps item size, food energy and poison-free radius from a pasted config without calling them adjusted", () => {
    const custom = structuredClone(DEFAULT_CONFIG);
    Object.assign(custom.world, { itemRadius: 9, foodEnergy: 60, poisonClearRadius: 70 });
    click("pasteSettings");
    box().value = serialise("trials", custom);
    click("ioApply");
    expect(readConfig()).toEqual(custom);
    expect(document.getElementById("ioMsg")!.textContent).not.toMatch(/adjusted/);
  });

  it("clamps out-of-range values and lists them", () => {
    const text = JSON.stringify({ mode: "trials", version: 1, config: { world: { width: 99999 } } });
    click("pasteSettings");
    box().value = text;
    click("ioApply");
    expect(readConfig().world.width).toBe(4000);
    expect(document.getElementById("ioMsg")!.textContent).toMatch(/world\.width 99999 → 4000/);
  });

  it("shows an error for a wrong mode and leaves the form alone", () => {
    click("pasteSettings");
    box().value = serialise("ecosystem", DEFAULT_ECO_CONFIG);
    click("ioApply");
    expect(document.getElementById("ioMsg")!.textContent).toMatch(/for Ecosystem/);
    expect(readConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("disables Paste while locked", async () => {
    document.getElementById("setup")!.classList.add("locked");
    await new Promise((r) => setTimeout(r));
    expect((document.getElementById("pasteSettings") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Copy and Paste on the Ecosystem page", () => {
  it("restores a changed form", () => {
    document.body.innerHTML = page("ecosystem");
    form = buildForm(document.getElementById("settings")!, ECO_FORM);
    form.fill(DEFAULT_ECO_CONFIG);
    let written = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { written = t; return Promise.resolve(); } } });
    initSettingsIO({ mode: "ecosystem", form: document.getElementById("setup") as HTMLFormElement, read: form.read, fill: form.fill });
    const changed = structuredClone(DEFAULT_ECO_CONFIG);
    changed.world.width = 3300;
    changed.eco.collisions = false;
    changed.eco.collisionDamage = true;
    changed.eco.damagePerSpeed = 0.45;
    form.fill(changed);
    document.getElementById("copySettings")!.click();
    form.fill(DEFAULT_ECO_CONFIG);
    document.getElementById("pasteSettings")!.click();
    (document.getElementById("ioText") as HTMLTextAreaElement).value = written;
    document.getElementById("ioApply")!.click();
    expect(form.read()).toEqual(changed);
  });
});
