import type { EngineConfig } from "../sim/config.ts";

// Legend rows for the map (terrain.ts), shared by the Trials and Ecosystem pages. A row shows only while the world has that kind.
const SWATCHES = {
  rock: `<path d="M4.2 6.3 Q6 2.6 10.2 3 Q15.6 2.8 16.6 8 Q18 12.6 14.2 15.8 Q10.6 18 6.6 16 Q2.6 13.4 3.2 9.6 Z" fill="#141b19" /><path d="M4.2 6.3 Q6 2.6 10.2 3 Q15.6 2.8 16.6 8 Q18 12.6 14.2 15.8 Q10.6 18 6.6 16 Q2.6 13.4 3.2 9.6 Z" fill="#7b8982" transform="translate(-0.6 -0.6)" /><path d="M5.4 7 Q6.8 4.2 10 4.4 Q14.4 4.2 15.2 8.4 Q16.2 12 13.2 14.6 Q10.4 16.4 7.2 14.8 Q4.4 12.8 4.8 9.8 Z" fill="#2b3633" /><path d="M6.4 8 Q7.6 5.8 10 5.9 Q12.6 6 12.8 8.4 Q11 9 9.4 11.2 Q7.2 11 6.4 8 Z" fill="#3a4742" opacity="0.8" />`,
  slow: `<circle cx="10" cy="10" r="8" fill="rgba(92, 118, 170, 0.6)" />`,
  fast: `<circle cx="10" cy="10" r="8" fill="rgba(214, 196, 84, 0.45)" />`,
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
