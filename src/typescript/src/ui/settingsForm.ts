import { itemCounts, POISON_LETHAL } from "../sim/config.ts";
import type { EngineConfig } from "../sim/config.ts";
import { PLAN_LIMITS } from "../sim/rl/validate.ts";
import { MAP_DENSITY_MAX, PATCH_SIZE_RANGE } from "../sim/terrain.ts";
import { escapeAttr } from "./page.ts";

// Settings forms: one table drives the markup, the config read and the fill, so a field is declared once.
// C is the config a page edits (Trials' SimConfig, the Ecosystem's EcoConfig).
interface Base<C> {
  id: string;
  label: string;
  tip: string;
  advanced?: boolean; // shown under the section's "More settings"
  enabledWhen?: (c: C) => boolean; // greyed out and disabled while false, e.g. season settings with Seasons off
}
export interface Range<C> extends Base<C> {
  kind: "range";
  min: number;
  max: number;
  step: number;
  log?: boolean; // the slider is logarithmic between min and max (wide ranges), the value stays the real number
  fmt?: string; // key of FORMATS
  hint?: (c: C) => string; // live text next to the value
  get: (c: C) => number;
  set: (c: C, v: number) => void;
}
export interface Toggle<C> extends Base<C> {
  kind: "toggle";
  get: (c: C) => boolean;
  set: (c: C, v: boolean) => void;
}
export interface Choice<C> extends Base<C> {
  kind: "choice";
  options: readonly (readonly [value: string, label: string])[];
  get: (c: C) => string;
  set: (c: C, v: string) => void;
}
interface Seed<C> extends Base<C> {
  kind: "seed";
}
export type Field<C> = Range<C> | Toggle<C> | Choice<C> | Seed<C>;
export interface Section<C> {
  title: string;
  fields: readonly Field<C>[];
  folded?: boolean; // the whole section starts collapsed
  swatch?: string; // CSS colour of a dot before the title
  note?: (c: C) => string; // live line under the title
}
// A settings form: its sections and the config that fields without an input keep.
export interface FormSpec<C> {
  sections: readonly Section<C>[];
  defaults: C;
}

export const range = <C>(f: Omit<Range<C>, "kind">): Range<C> => ({ kind: "range", ...f });

// The two sliders ("<label> min" and "<label> max", ids <id>Min and <id>Max) of a [min, max] setting; moving one past the other pushes it along.
export function rangePair<C>(o: { id: string; label: string; tip: string; min: number; max: number; step: number; fmt?: string; advanced?: boolean; get: (c: C) => readonly number[]; set: (c: C, v: number[]) => void }): Range<C>[] {
  const { get, set, ...shared } = o;
  return [
    range({ ...shared, id: `${o.id}Min`, label: `${o.label} min`, get: (c) => get(c)[0]!, set: (c, v) => { set(c, [v, Math.max(v, get(c)[1]!)]); } }),
    range({ ...shared, id: `${o.id}Max`, label: `${o.label} max`, get: (c) => get(c)[1]!, set: (c, v) => { set(c, [Math.min(v, get(c)[0]!), v]); } }),
  ];
}

// A density (or density per second) times the world area, in items.
type Sized = Pick<EngineConfig, "world">;
export const itemsOf = (c: Sized, density: number): number => itemCounts({ world: { ...c.world, foodDensity: density } }).food;
export const items = (c: Sized, density: number): string => `≈ ${itemsOf(c, density)} items`;
export const perSecond = (c: Sized, density: number): string => `≈ ${itemsOf(c, density)} items/s`;

