import { DEFAULT_CONFIG, itemCounts } from "../sim/config.ts";
import type { SelectionMethod, SimConfig } from "../sim/config.ts";

interface Field {
  read(c: SimConfig): void; // form element into config
  write(c: SimConfig): void; // config into form element
}

function el<T extends HTMLElement>(id: string, kind: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof kind)) throw new Error(`element #${id} is not a ${kind.name}`);
  return e;
}

function num(id: string, get: (c: SimConfig) => number, set: (c: SimConfig, v: number) => void): Field {
  const input = el(id, HTMLInputElement);
  return { read: (c) => set(c, input.valueAsNumber), write: (c) => { input.value = String(get(c)); } };
}

function bool(id: string, get: (c: SimConfig) => boolean, set: (c: SimConfig, v: boolean) => void): Field {
  const input = el(id, HTMLInputElement);
  return { read: (c) => set(c, input.checked), write: (c) => { input.checked = get(c); } };
}

function choice<T extends string>(id: string, options: readonly T[], get: (c: SimConfig) => T, set: (c: SimConfig, v: T) => void): Field {
  const select = el(id, HTMLSelectElement);
  const valid = (v: string): v is T => (options as readonly string[]).includes(v);
  return { read: (c) => { if (valid(select.value)) set(c, select.value); }, write: (c) => { select.value = get(c); } };
}

const defaultNeurons = DEFAULT_CONFIG.brain.hiddenLayers[0]!;

// Ranges (min, max, step) come from the HTML attributes, which browsers enforce on range inputs.
const SELECTION_OPTIONS: readonly SelectionMethod[] = ["truncation", "proportional"];

// Built on first use, once the DOM exists.
const buildFields = (): readonly Field[] => [
  // Only the seed is a free number input, so only it needs checking.
  num("seed", (c) => c.seed, (c, v) => { if (Number.isFinite(v)) c.seed = Math.min(2 ** 31, Math.max(0, Math.round(v))); }),
  num("worldWidth", (c) => c.world.width, (c, v) => { c.world.width = v; }),
  num("worldHeight", (c) => c.world.height, (c, v) => { c.world.height = v; }),
  num("foodDensity", (c) => c.world.foodDensity, (c, v) => { c.world.foodDensity = v; }),
  num("poisonDensity", (c) => c.world.poisonDensity, (c, v) => { c.world.poisonDensity = v; }),
  bool("respawn", (c) => c.world.respawn, (c, v) => { c.world.respawn = v; }),
  num("rayCount", (c) => c.creature.rayCount, (c, v) => { c.creature.rayCount = v; }),
  num("raySpread", (c) => Math.round((c.creature.raySpread * 180) / Math.PI), (c, v) => { c.creature.raySpread = (v * Math.PI) / 180; }),
  num("rayLength", (c) => c.creature.rayLength, (c, v) => { c.creature.rayLength = v; }),
  num("layers", (c) => c.brain.hiddenLayers.length, (c, v) => { c.brain.hiddenLayers = new Array<number>(v).fill(c.brain.hiddenLayers[0] ?? defaultNeurons); }),
  num("neurons", (c) => c.brain.hiddenLayers[0] ?? defaultNeurons, (c, v) => { c.brain.hiddenLayers.fill(v); }),
  num("popSize", (c) => c.population.size, (c, v) => { c.population.size = v; }),
  num("mutationRate", (c) => c.ga.mutationRate, (c, v) => { c.ga.mutationRate = v; }),
  choice("selection", SELECTION_OPTIONS, (c) => c.ga.selection, (c, v) => { c.ga.selection = v; }),
];

// Value badge formats, chosen by the output element's data-fmt.
const FORMATS: Record<string, (v: number) => string> = {
  size: (v) => `${v}`,
  deg: (v) => `${v}°`,
  pct: (v) => `${Math.round(v * 100)}%`,
  dens: (v) => v.toFixed(2),
};

let fields: readonly Field[] | null = null;
const getFields = (): readonly Field[] => (fields ??= buildFields());

export function readConfig(): SimConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  for (const f of getFields()) f.read(c);
  return c;
}

// Filled slider track and value badge.
function syncSlider(input: HTMLInputElement): void {
  const lo = Number(input.min);
  const hi = Number(input.max);
  input.style.setProperty("--p", `${((input.valueAsNumber - lo) / (hi - lo)) * 100}%`);
  const out = document.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
  if (out) out.textContent = (FORMATS[out.dataset.fmt ?? ""] ?? String)(input.valueAsNumber);
}

// Resulting item counts for the current width, height and densities.
function syncItemHints(c: SimConfig): void {
  const counts = itemCounts(c);
  document.getElementById("foodItems")!.textContent = `≈ ${counts.food} items`;
  document.getElementById("poisonItems")!.textContent = `≈ ${counts.poison} items`;
}

export function fillForm(c: SimConfig): void {
  for (const f of getFields()) f.write(c);
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(syncSlider);
  syncItemHints(c);
}

// onChange gets the config the form currently describes after every edit.
export function initSettingsForm(form: HTMLFormElement, onChange: (c: SimConfig) => void): void {
  form.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.type === "range") syncSlider(target);
    const c = readConfig();
    syncItemHints(c);
    onChange(c);
  });
  // Enter in a field would otherwise submit the form and reload the page, losing all settings.
  form.addEventListener("submit", (e) => e.preventDefault());
  document.getElementById("dice")!.onclick = () => {
    el("seed", HTMLInputElement).value = String(Math.floor(Math.random() * 1_000_000));
  };
}
