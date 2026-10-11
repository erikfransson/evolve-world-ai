// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { buildEcoForm, fillEcoForm, readEcoConfig } from "../../src/typescript/src/ui/ecoSettingsForm.ts";
import { fillForm, initSettingsForm, readConfig } from "../../src/typescript/src/ui/settingsForm.ts";
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
    expect(parseSettings(serialise("ecosystem", eco), "ecosystem")).toEqual(eco);
  });

  it("keeps defaults for missing keys", () => {
    const text = JSON.stringify({ mode: "trials", version: 1, config: { world: { width: 900 } } });
    const c = parseSettings(text, "trials");
    expect(c.world.width).toBe(900);
    expect(c.world.height).toBe(DEFAULT_CONFIG.world.height);
  });

  it("rejects a wrong mode, unknown keys, wrong types and bad headers", () => {
    const trialsText = serialise("trials", DEFAULT_CONFIG);
    expect(() => parseSettings(trialsText, "ecosystem")).toThrow(/for Trials, but this is the Ecosystem page/);
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
    fillForm(DEFAULT_CONFIG);
    const form = document.getElementById("setup") as HTMLFormElement;
    initSettingsForm(form, () => undefined);
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
    buildEcoForm(document.getElementById("settings")!);
    fillEcoForm(DEFAULT_ECO_CONFIG);
    let written = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { written = t; return Promise.resolve(); } } });
    initSettingsIO({ mode: "ecosystem", form: document.getElementById("setup") as HTMLFormElement, read: readEcoConfig, fill: fillEcoForm });
    const changed = structuredClone(DEFAULT_ECO_CONFIG);
    changed.world.width = 3300;
    changed.eco.collisions = false;
    changed.eco.collisionDamage = true;
    changed.eco.damagePerSpeed = 0.45;
    fillEcoForm(changed);
    document.getElementById("copySettings")!.click();
    fillEcoForm(DEFAULT_ECO_CONFIG);
    document.getElementById("pasteSettings")!.click();
    (document.getElementById("ioText") as HTMLTextAreaElement).value = written;
    document.getElementById("ioApply")!.click();
    expect(readEcoConfig()).toEqual(changed);
  });
});