// The map fields of a World section (terrain.ts): the share of the world area covered by each kind, 0 for none.
type MapKey = "stoneDensity" | "ridgeDensity" | "slowDensity" | "fastDensity";
type SizeKey = "slowSize" | "fastSize";
export function mapFields<C extends Sized>(): Range<C>[] {
  const field = (id: MapKey, label: string, tip: string, max: number): Range<C> =>
    range<C>({ id, label, tip: `${tip} The share of the world it covers, 0 for none. The same seed gives the same map.`, min: 0, max, step: 0.005, fmt: "pct1", get: (c) => c.world[id], set: (c, v) => { c.world[id] = v; } });
  const size = (id: SizeKey, label: string, tip: string): Range<C> =>
    range<C>({ id, label, tip: `${tip} 1 is the standard size. A bigger patch means fewer of them for the same share of the world.`, min: PATCH_SIZE_RANGE[0], max: PATCH_SIZE_RANGE[1], step: 0.05, fmt: "mult", get: (c) => c.world[id], set: (c, v) => { c.world[id] = v; } });
  return [
    field("stoneDensity", "Stones", "Huge lumpy boulders, 500 units across or more, that creatures bounce off and cannot see past.", MAP_DENSITY_MAX.stoneDensity),
    field("ridgeDensity", "Mountain ridges", "Long rocky ridges that creatures bounce off and cannot see past.", MAP_DENSITY_MAX.ridgeDensity),
    field("slowDensity", "Slow ground", "Patches of mud where creatures move at half speed. They sense when they stand on it.", MAP_DENSITY_MAX.slowDensity),
    size("slowSize", "Mud patch size", "How wide each patch of mud is."),
    field("fastDensity", "Fast ground", "Patches of firm ground where creatures move at 175% speed. They sense when they stand on it.", MAP_DENSITY_MAX.fastDensity),
    size("fastSize", "Firm patch size", "How wide each patch of firm ground is."),
  ];
}

// The body plan fields every page shows (Creature and Brain), with one set of labels, tips and PLAN_LIMITS ranges.
// raySpread is in radians in the config and in degrees on the slider; memory is 0 to 1 (memoryUnits).
type PlanKey = "rayCount" | "raySpread" | "rayLength" | "layers" | "neurons" | "memory";
export type PlanAccess<C> = Record<PlanKey, { get: (c: C) => number; set: (c: C, v: number) => void }>;
export function planFields<C>(a: PlanAccess<C>): { creature: Range<C>[]; brain: Range<C>[] } {
  const L = PLAN_LIMITS;
  const deg = Math.round((L.raySpread[1] * 180) / Math.PI);
  return {
    creature: [
      range<C>({ id: "rayCount", label: "Vision rays", tip: "How many laser rays each creature sees with. More rays give a finer view and more inputs to the brain.", min: L.rayCount[0], max: L.rayCount[1], step: 1, ...a.rayCount }),
      range<C>({ id: "raySpread", label: "Vision angle", tip: "Total width of the fan of rays, centred on where the creature faces. 360 looks all around.", min: 10, max: deg, step: 1, fmt: "deg", get: (c) => Math.round((a.raySpread.get(c) * 180) / Math.PI), set: (c, v) => { a.raySpread.set(c, (v * Math.PI) / 180); } }),
      range<C>({ id: "rayLength", label: "Vision range", tip: "How far each vision ray reaches, in world units. Longer sight costs more energy per second.", min: L.rayLength[0], max: L.rayLength[1], step: 1, fmt: "size", ...a.rayLength }),
    ],
    brain: [
      range<C>({ id: "layers", label: "Hidden layers", tip: "How many layers of neurons sit between the creature's eyes and its muscles.", min: L.layers[0], max: L.layers[1], step: 1, ...a.layers }),
      range<C>({ id: "neurons", label: "Neurons per layer", tip: "Neurons in each hidden layer. More can learn richer behaviour but cost more energy per second and learn more slowly.", min: L.neurons[0], max: L.neurons[1], step: 1, ...a.neurons }),
      range<C>({ id: "memory", label: "Memory", tip: "Short- and long-term memory the brain can write to and read back on the next moment, so it can remember what it saw. 0 is none, 0.5 gives 4 short-term and 4 long-term memory units, 1 gives 8 of each.", min: 0, max: 1, step: 0.05, fmt: "dens", ...a.memory }),
    ],
  };
}

// The plan fields of a Trials or Ecosystem config (creature and brain; every hidden layer as wide as the first).
type PlanConfig = Pick<EngineConfig, "creature" | "brain">;
export function configPlanFields<C extends PlanConfig>(defaultNeurons: number): { creature: Range<C>[]; brain: Range<C>[] } {
  return planFields<C>({
    rayCount: { get: (c) => c.creature.rayCount, set: (c, v) => { c.creature.rayCount = v; } },
    raySpread: { get: (c) => c.creature.raySpread, set: (c, v) => { c.creature.raySpread = v; } },
    rayLength: { get: (c) => c.creature.rayLength, set: (c, v) => { c.creature.rayLength = v; } },
    layers: { get: (c) => c.brain.hiddenLayers.length, set: (c, v) => { c.brain.hiddenLayers = new Array<number>(v).fill(c.brain.hiddenLayers[0] ?? defaultNeurons); } },
    neurons: { get: (c) => c.brain.hiddenLayers[0] ?? defaultNeurons, set: (c, v) => { c.brain.hiddenLayers.fill(v); } },
    memory: { get: (c) => c.brain.memory, set: (c, v) => { c.brain.memory = v; } },
  });
}

