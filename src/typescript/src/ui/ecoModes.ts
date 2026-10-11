import type { EcoConfig } from "../sim/ecoConfig.ts";
import { ECO_LOCKED, ECO_PRESETS, PREDATOR_PRESETS, withEcoPreset } from "../sim/presets.ts";
import type { EcoPreset } from "../sim/presets.ts";
import type { Board } from "../sim/leaderboard.ts";
import { ECO_FORM } from "./ecoSettingsForm.ts";
import type { FormSpec } from "./settingsForm.ts";
import type { EcoStats } from "./ecoPage.ts";
import { formatDuration } from "./page.ts";
import { PREDATOR_FORM, PREDATOR_LOCKED } from "./predatorForm.ts";
import { SPECIES_COLORS } from "./speciesStyle.ts";

// What differs between the pages the Ecosystem page script runs: the Ecosystem and The Great Hunt.
export interface ModePage {
  mode: "ecosystem" | "predators"; // also the copy/paste mode and the scoreboard name
  form: FormSpec<EcoConfig>;
  presets: readonly EcoPreset[];
  locked: readonly string[]; // form fields a preset fixes
  store: string; // localStorage prefix for the cards' open state
  speciesColors: readonly string[]; // one per species with several: graph lines, the lineage switch, the Selected chip; empty otherwise
  picks: readonly (readonly [id: string, by: Board])[]; // quick-select buttons
  tiles: readonly Tile[]; // stat tiles besides the season tile
  // While the run counts for the scoreboard, the number whose peak the entry notes; null when it does not count.
  peak(s: EcoStats): number | null;
  peakLabel: string; // "peak 1,234 <peakLabel>"
}

export interface Tile {
  id: string;
  value(s: EcoStats): string;
  unit?(s: EcoStats): string;
}

const nf = new Intl.NumberFormat("en-US");
const count = (id: string, of: (s: EcoStats) => number): Tile => ({ id, value: (s) => nf.format(of(s)) });
const TIME: Tile = { id: "statTime", value: (s) => formatDuration(s.simTime).text, unit: (s) => formatDuration(s.simTime).unit };
const SPEED: Tile = { id: "statSpeed", value: (s) => (s.speed === null ? "-" : s.speed.toFixed(1)), unit: (s) => (s.speed === null ? "" : " ×") };

export const ECOSYSTEM_PAGE: ModePage = {
  mode: "ecosystem",
  form: ECO_FORM,
  presets: ECO_PRESETS,
  locked: ECO_LOCKED,
  store: "evolve.eco.card",
  speciesColors: [],
  picks: [["pickAge", "age"], ["pickChildren", "children"], ["pickEaten", "eaten"]],
  tiles: [
    count("statPop", (s) => s.population),
    count("statBirths", (s) => s.births),
    count("statDeaths", (s) => s.deaths),
    count("statFood", (s) => s.food),
    count("statPoison", (s) => s.poison),
    TIME,
    count("statDepth", (s) => s.oldestDepth),
    SPEED,
  ],
  peak: (s) => s.population,
  peakLabel: "creatures",
};

// Species 0 are the prey, species 1 the predators (DEFAULT_PREDATOR_CONFIG).
const PREY = 0;
const PREDATORS = 1;
const speciesCount = (s: EcoStats, k: number) => s.species![k]!;

export const PREDATORS_PAGE: ModePage = {
  mode: "predators",
  form: PREDATOR_FORM,
  presets: PREDATOR_PRESETS,
  locked: PREDATOR_LOCKED,
  store: "evolve.pred.card",
  speciesColors: SPECIES_COLORS,
  picks: [["pickAge", "age"], ["pickChildren", "children"], ["pickEaten", "eaten"], ["pickKills", "kills"]],
  tiles: [
    count("statPrey", (s) => speciesCount(s, PREY).population),
    count("statPred", (s) => speciesCount(s, PREDATORS).population),
    count("statFood", (s) => s.food),
    count("statKills", (s) => speciesCount(s, PREY).eaten),
    count("statBirths", (s) => s.births),
    count("statDeaths", (s) => s.deaths),
    TIME,
    SPEED,
  ],
  // The score is how long both species live side by side.
  peak: (s) => (s.species!.every((c) => c.population > 0) ? speciesCount(s, PREDATORS).population : null),
  peakLabel: "predators",
};

// The config a page opens with: its form's defaults with the Normal preset.
export const openingConfig = (page: ModePage): EcoConfig => withEcoPreset(page.form.defaults, "normal", page.presets);
