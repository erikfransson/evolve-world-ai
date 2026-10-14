import type { EngineConfig } from "../sim/config.ts";
import { mapSpec } from "../sim/maps/index.ts";
import { POISON_TINT, RICH_TINT, visibleFrom } from "./mapTint.ts";

// Legend rows for the map (terrain.ts), shared by the Trials and Ecosystem pages. A row shows only while the world has that kind.
export const SWATCHES = {
  rock: `<path d="M4.2 6.3 Q6 2.6 10.2 3 Q15.6 2.8 16.6 8 Q18 12.6 14.2 15.8 Q10.6 18 6.6 16 Q2.6 13.4 3.2 9.6 Z" fill="#141b19" /><path d="M4.2 6.3 Q6 2.6 10.2 3 Q15.6 2.8 16.6 8 Q18 12.6 14.2 15.8 Q10.6 18 6.6 16 Q2.6 13.4 3.2 9.6 Z" fill="#7b8982" transform="translate(-0.6 -0.6)" /><path d="M5.4 7 Q6.8 4.2 10 4.4 Q14.4 4.2 15.2 8.4 Q16.2 12 13.2 14.6 Q10.4 16.4 7.2 14.8 Q4.4 12.8 4.8 9.8 Z" fill="#2b3633" /><path d="M6.4 8 Q7.6 5.8 10 5.9 Q12.6 6 12.8 8.4 Q11 9 9.4 11.2 Q7.2 11 6.4 8 Z" fill="#3a4742" opacity="0.8" />`,
  slow: `<path d="M3.4 8.6 Q4.6 3.8 9.6 3.4 Q15.6 3.2 16.6 8.8 Q17.4 14.4 12 16.4 Q6 17.6 3.6 13 Z" fill="#453c2a" stroke="#a69668" stroke-opacity="0.45" stroke-width="1.4" /><path d="M6 8.4 H10.6 M9 12.2 H14" stroke="#0e0a04" stroke-opacity="0.45" stroke-width="1" stroke-linecap="round" />`,
  fast: `<path d="M3.4 8.6 Q4.6 3.8 9.6 3.4 Q15.6 3.2 16.6 8.8 Q17.4 14.4 12 16.4 Q6 17.6 3.6 13 Z" fill="#2e4838" stroke="#82a88e" stroke-opacity="0.45" stroke-width="1.4" /><path d="M5.6 7.6 H12 M7.4 10.4 H14.4 M5.6 13.2 H11" stroke="#c8e4c8" stroke-opacity="0.3" stroke-width="0.8" stroke-linecap="round" />`,
  poison: `<circle cx="10" cy="10" r="7" fill="rgb(128 84 150)" fill-opacity="0.5" />`,
  rich: `<circle cx="10" cy="10" r="7" fill="rgb(56 196 116)" fill-opacity="0.5" />`,
};

const ROWS = [
  { id: "legendRock", swatch: SWATCHES.rock, label: "Rock: creatures bounce off, rays stop" },
  { id: "legendSlow", swatch: SWATCHES.slow, label: "Mud: half speed" },
  { id: "legendFast", swatch: SWATCHES.fast, label: "Firm ground: 175% speed" },
  { id: "legendPoison", swatch: SWATCHES.poison, label: "Purple tint: poisoned region" },
  { id: "legendRich", swatch: SWATCHES.rich, label: "Green tint: rich food region" },
] as const;

// The rows as list items, hidden until syncTerrainLegend shows them.
export const terrainLegendHtml = (): string => ROWS.map((r) => `<li id="${r.id}" hidden><svg viewBox="0 0 20 20" aria-hidden="true">${r.swatch}</svg>${r.label}</li>`).join("");

// Which rows the world has, in ROWS order. A hand-designed map is read from its spec (the densities are 0 there), the random map from its densities.
export function terrainKinds(world: Pick<EngineConfig["world"], "stoneDensity" | "ridgeDensity" | "slowDensity" | "fastDensity" | "map">): boolean[] {
  const spec = world.map ? mapSpec(world.map) : undefined;
  if (!spec) return [world.stoneDensity > 0 || world.ridgeDensity > 0, world.slowDensity > 0, world.fastDensity > 0, false, false];
  const layers = spec.layers;
  return [
    spec.rock.length > 0,
    layers.some((l) => l.mud),
    layers.some((l) => l.firm),
    [spec.basePoison, ...layers.map((l) => l.poison)].some((v) => (v ?? 1) > visibleFrom(POISON_TINT)),
    [spec.baseFood, ...layers.map((l) => l.food)].some((v) => (v ?? 1) > visibleFrom(RICH_TINT)),
  ];
}

export function syncTerrainLegend({ world }: Pick<EngineConfig, "world">): void {
  const show = terrainKinds(world);
  ROWS.forEach((r, i) => {
    const row = document.getElementById(r.id);
    if (row) row.hidden = !show[i];
  });
}