export function el<T extends HTMLElement>(id: string, kind: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof kind)) throw new Error(`element #${id} is not a ${kind.name}`);
  return e;
}

// Value badge formats, chosen by the output element's data-fmt.
export const FORMATS: Record<string, (v: number) => string> = {
  size: (v) => `${v}`,
  deg: (v) => `${v}°`,
  pct: (v) => `${Math.round(v * 100)}%`,
  dens: (v) => v.toFixed(2),
  dens3: (v) => v.toFixed(3),
  dens4: (v) => v.toFixed(4),
  pct1: (v) => `${+(v * 100).toFixed(1)}%`,
  size1: (v) => v.toFixed(1),
  sec: (v) => `${+v.toFixed(1)} s`,
  min: (v) => `${v} min`,
  speed: (v) => `${v}/s`,
  mult: (v) => `${v.toFixed(2)}×`,
  poison: (v) => (v >= POISON_LETHAL ? "Lethal" : `${v}`),
};

// Logarithmic sliders: the input holds a position 0..LOG_STEPS, data-v keeps the exact value so a saved or typed setting round-trips unchanged.
export const LOG_STEPS = 1000;
export const logPosition = (v: number, lo: number, hi: number): number => Math.round((Math.log(v / lo) / Math.log(hi / lo)) * LOG_STEPS);
// A dragged position as a clean number: three significant digits, a multiple of step, within [lo, hi].
export function logValue(pos: number, lo: number, hi: number, step: number): number {
  const raw = lo * (hi / lo) ** (pos / LOG_STEPS);
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 2);
  return Math.min(hi, Math.max(lo, Math.round((Math.round(raw / unit) * unit) / step) * step));
}
// The real value of a range input (its number, or the exact value behind a logarithmic slider's position).
export function sliderValue(input: HTMLInputElement): number {
  if (input.dataset.log === undefined) return input.valueAsNumber;
  const lo = Number(input.dataset.lo);
  const hi = Number(input.dataset.hi);
  const exact = Number(input.dataset.v);
  if (Number.isFinite(exact) && logPosition(exact, lo, hi) === input.valueAsNumber) return exact;
  const v = logValue(input.valueAsNumber, lo, hi, Number(input.dataset.step));
  input.dataset.v = String(v);
  return v;
}
export function setSliderValue(input: HTMLInputElement, v: number): void {
  if (input.dataset.log === undefined) { input.value = String(v); return; }
  const lo = Number(input.dataset.lo);
  const hi = Number(input.dataset.hi);
  const exact = Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;
  input.dataset.v = String(exact);
  input.value = String(logPosition(exact, lo, hi));
}

// Filled slider track and value badge.
export function syncSlider(input: HTMLInputElement): void {
  const lo = Number(input.min);
  const hi = Number(input.max);
  input.style.setProperty("--p", `${((input.valueAsNumber - lo) / (hi - lo)) * 100}%`);
  const out = document.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
  if (out) out.textContent = (FORMATS[out.dataset.fmt ?? ""] ?? String)(sliderValue(input));
}

const label = <C>(f: Base<C>): string =>
  `<span class="lbl"><label class="name" for="${f.id}">${f.label}</label><span class="tip" tabindex="0" role="img" aria-label="${escapeAttr(f.tip)}" data-tip="${escapeAttr(f.tip)}">ⓘ</span></span>`;

function fieldHtml<C>(f: Field<C>): string {
  if (f.kind === "toggle") return `<div class="toggle">${label(f)}<input id="${f.id}" type="checkbox" role="switch" /></div>`;
  if (f.kind === "seed") {
    return `<div class="field"><div class="row">${label(f)}</div><div class="seed-row"><input id="seed" type="number" step="1" min="0" /><button id="dice" class="icon" type="button" title="Random seed" aria-label="Random seed">🎲</button></div></div>`;
  }
  if (f.kind === "choice") {
    const options = f.options.map(([value, text]) => `<option value="${value}">${text}</option>`).join("");
    return `<div class="field"><div class="row">${label(f)}</div><select id="${f.id}">${options}</select></div>`;
  }
  const fmt = f.fmt ? ` data-fmt="${f.fmt}"` : "";
  const hint = f.hint ? `<span class="hint" id="${f.id}Hint"></span>` : "";
  return `<div class="field"><div class="row">${label(f)}<span class="vals">${hint}<output for="${f.id}"${fmt}></output></span></div><input id="${f.id}" type="range" ${f.log ? `min="0" max="${LOG_STEPS}" step="1" data-log data-lo="${f.min}" data-hi="${f.max}" data-step="${f.step}"` : `min="${f.min}" max="${f.max}" step="${f.step}"`} /></div>`;
}

