import { TRAITS } from "../sim/popStats.ts";
import type { TraitHistogram } from "../sim/popStats.ts";
import { speciesSwitch } from "./speciesSwitch.ts";

const num = (v: number): string => (Number.isInteger(v) ? String(v) : v >= 100 ? v.toFixed(0) : v.toFixed(1));

// The mean and the span of a trait, e.g. "8.2" and "3 to 12".
export function traitText(h: TraitHistogram, unit: string): { mean: string; range: string } {
  return { mean: `${num(h.mean)}${unit}`, range: h.min === h.max ? "all equal" : `${num(h.min)}${unit} to ${num(h.max)}${unit}` };
}

// The Traits card: a small histogram per body plan trait of the creatures alive now, one species at a time.
export class TraitPanel {
  private readonly list: HTMLElement;
  private stats: readonly (readonly TraitHistogram[] | null)[] = [];
  private species = 0;

  constructor(root: HTMLElement, speciesNames: readonly string[]) {
    const body = root.querySelector<HTMLElement>(".ov-body")!;
    this.list = body.querySelector<HTMLElement>(".trait-list")!;
    speciesSwitch(body, "traitSpecies", speciesNames, (s) => { this.species = s; this.render(); });
  }

  set(stats: readonly (readonly TraitHistogram[] | null)[]): void {
    this.stats = stats;
    this.render();
  }

  clear(): void {
    this.set([]);
  }

  private render(): void {
    const hs = this.stats[this.species];
    if (!hs) return this.list.replaceChildren();
    this.list.replaceChildren(
      ...TRAITS.map((t, i) => {
        const h = hs[i]!;
        const text = traitText(h, t.unit);
        const row = document.createElement("li");
        row.className = "trait-row";
        const label = document.createElement("span");
        label.className = "trait-name";
        label.textContent = t.label;
        const bars = document.createElement("span");
        bars.className = "trait-bars";
        bars.setAttribute("role", "img");
        bars.setAttribute("aria-label", `${t.label}: mean ${text.mean}, ${text.range}`);
        const peak = Math.max(...h.bins);
        for (const c of h.bins) {
          const bar = document.createElement("i");
          bar.style.height = `${c === 0 ? 0 : Math.max(8, (100 * c) / peak)}%`;
          bar.title = `${c} creatures`;
          bars.append(bar);
        }
        const mean = document.createElement("b");
        mean.textContent = text.mean;
        const range = document.createElement("small");
        range.textContent = text.range;
        const value = document.createElement("span");
        value.className = "trait-value";
        value.append(mean, range);
        row.append(label, bars, value);
        return row;
      }),
    );
  }
}
