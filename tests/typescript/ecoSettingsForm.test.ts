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
import { PREDATOR_FORM } from "../../src/typescript/src/ui/predatorForm.ts";

const page = (name: string): string => readFileSync(resolve(import.meta.dirname, `../../src/typescript/${name}/index.html`), "utf8").replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, "").replace(/<script[\s\S]*?<\/script>/g, "");

// Browsers snap a range to min + n * step, which happy-dom does not, so check that every default sits on a step.
function expectRangesOnStep(): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const steps = (Number(r.value) - Number(r.min)) / Number(r.step);
    expect(Math.abs(steps - Math.round(steps)), r.id).toBeLessThan(1e-6);
    expect(Number(r.value), r.id).toBeLessThanOrEqual(Number(r.max));
  }
}

describe("Trials settings form", () => {
  let trials: FormHandle<SimConfig>;
  beforeEach(() => {
    document.body.innerHTML = page("trials");
    trials = buildForm(document.getElementById("settings")!, TRIALS_FORM);
  });

  it("reads back what it was filled with", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.seed = 42;
    c.world.width = 1200;
    c.world.respawn = true;
    c.world.poisonDamage = 25;
    c.brain.hiddenLayers = [8, 8];
    c.ga.selection = "proportional";
    trials.fill(c);
    expect(trials.read()).toEqual(c);
    trials.fill(DEFAULT_CONFIG);
    expect(trials.read()).toEqual(DEFAULT_CONFIG);
    expectRangesOnStep();
  });
});

describe("Ecosystem settings form", () => {
  beforeEach(() => {
    document.body.innerHTML = page("ecosystem");
    form = buildForm(document.getElementById("settings")!, ECO_FORM);
  });

  it("reads back the defaults", () => {
    form.fill(DEFAULT_ECO_CONFIG);
    expect(form.read()).toEqual(DEFAULT_ECO_CONFIG);
    expectRangesOnStep();
  });

  it("reads back a changed config", () => {
    const c: EcoConfig = structuredClone(DEFAULT_ECO_CONFIG);
    c.seed = 77;
    c.world.width = 3000;
    c.world.itemRadius = 5.5;
    c.world.poisonDamage = 25;
    c.eco.foodRegrow = 0.025;
    c.eco.birthCooldown = 4;
    c.eco.collisions = false;
    c.eco.collisionDamage = true;
    c.eco.damagePerSpeed = 0.45;
    c.eco.wasm = !c.eco.wasm;
    c.brain.hiddenLayers = [12, 12, 12];
    c.brain.memory = 0.75;
    c.mutation.std = 0.45;
    c.eco.foundersVary = false;
    c.eco.planDrift = 0.05;
    c.eco.structuralRate = 0.1;
    c.eco.seasons = true;
    c.eco.yearMinutes = 12;
    c.eco.winterFood = 0.45;
    form.fill(c);
    expect(form.read()).toEqual(c);
  });

  it("shows the top poison step as Lethal", () => {
    form.fill(DEFAULT_ECO_CONFIG);
    expect(document.querySelector('output[for="poisonDamage"]')!.textContent).toBe("Lethal");
    const c = structuredClone(DEFAULT_ECO_CONFIG);
    c.world.poisonDamage = 40;
    form.fill(c);
    expect(document.querySelector('output[for="poisonDamage"]')!.textContent).toBe("40");
  });

  it("has the variation fields on by default", () => {
    expect(DEFAULT_ECO_CONFIG.eco).toMatchObject({ foundersVary: true, planDrift: 0.02, structuralRate: 0.02 });
  });

  it("disables settings whose toggle is off", () => {
    const off = (id: string): boolean => (document.getElementById(id) as HTMLInputElement).disabled;
    const c: EcoConfig = structuredClone(DEFAULT_ECO_CONFIG);
    c.eco.seasons = false; c.eco.aging = false; c.eco.collisions = true; c.eco.collisionDamage = false;
    form.fill(c);
    expect(["yearMinutes", "winterFood", "agingStart", "agingRate", "damagePerSpeed"].map(off)).toEqual([true, true, true, true, true]);
    expect(off("collisionDamage")).toBe(false);
    c.eco.seasons = true; c.eco.aging = true; c.eco.collisionDamage = true;
    form.fill(c);
    expect(["yearMinutes", "winterFood", "agingStart", "agingRate", "damagePerSpeed"].map(off)).toEqual([false, false, false, false, false]);
    c.eco.collisions = false;
    form.fill(c);
    expect([off("collisionDamage"), off("damagePerSpeed")]).toEqual([true, true]);
    expect(form.read()).toEqual(c); // disabled inputs still read back
  });

  it("shows item counts as hints", () => {
    form.fill(DEFAULT_ECO_CONFIG);
    expect(document.getElementById("foodDensityHint")!.textContent).toBe("≈ 4500 items");
    expect(document.getElementById("foodRegrowHint")!.textContent).toBe("≈ 450 items/s");
  });
});

describe("The Great Hunt settings form", () => {
  beforeEach(() => {
    document.body.innerHTML = page("predators");
    form = buildForm(document.getElementById("settings")!, PREDATOR_FORM);
  });

  it("reads back the defaults and a changed config, species included", () => {
    form.fill(DEFAULT_PREDATOR_CONFIG);
    expect(form.read()).toEqual(DEFAULT_PREDATOR_CONFIG);
    expectRangesOnStep();
    const c: EcoConfig = structuredClone(DEFAULT_PREDATOR_CONFIG);
    c.seed = 9;
    c.eco.foodRegrow = 0.03;
    c.species![0]!.founders = 600;
    c.species![0]!.poolFraction = 0.25;
    c.species![1]!.speed = 1.5;
    c.species![1]!.birthCost = 150;
    c.species![1]!.eatEfficiency = 0.5;
    c.species![1]!.eatBaseline = 25;
    c.species![1]!.rayLengthRange = [120, 320];
    c.eco.collisions = false;
    form.fill(c);
    expect(form.read()).toEqual(c);
  });

  it("folds the shared Ecosystem sections and tucks costs under More settings", () => {
    const folded = [...document.querySelectorAll("details.fold h3")].map((h) => h.textContent);
    expect(folded).toEqual(["Life cycle", "Variation", "Brain", "Mutation"]);
    expect(document.getElementById("predBirthCost")!.closest("details.more")).not.toBeNull();
    expect(document.getElementById("predSpeed")!.closest("details")).toBeNull();
  });
});