function sectionHtml<C>(s: Section<C>, index = 0): string {
  const note = s.note ? `<p class="sec-note" id="secNote${index}"></p>` : "";
  const swatch = s.swatch ? `<i class="sw" style="background: ${s.swatch}"></i>` : "";
  const main = s.fields.filter((f) => !f.advanced).map(fieldHtml).join("");
  const advanced = s.fields.filter((f) => f.advanced);
  const more = advanced.length ? `<details class="more"><summary>More settings</summary><div class="more-body">${advanced.map(fieldHtml).join("")}</div></details>` : "";
  if (s.folded) return `<details class="card fold"><summary><h3>${swatch}${s.title}</h3></summary>${note}${main}${more}</details>`;
  return `<section class="card"><h3>${swatch}${s.title}</h3>${note}${main}${more}</section>`;
}

// A built settings form: read the config it describes, fill it from one, and wire it up.
export interface FormHandle<C> {
  read(): C;
  fill(c: C): void;
  // onChange gets the config the form currently describes after every edit.
  init(form: HTMLFormElement, onChange: (c: C) => void): void;
}

// Fills the container with one card per section of the spec.
// A config with a Seed field also has a numeric seed; pages without one (the Arena's) need no seed.
export function buildForm<C extends object>(container: HTMLElement, spec: FormSpec<C>): FormHandle<C> {
  container.innerHTML = spec.sections.map(sectionHtml).join("");
  const fields = spec.sections.flatMap((s) => [...s.fields]);
  const syncHints = (c: C): void => {
    for (const f of fields) if (f.kind === "range" && f.hint) el(`${f.id}Hint`, HTMLElement).textContent = f.hint(c);
    spec.sections.forEach((s, i) => { if (s.note) el(`secNote${i}`, HTMLElement).textContent = s.note(c); });
  };
  // A field whose enabledWhen is false is disabled; a preset-locked field stays disabled either way (see presetPanel).
  const syncEnabled = (c: C): void => {
    for (const f of fields) {
      if (!f.enabledWhen) continue;
      const input = el(f.id, HTMLElement) as HTMLInputElement;
      const off = !f.enabledWhen(c);
      const box = input.closest(".field, .toggle");
      box?.classList.toggle("dep-off", off);
      input.disabled = off || (box?.classList.contains("preset-locked") ?? false);
    }
  };
  const read = (): C => {
    const c = structuredClone(spec.defaults);
    for (const f of fields) {
      const input = el(f.id, HTMLElement) as HTMLInputElement; // a select shares .value
      if (f.kind === "toggle") f.set(c, input.checked);
      else if (f.kind === "range") f.set(c, sliderValue(input));
      else if (f.kind === "choice") { if (f.options.some(([value]) => value === input.value)) f.set(c, input.value); }
      else if (Number.isFinite(input.valueAsNumber)) (c as { seed: number }).seed = Math.min(2 ** 31, Math.max(0, Math.round(input.valueAsNumber)));
    }
    return c;
  };
  const fill = (c: C): void => {
    for (const f of fields) {
      const input = el(f.id, HTMLElement) as HTMLInputElement; // a select shares .value
      if (f.kind === "toggle") input.checked = f.get(c);
      else if (f.kind === "seed") input.value = String((c as { seed: number }).seed);
      else if (f.kind === "range") setSliderValue(input, f.get(c));
      else input.value = String(f.get(c));
    }
    container.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(syncSlider);
    syncHints(c);
    syncEnabled(c);
  };
  const init = (form: HTMLFormElement, onChange: (c: C) => void): void => {
    form.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      if (target.type === "range") syncSlider(target);
      const c = read();
      syncHints(c);
      syncEnabled(c);
      onChange(c);
    });
    // Enter in a field would otherwise submit the form and reload the page, losing all settings.
    form.addEventListener("submit", (e) => e.preventDefault());
    const dice = document.getElementById("dice");
    if (dice) dice.onclick = () => {
      el("seed", HTMLInputElement).value = String(Math.floor(Math.random() * 1_000_000));
      onChange(read());
    };
  };
  return { read, fill, init };
}
