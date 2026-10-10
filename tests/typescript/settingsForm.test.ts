// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, withOverrides } from "../../src/typescript/src/sim/config.ts";
import type { DeepPartial, SimConfig } from "../../src/typescript/src/sim/config.ts";
import { fillForm, initSettingsForm, readConfig } from "../../src/typescript/src/ui/settingsForm.ts";

const html = readFileSync(resolve(process.cwd(), "trials/index.html"), "utf8");
const deg = (d: number): number => (d * Math.PI) / 180;

// Once per file, since the form module keeps references to the elements it first finds.
beforeAll(() => {
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, ""); // page scripts must not load
});

const configs: Record<string, DeepPartial<SimConfig>> = {
  defaults: {},
  "slider minimums": {
    seed: 0,
    world: { width: 200, height: 200, foodDensity: 0, poisonDensity: 0 },
    creature: { rayCount: 1, raySpread: deg(10), rayLength: 40 },
    brain: { hiddenLayers: [4], memory: 0 },
    population: { size: 4 },
    ga: { mutationRate: 0 },
  },
  "slider maximums": {
    seed: 999999,
    world: { width: 4000, height: 3000, foodDensity: 1, poisonDensity: 1, respawn: true },
    creature: { rayCount: 16, raySpread: deg(360), rayLength: 300 },
    brain: { hiddenLayers: [32, 32, 32, 32], memory: 1 },
    population: { size: 2000 },
    ga: { mutationRate: 0.5, selection: "proportional" },
  },
};

describe("settings form", () => {
  it.each(Object.entries(configs))("reads back what it was filled with: %s", (_name, over) => {
    const c = withOverrides(DEFAULT_CONFIG, over);
    fillForm(c);
    expect(readConfig()).toEqual(c);
  });

  it("shows value badges and item counts", () => {
    fillForm(withOverrides(DEFAULT_CONFIG, { world: { width: 1000, height: 1000, foodDensity: 0.5, poisonDensity: 0 } }));
    expect(document.getElementById("foodItems")!.textContent).toBe("≈ 50 items");
    expect(document.getElementById("poisonItems")!.textContent).toBe("≈ 0 items");
    expect(document.querySelector('output[for="rayCount"]')!.textContent).toBe("8");
    expect(document.querySelector('output[for="raySpread"]')!.textContent).toBe("75°");
    expect(document.querySelector('output[for="mutationRate"]')!.textContent).toBe("5%");
  });

  it("clamps an out-of-range or invalid seed", () => {
    fillForm(DEFAULT_CONFIG);
    const seed = document.getElementById("seed") as HTMLInputElement;
    seed.value = "-5";
    expect(readConfig().seed).toBe(0);
    seed.value = "12.6";
    expect(readConfig().seed).toBe(13);
    seed.value = "";
    expect(readConfig().seed).toBe(DEFAULT_CONFIG.seed);
  });

  it("reports the new config on every edit and on the dice button, and blocks form submission", () => {
    fillForm(DEFAULT_CONFIG);
    const form = document.getElementById("setup") as HTMLFormElement;
    const seen: SimConfig[] = [];
    initSettingsForm(form, (c) => seen.push(c));
    const rays = document.getElementById("rayCount") as HTMLInputElement;
    rays.value = "5";
    rays.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen.at(-1)!.creature.rayCount).toBe(5);
    expect(document.querySelector('output[for="rayCount"]')!.textContent).toBe("5");
    document.getElementById("dice")!.click();
    expect(seen).toHaveLength(2);
    expect(Number.isInteger(seen[1]!.seed)).toBe(true);
    const submit = new Event("submit", { cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  it("does not mutate the default config", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    fillForm(DEFAULT_CONFIG);
    readConfig().brain.hiddenLayers.push(1);
    expect(DEFAULT_CONFIG).toEqual(before);
  });
});
