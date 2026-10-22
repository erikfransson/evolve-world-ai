import type { EcoConfig } from "../sim/ecoConfig.ts";
import { ECO_LOCKED, ECO_PRESETS, withEcoPreset } from "../sim/presets.ts";
import type { EcoPreset } from "../sim/presets.ts";
import type { Board } from "../sim/leaderboard.ts";
import { ECO_FORM } from "./ecoSettingsForm.ts";
import type { FormSpec } from "./settingsForm.ts";
import type { EcoStats } from "./ecoPage.ts";
import { formatDuration } from "./page.ts";
import { ECOSYSTEM_COPY } from "./ecoMarkup.ts";
import type { PageCopy } from "./ecoMarkup.ts";

// Page settings for the Ecosystem page script.
export interface ModePage {
  mode: "ecosystem"; // also the copy/paste mode and the scoreboard name
  copy: PageCopy; // the wording and drawings of the shared page structure (ecoBody)
  form: FormSpec<EcoConfig>;
  presets: readonly EcoPreset[];
  locked: readonly string[]; // form fields a preset fixes
  store: string; // localStorage prefix for the cards' open state
  picks: readonly (readonly [id: string, by: Board])[]; // quick-select buttons; copy.pickTitles words them
  tiles: readonly Tile[]; // stat tiles; the season tile follows statTime
  // While the run counts for the scoreboard, the number whose peak the entry notes; null when it does not count.
  peak(s: EcoStats): number | null;
  peakLabel: string; // "peak 1,234 <peakLabel>"
}

export interface Tile {
  id: string;
  label: string;
  tip: string;
  cls?: string; // the tile's classes when not just "tile"
  value(s: EcoStats): string;
  unit?(s: EcoStats): string;
}

const nf = new Intl.NumberFormat("en-US");
const count = (id: string, label: string, tip: string, of: (s: EcoStats) => number, cls?: string): Tile => ({ id, label, tip, cls, value: (s) => nf.format(of(s)) });
const TIME: Tile = { id: "statTime", label: "Simulated time", tip: "How long the world has run, in simulated time.", value: (s) => formatDuration(s.simTime).text, unit: (s) => formatDuration(s.simTime).unit };
const SPEED: Tile = { id: "statSpeed", label: "Speed", tip: "Simulated seconds per real second the computer is achieving. It can be lower than the speed asked for.", value: (s) => (s.speed === null ? "-" : s.speed.toFixed(1)), unit: (s) => (s.speed === null ? "" : " ×") };

export const ECOSYSTEM_PAGE: ModePage = {
  mode: "ecosystem",
  copy: ECOSYSTEM_COPY,
  form: ECO_FORM,
  presets: ECO_PRESETS,
  locked: ECO_LOCKED,
  store: "evolve.eco.card",
  picks: [["pickAge", "age"], ["pickChildren", "children"], ["pickEaten", "eaten"], ["pickKills", "kills"]],
  tiles: [
    count("statPop", "Population", "Creatures alive now.", (s) => s.population, "tile accent"),
    count("statBirths", "Births", "Creatures born since the start.", (s) => s.births),
    count("statDeaths", "Deaths", "Creatures that starved, ate poison or otherwise died since the start.", (s) => s.deaths),
    count("statFood", "Food items", "Pieces of food lying in the world now.", (s) => s.food),
    count("statPoison", "Poison items", "Pieces of poison lying in the world now.", (s) => s.poison),
    TIME,
    count("statDepth", "Deepest lineage", "Generations in the longest unbroken family line alive now. A founder is depth 0.", (s) => s.oldestDepth),
    SPEED,
  ],
  peak: (s) => s.population,
  peakLabel: "creatures",
};

// The config a page opens with: its form's defaults with the Normal preset.
export const openingConfig = (page: ModePage): EcoConfig => withEcoPreset(page.form.defaults, "normal", page.presets);
