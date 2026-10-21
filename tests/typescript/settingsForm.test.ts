// @vitest-environment happy-dom
import { pageBody } from "./pageLoader.ts";
import { DEFAULT_CONFIG, withOverrides } from "../../src/typescript/src/sim/config.ts";
import type { DeepPartial, SimConfig } from "../../src/typescript/src/sim/config.ts";
import { buildForm, el, rangePair, range, syncSlider, logPosition, logValue, LOG_STEPS } from "../../src/typescript/src/ui/settingsForm.ts";
import type { FormHandle, FormSpec } from "../../src/typescript/src/ui/settingsForm.ts";
import { ECO_RAY_LENGTH_MIN, ECO_SECTIONS } from "../../src/typescript/src/ui/ecoSettingsForm.ts";
import { World } from "../../src/typescript/src/sim/world.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { TRIALS_FORM, TRIALS_SECTIONS } from "../../src/typescript/src/ui/trialsForm.ts";
import { DESIGN_FORM } from "../../src/typescript/src/ui/arenaForm.ts";

const deg = (d: number): number => (d * Math.PI) / 180;

let form: FormHandle<SimConfig>;
const readConfig = (): SimConfig => form.read();
const fillForm = (c: SimConfig): void => form.fill(c);

beforeAll(() => {
  document.body.innerHTML = pageBody("trials");
  form = buildForm(document.getElementById("settings")!, TRIALS_FORM);
});

const configs: Record<string, DeepPartial<SimConfig>> = {
  defaults: {},
  "slider minimums": {
    seed: 0,
    world: { width: 200, height: 200, foodDensity: 0, poisonDensity: 0, poisonDamage: 0 },
    creature: { rayCount: 1, raySpread: deg(10), rayLength: 10 },
    brain: { hiddenLayers: [1], memory: 0 },
    population: { size: 4 },
    ga: { mutationRate: 0 },
  },
  "slider maximums": {
    seed: 999999,
    world: { width: 4000, height: 3000, foodDensity: 1, poisonDensity: 1, respawn: true },
    creature: { rayCount: 16, raySpread: deg(360), rayLength: 400 },
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
    expect(document.getElementById("foodDensityHint")!.textContent).toBe("≈ 50 items");
    expect(document.getElementById("poisonDensityHint")!.textContent).toBe("≈ 0 items");
    expect(document.querySelector('output[for="rayCount"]')!.textContent).toBe("8");
    expect(document.querySelector('output[for="raySpread"]')!.textContent).toBe("125°");
    expect(document.querySelector('output[for="mutationRate"]')!.textContent).toBe("5%");
    expect(document.querySelector('output[for="poisonDamage"]')!.textContent).toBe("Lethal");
  });

  it("clamps an out-of-range or invalid seed", () => {
    fillForm(DEFAULT_CONFIG);
    const seed = document.getElementById("seed") as HTMLInputElement;
    seed.value = "-5";
    expect(readConfig().seed).toBe(0);
    seed.value = "12.6";
    expect(readConfig().seed).toBe(13);
    seed.value = "99999999999";
    expect(readConfig().seed).toBe(2 ** 31);
    seed.value = "";
    expect(readConfig().seed).toBe(DEFAULT_CONFIG.seed);
  });

  it("reports the new config on every edit and on the dice button, and blocks form submission", () => {
    fillForm(DEFAULT_CONFIG);
    const page = document.getElementById("setup") as HTMLFormElement;
    const seen: SimConfig[] = [];
    form.init(page, (c) => seen.push(c));
    const rays = document.getElementById("rayCount") as HTMLInputElement;
    rays.value = "5";
    rays.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen.at(-1)!.creature.rayCount).toBe(5);
    expect(document.querySelector('output[for="rayCount"]')!.textContent).toBe("5");
    document.getElementById("dice")!.click();
    expect(seen).toHaveLength(2);
    expect(Number.isInteger(seen[1]!.seed)).toBe(true);
    const submit = new Event("submit", { cancelable: true });
    page.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  it("does not mutate the default config", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    fillForm(DEFAULT_CONFIG);
    readConfig().brain.hiddenLayers.push(1);
    expect(DEFAULT_CONFIG).toEqual(before);
  });
});

