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
import { ECOSYSTEM_COPY, PREDATORS_COPY } from "./ecoMarkup.ts";
import type { PageCopy } from "./ecoMarkup.ts";

// What differs between the pages the Ecosystem page script runs: the Ecosystem and The Great Hunt.
export interface ModePage {
  mode: "ecosystem" | "predators"; // also the copy/paste mode and the scoreboard name
  copy: PageCopy; // the wording and drawings of the shared page structure (ecoBody)
  form: FormSpec<EcoConfig>;
  presets: readonly EcoPreset[];
  locked: readonly string[]; // form fields a preset fixes
  store: string; // localStorage prefix for the cards' open state
  speciesColors: readonly string[]; // one per species with several: graph lines, the lineage switch, the Selected chip; empty otherwise
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
  speciesColors: [],
  picks: [["pickAge", "age"], ["pickChildren", "children"], ["pickEaten", "eaten"]],
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

// Species 0 are the prey, species 1 the predators (DEFAULT_PREDATOR_CONFIG).
const PREY = 0;
const PREDATORS = 1;
const speciesCount = (s: EcoStats, k: number) => s.species![k]!;

export const PREDATORS_PAGE: ModePage = {
  mode: "predators",
  copy: PREDATORS_COPY,
  form: PREDATOR_FORM,
  presets: PREDATOR_PRESETS,
  locked: PREDATOR_LOCKED,
  store: "evolve.pred.card",
  speciesColors: SPECIES_COLORS,
  picks: [["pickAge", "age"], ["pickChildren", "children"], ["pickEaten", "eaten"], ["pickKills", "kills"]],
  tiles: [
    count("statPrey", "Prey", "Prey alive now. They graze on plants.", (s) => speciesCount(s, PREY).population, "tile sp-prey"),
    count("statPred", "Predators", "Predators alive now. They eat prey they touch.", (s) => speciesCount(s, PREDATORS).population, "tile sp-pred"),
    count("statFood", "Plants", "Plants growing in the world now.", (s) => s.food),
    count("statKills", "Prey eaten", "Prey caught by predators since the start.", (s) => speciesCount(s, PREY).eaten),
    count("statBirths", "Births", "Creatures of both kinds born since the start.", (s) => s.births),
    count("statDeaths", "Deaths", "Creatures that starved, ate poison, were eaten or otherwise died since the start.", (s) => s.deaths),
    TIME,
    SPEED,
  ],
  // The score is how long both species live side by side.
  peak: (s) => (s.species!.every((c) => c.population > 0) ? speciesCount(s, PREDATORS).population : null),
  peakLabel: "predators",
};

// The config a page opens with: its form's defaults with the Normal preset.
export const openingConfig = (page: ModePage): EcoConfig => withEcoPreset(page.form.defaults, "normal", page.presets);
