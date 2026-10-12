import type { EngineConfig } from "../sim/config.ts";
import type { PlanView } from "../sim/sensors.ts";

// The Arena's energy readout for a design: what each part costs per second, and how far the starting energy goes.

export interface EnergyBudget {
  living: number; // energy per second just to be alive
  eyes: number; // the rays, by count and length
  brain: number; // hidden neurons and memory units
  rest: number; // living + eyes + brain: the cost of standing still
  thrust: number; // extra at full thrust
  turn: number; // extra at full turn rate
  start: number; // energy at birth
  food: number; // energy one food item gives
}

export function energyBudget(plan: PlanView, config: EngineConfig): EnergyBudget {
  const c = config.creature;
  const neurons = plan.hiddenLayers.reduce((a, b) => a + b, 0) + plan.memoryShort + plan.memoryLong;
  const living = c.livingCost;
  const eyes = (c.rayCost * plan.rayCount * plan.rayLength) / 100; // as planUpkeep
  const brain = c.neuronCost * neurons;
  return { living, eyes, brain, rest: living + eyes + brain, thrust: c.thrustCost, turn: c.turnCost, start: c.startEnergy, food: config.world.foodEnergy };
}

export const f1 = (v: number): string => v.toFixed(v < 1 ? 2 : 1);
const secs = (v: number): string => `${Math.round(v)}\u00a0s`;

// Fills el with the readout: a headline, one bar per cost (scaled to the full-speed total), and the endurance numbers.
export function renderEnergy(el: HTMLElement, b: EnergyBudget): void {
  const full = b.rest + b.thrust;
  const make = (tag: string, cls: string, text = ""): HTMLElement => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const head = make("div", "energy-head");
  head.append(make("span", "energy-big", f1(b.rest)), make("span", "energy-unit", " energy/s standing still"));
  const fast = make("div", "energy-full");
  fast.append(make("span", "nb", `${f1(full)}\u00a0energy/s`), make("span", "", " at full speed"));
  const rows = make("div", "energy-rows");
  const row = (label: string, value: number, cls: string): void => {
    const r = make("div", "energy-row");
    const bar = make("span", "energy-bar");
    const fill = make("span", `energy-fill ${cls}`);
    fill.style.width = `${Math.max(3, (100 * value) / full)}%`;
    bar.append(fill);
    r.append(make("span", "energy-label", label), bar, make("span", "energy-val", f1(value)));
    rows.append(r);
  };
  row("Living", b.living, "living");
  row("Eyes", b.eyes, "eyes");
  row("Brain", b.brain, "brain");
  row("Moving (full thrust)", b.thrust, "moving");
  const foot = make("div", "energy-foot");
  foot.append(
    make("span", "", `Starts with ${Math.round(b.start)}\u00a0energy and lasts `),
    make("b", "", secs(b.start / b.rest)),
    make("span", "", " standing still, "),
    make("b", "", secs(b.start / full)),
    make("span", "", ` at full speed. One food (+${Math.round(b.food)}) buys `),
    make("b", "", secs(b.food / b.rest)),
    make("span", "", "\u00a0of rest."),
  );
  el.replaceChildren(head, fast, rows, foot);
}