describe("settings form pieces", () => {
  interface Mini { span: number[]; mode: string; on: boolean; level: number }
  const spec: FormSpec<Mini> = {
    defaults: { span: [2, 6], mode: "x", on: true, level: 15 },
    sections: [{
      title: "Mini",
      fields: [
        ...rangePair<Mini>({ id: "span", label: "Span", tip: "t", min: 0, max: 10, step: 1, get: (c) => c.span, set: (c, v) => { c.span = v; } }),
        { kind: "choice", id: "mode", label: "Mode", tip: "t", options: [["x", "X"], ["y", "Y"]], get: (c) => c.mode, set: (c, v) => { c.mode = v; } },
        { kind: "toggle", id: "on", label: "On", tip: "t", get: (c) => c.on, set: (c, v) => { c.on = v; } },
        range<Mini>({ id: "level", label: "Level", tip: "t", min: 10, max: 20, step: 1, enabledWhen: (c) => c.on, get: (c) => c.level, set: (c, v) => { c.level = v; } }),
      ],
    }],
  };

  it("a [min, max] pair pushes the other end along when one slider passes it", () => {
    const [lo, hi] = rangePair<Mini>({ id: "span", label: "Span", tip: "t", min: 0, max: 10, step: 1, get: (c) => c.span, set: (c, v) => { c.span = v; } });
    const c = { ...spec.defaults, span: [2, 6] };
    lo!.set(c, 4);
    expect(c.span).toEqual([4, 6]);
    lo!.set(c, 8);
    expect(c.span).toEqual([8, 8]);
    hi!.set(c, 9);
    expect(c.span).toEqual([8, 9]);
    hi!.set(c, 1);
    expect(c.span).toEqual([1, 1]);
    expect([lo!.get(c), hi!.get(c)]).toEqual([1, 1]);
  });

  it("the slider fill follows the position between min and max, not between 0 and max", () => {
    document.body.innerHTML = '<input id="s" type="range" min="10" max="20" step="1" value="15" />';
    const slider = document.getElementById("s") as HTMLInputElement;
    syncSlider(slider);
    expect(slider.style.getPropertyValue("--p")).toBe("50%");
  });

  it("disables a field while its condition is off, keeps a preset-locked one disabled, and ignores an unknown choice", () => {
    document.body.innerHTML = '<form id="f"><div id="host"></div></form>';
    const form = buildForm(document.getElementById("host")!, spec);
    const level = document.getElementById("level") as HTMLInputElement;
    const box = level.closest(".field")!;
    form.fill({ ...spec.defaults, on: false });
    expect([level.disabled, box.classList.contains("dep-off")]).toEqual([true, true]);
    form.fill({ ...spec.defaults, on: true });
    expect([level.disabled, box.classList.contains("dep-off")]).toEqual([false, false]);
    box.classList.add("preset-locked");
    form.fill({ ...spec.defaults, on: true });
    expect(level.disabled).toBe(true);
    const mode = document.getElementById("mode") as HTMLSelectElement;
    mode.value = "nonsense";
    expect(form.read().mode).toBe("x");
    mode.value = "y";
    expect(form.read().mode).toBe("y");
    expect(() => el("mode", HTMLInputElement)).toThrow(/not a/);
  });
});

describe("Ecosystem form with a map", () => {
  const sizeFields = ECO_SECTIONS.flatMap((s) => s.fields).filter((f) => f.id === "worldWidth" || f.id === "worldHeight");

  it("the world size sliders are disabled when a map sets the size", () => {
    expect(sizeFields).toHaveLength(2);
    const plain = structuredClone(DEFAULT_ECO_CONFIG);
    const mapped = structuredClone(DEFAULT_ECO_CONFIG);
    mapped.world.map = "inland-sea";
    for (const f of sizeFields) {
      expect(f.enabledWhen!(plain)).toBe(true);
      expect(f.enabledWhen!(mapped)).toBe(false);
    }
  });
});

describe("logarithmic sliders", () => {
  const input = (): HTMLInputElement => el("popSize", HTMLInputElement);
  beforeAll(() => {
    document.body.innerHTML = pageBody("trials");
    form = buildForm(document.getElementById("settings")!, TRIALS_FORM);
  });
  it("keep the default, the ends and any integer exactly through fill and read", () => {
    for (const size of [4, 150, 1234, 2000, 9999, 10000]) {
      fillForm(withOverrides(DEFAULT_CONFIG, { population: { size } }));
      expect(readConfig().population.size).toBe(size);
      expect(input().value).toBe(String(logPosition(size, 4, 10000)));
    }
  });
  it("show the real value and put the default well inside the track", () => {
    fillForm(DEFAULT_CONFIG);
    expect(document.querySelector("output[for=popSize]")!.textContent).toBe("150");
    expect(Number(input().value) / LOG_STEPS).toBeGreaterThan(0.25);
  });
  it("clamp a value outside the range", () => {
    fillForm(withOverrides(DEFAULT_CONFIG, { population: { size: 99999 } }));
    expect(readConfig().population.size).toBe(10000);
  });
  it("turn a dragged position into a clean number within the range", () => {
    expect(logValue(0, 4, 10000, 1)).toBe(4);
    expect(logValue(LOG_STEPS, 4, 10000, 1)).toBe(10000);
    expect(logValue(LOG_STEPS / 2, 100, 200000, 100) % 100).toBe(0);
    fillForm(DEFAULT_CONFIG);
    input().value = "500";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    const v = readConfig().population.size;
    expect(v).toBe(logValue(500, 4, 10000, 1));
    expect(v).toBeGreaterThan(4);
    expect(v).toBeLessThan(10000);
  });
});

describe("plan fields", () => {
  // Issue 58: Trials, Ecosystem and Arena show the same creature and brain sliders, with the same limits.
  it("are the same on every page", () => {
    const shape = (sections: readonly { title: string; fields: readonly object[] }[]) =>
      sections.filter((s) => s.title === "Creature" || s.title === "Brain").map((s) => ({ title: s.title, fields: s.fields.map((f) => JSON.stringify(f)) }));
    const arena = shape(DESIGN_FORM.sections);
    expect(arena.map((s) => s.fields.length)).toEqual([3, 3]);
    expect(shape(TRIALS_SECTIONS)).toEqual(arena);
    const eco = shape(ECO_SECTIONS);
    eco[0]!.fields[2] = eco[0]!.fields[2]!.replace(`"min":${ECO_RAY_LENGTH_MIN}`, '"min":10');
    expect(eco).toEqual(arena);
  });

  // The Ecosystem's grids take their cell size from the ray setting, while founders cast rays of up to 250 whatever it says.
  it("keep the Ecosystem's shortest vision range from shrinking the grid cells", () => {
    const field = ECO_SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "rayLength") as { min: number };
    expect(field.min).toBe(40);
    const config = { ...DEFAULT_ECO_CONFIG, creature: { ...DEFAULT_ECO_CONFIG.creature, rayLength: field.min } };
    expect(new World(config, 16).cell).toBeGreaterThanOrEqual(40);
  });
});
