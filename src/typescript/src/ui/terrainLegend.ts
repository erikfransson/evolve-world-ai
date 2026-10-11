import type { EngineConfig } from "../sim/config.ts";

// Legend rows for the map (terrain.ts), shared by the Trials and Ecosystem pages. A row shows only while the world has that kind.
const SWATCHES = {
  rock: `<circle cx="10" cy="10" r="8" fill="#79828a" /><circle cx="10" cy="10" r="6.2" fill="#394046" /><circle cx="9" cy="9" r="3.4" fill="#444c53" />`,
  slow: `<circle cx="10" cy="10" r="8" fill="rgba(92, 118, 170, 0.6)" /><path d="M5 10 Q7.5 7 10 10 T15 10" fill="none" stroke="rgba(190, 208, 245, 0.9)" stroke-width="1.4" stroke-linecap="round" />`,
  fast: `<circle cx="10" cy="10" r="8" fill="rgba(214, 196, 84, 0.45)" /><path d="M6 6.5 L9.5 10 L6 13.5 M10.5 6.5 L14 10 L10.5 13.5" fill="none" stroke="rgba(255, 240, 160, 0.95)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />`,
};

const ROWS = [
  { id: "legendRock", swatch: SWATCHES.rock, label: "Rock: creatures bounce off, rays stop" },
  { id: "legendSlow", swatch: SWATCHES.slow, label: "Mud: half speed" },
  { id: "legendFast", swatch: SWATCHES.fast, label: "Firm ground: 175% speed" },
] as const;

// The rows as list items, hidden until syncTerrainLegend shows them.
export const terrainLegendHtml = (): string => ROWS.map((r) => `<li id="${r.id}" hidden><svg viewBox="0 0 20 20" aria-hidden="true">${r.swatch}</svg>${r.label}</li>`).join("");

export function syncTerrainLegend({ world }: Pick<EngineConfig, "world">): void {
  const show = [world.stoneDensity > 0 || world.ridgeDensity > 0, world.slowDensity > 0, world.fastDensity > 0];
  ROWS.forEach((r, i) => {
    const row = document.getElementById(r.id);
    if (row) row.hidden = !show[i];
  });
}
