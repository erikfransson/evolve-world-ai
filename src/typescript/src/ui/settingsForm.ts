import { itemCounts, POISON_LETHAL } from "../sim/config.ts";
import type { EngineConfig } from "../sim/config.ts";
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
  sec: (v) => `${v} s`,
  min: (v) => `${v} min`,
  speed: (v) => `${v}/s`,
  mult: (v) => `${v.toFixed(2)}×`,
  poison: (v) => (v >= POISON_LETHAL ? "Lethal" : `${v}`),
};

// Filled slider track and value badge.
export function syncSlider(input: HTMLInputElement): void {
  const lo = Number(input.min);
  const hi = Number(input.max);
  input.style.setProperty("--p", `${((input.valueAsNumber - lo) / (hi - lo)) * 100}%`);
  const out = document.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
  if (out) out.textContent = (FORMATS[out.dataset.fmt ?? ""] ?? String)(input.valueAsNumber);
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
  return `<div class="field"><div class="row">${label(f)}<span class="vals">${hint}<output for="${f.id}"${fmt}></output></span></div><input id="${f.id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" /></div>`;
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
export function buildForm<C extends { seed: number }>(container: HTMLElement, spec: FormSpec<C>): FormHandle<C> {
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
      else if (f.kind === "range") f.set(c, input.valueAsNumber);
      else if (f.kind === "choice") { if (f.options.some(([value]) => value === input.value)) f.set(c, input.value); }
      else if (Number.isFinite(input.valueAsNumber)) c.seed = Math.min(2 ** 31, Math.max(0, Math.round(input.valueAsNumber)));
    }
    return c;
  };
  const fill = (c: C): void => {
    for (const f of fields) {
      const input = el(f.id, HTMLElement) as HTMLInputElement; // a select shares .value
      if (f.kind === "toggle") input.checked = f.get(c);
      else if (f.kind === "seed") input.value = String(c.seed);
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
    el("dice", HTMLButtonElement).onclick = () => {
      el("seed", HTMLInputElement).value = String(Math.floor(Math.random() * 1_000_000));
      onChange(read());
    };
  };
  return { read, fill, init };
}
