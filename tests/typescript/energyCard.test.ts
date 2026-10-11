// @vitest-environment happy-dom
import { layoutConfig } from "../../src/typescript/src/sim/rl/env.ts";
import { planUpkeep } from "../../src/typescript/src/sim/sensors.ts";
import { energyBudget, renderEnergy } from "../../src/typescript/src/ui/energyCard.ts";

const plan = { rayCount: 8, raySpread: 2, rayLength: 150, hiddenLayers: [16, 8], memoryShort: 2, memoryLong: 2 };

describe("energyBudget", () => {
  it("splits the standing cost into living, eyes and brain, adding up to planUpkeep", () => {
    const config = layoutConfig("ecosystem");
    const b = energyBudget(plan, config);
    expect(b.living + b.eyes + b.brain).toBeCloseTo(b.rest, 12);
    expect(b.rest).toBeCloseTo(planUpkeep(plan, config), 12);
    expect(b.eyes).toBeCloseTo((config.creature.rayCost * 8 * 150) / 100, 12);
    expect(b.brain).toBeCloseTo(config.creature.neuronCost * 28, 12);
  });

  it("renders the headline, four bars and the endurance in plain text", () => {
    const el = document.createElement("div");
    renderEnergy(el, energyBudget(plan, layoutConfig("ecosystem")));
    expect(el.querySelectorAll(".energy-row")).toHaveLength(4);
    expect(el.textContent).toMatch(/energy\/s standing still/);
    expect(el.textContent).toMatch(/at full speed/);
    expect(el.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});
