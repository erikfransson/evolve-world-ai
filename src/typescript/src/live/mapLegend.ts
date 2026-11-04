import type { Terrain } from "../sim/terrain.ts";
import { mapSwatch } from "../ui/mapSwatch.ts";
import type { SwatchKind } from "../ui/mapSwatch.ts";

// Fills the legend's ground and region tiles with swatches cut from the built map, once it is ready; a region the map has none of
// stays hidden, a heading with no rows left goes too.
export function paintMapLegend(root: HTMLElement, t: Terrain): void {
  for (const li of root.querySelectorAll<HTMLElement>("#infoLegend li[data-kind]")) {
    const tile = li.querySelector<HTMLElement>(".lg-tile");
    const c = tile ? mapSwatch(t, li.dataset.kind as SwatchKind) : null;
    if (c) {
      tile!.replaceChildren(c);
      li.hidden = false;
    } else if (!tile?.firstChild) li.hidden = true;
  }
  for (const head of root.querySelectorAll<HTMLElement>("#infoLegend .lg-head")) {
    let next = head.nextElementSibling as HTMLElement | null;
    let any = false;
    while (next && !next.classList.contains("lg-head")) {
      if (!next.hidden) any = true;
      next = next.nextElementSibling as HTMLElement | null;
    }
    head.hidden = !any;
  }
}

let watching: IntersectionObserver | null = null;
let pending = 0; // bumped by every new map, so a paint still waiting for idle time drops out

// paintMapLegend once the legend (below the world view) comes into view and the page has idle time: its swatches cost a second or more of
// drawing (rock and ground images at a close zoom), which would otherwise hold up the first full view of the map. A newer map replaces a wait still pending.
export function paintMapLegendWhenSeen(root: HTMLElement, t: Terrain): void {
  watching?.disconnect();
  watching = null;
  const ticket = ++pending;
  const paint = (): void => {
    if (ticket === pending) paintMapLegend(root, t);
  };
  if (typeof IntersectionObserver === "undefined") return paint();
  const o = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting) || watching !== o) return;
    o.disconnect();
    watching = null;
    if (typeof requestIdleCallback === "function") requestIdleCallback(paint, { timeout: 1500 });
    else setTimeout(paint, 200);
  });
  watching = o;
  o.observe(root.querySelector("#infoLegend") ?? root);
}
