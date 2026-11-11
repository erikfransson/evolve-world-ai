import { mapSpec, mapVersion } from "../sim/maps/index.ts";
import type { AddRules } from "./add.ts";
import type { WireMap } from "./protocol.ts";

// The "Where" picker of the add panel: Anywhere and a small clickable map of the world's regions, as radio inputs.
// The panel only knows the interface (RegionPicker); the look lives in the markup built here and in live.css (.rp-*).
// Region names reach the page through textContent only. The choice is an index into the hello's map.regions, never coordinates.

export interface PickerRegion {
  name: string; // the hello's row name
  x: number; // world units
  y: number;
  r: number;
  hue?: number;
}
export interface RegionPicker {
  set(regions: PickerRegion[] | null, world: { width: number; height: number }): void; // null hides the picker and clears the choice
  value(): number | null; // the chosen region's index, null for Anywhere
}

// The regions to draw, matched by index to the hello's rows (map.regions), or null while the server does not take a region, the page
// does not know the map's geometry, the server runs another design of the map (its map.version), or the two disagree in count.
export function pickerRegions(rules: AddRules | null, map: WireMap): PickerRegion[] | null {
  const geo = map.name ? mapSpec(map.name)?.regions : undefined;
  const n = rules?.spawnRegions;
  if (!geo || !n || n !== geo.length || map.regions.length !== geo.length) return null;
  if (map.version !== undefined && map.version !== mapVersion(map.name!)) return null;
  return geo.map((g, i) => ({ name: map.regions[i]!.name, x: g.x, y: g.y, r: g.r, ...(g.hue !== undefined ? { hue: g.hue } : {}) }));
}

const SHOW = 1.25; // drawn this much larger than the region, so small ones stay easy to hit

let uid = 0;
export function createRegionPicker(host: HTMLElement, onChange: () => void): RegionPicker {
  const id = `rp${++uid}`;
  let regions: PickerRegion[] | null = null;
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const radio = (value: string, label: string, cls: string, checked: boolean): HTMLLabelElement => {
    const l = mk("label", cls);
    const i = document.createElement("input");
    i.type = "radio";
    i.name = id;
    i.value = value;
    i.checked = checked;
    i.addEventListener("change", () => {
      caption();
      onChange();
    });
    l.append(i, mk("span", "rp-dot"), mk("span", "rp-name", label));
    return l;
  };
  const cap = mk("p", "hint rp-cap");
  cap.setAttribute("aria-live", "polite");
  const chosen = (): number | null => {
    const v = host.querySelector<HTMLInputElement>(`input[name="${id}"]:checked`)?.value;
    return v === undefined || v === "any" ? null : Number(v);
  };
  const caption = (): void => {
    const i = chosen();
    cap.textContent = i === null || !regions?.[i] ? "A random free spot anywhere in the world." : `A random free spot inside ${regions[i]!.name}.`;
  };
  return {
    set(next, world) {
      const was = regions && chosen() !== null ? regions[chosen()!]?.name : undefined;
      regions = next;
      host.hidden = !next;
      host.replaceChildren();
      if (!next || !(world.width > 0) || !(world.height > 0)) {
        host.hidden = true;
        regions = null;
        return;
      }
      const keep = next.findIndex((g) => g.name === was);
      const group = mk("div", "rp-group");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "Where it spawns");
      const map = mk("div", "rp-map");
      map.style.aspectRatio = `${world.width} / ${world.height}`;
      next.forEach((g, i) => {
        const l = radio(String(i), g.name, "rp-spot", i === keep);
        l.style.left = `${(100 * g.x) / world.width}%`;
        l.style.top = `${(100 * g.y) / world.height}%`;
        l.style.width = `${(100 * 2 * g.r * SHOW) / world.width}%`;
        const dot = l.querySelector<HTMLElement>(".rp-dot")!;
        dot.style.setProperty("--rp-hue", g.hue === undefined ? "" : String(g.hue));
        if (g.hue !== undefined) l.classList.add("hued");
        map.append(l);
      });
      group.append(radio("any", "Anywhere", "rp-any", keep < 0), map);
      host.append(group, cap);
      caption();
    },
    value: () => (regions ? chosen() : null),
  };
}
