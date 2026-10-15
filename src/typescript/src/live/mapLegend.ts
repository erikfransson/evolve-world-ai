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
