import type { EcoConfig } from "../sim/ecoConfig.ts";
import { withEcoPreset } from "../sim/presets.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import type { Lineage } from "../sim/ecosystem.ts";
import type { Leaders } from "../sim/leaderboard.ts";
import type { TraitHistogram } from "../sim/popStats.ts";
import type { EcoSpeedSetting } from "../worker/ecoProtocol.ts";
import type { Board } from "../sim/leaderboard.ts";
import { BrainView } from "./brainView.ts";
import type { ModePage } from "./ecoModes.ts";
import { buildForm } from "./settingsForm.ts";
import { initCard } from "./overlays.ts";
import type { Card } from "./overlays.ts";
import { initRunSession, renderRunControls } from "./runSession.ts";
import { LeaderPanel } from "./leaderPanel.ts";
import { LineagePanel, lineageColor } from "./lineagePanel.ts";
import { TraitPanel } from "./traitPanel.ts";
import { PopulationGraph } from "./populationGraph.ts";
import type { PopulationSample } from "./populationGraph.ts";
import { $, durationText, setTile } from "./page.ts";
import { initTooltips } from "./tooltip.ts";

export type EcoPhase = "idle" | "running" | "paused" | "extinct";
export type ZoomAction = "in" | "out" | "fit";

export interface EcoStats {
  population: number;
  births: number;
  deaths: number;
  food: number;
  poison: number;
  simTime: number; // simulated seconds
  oldestDepth: number; // longest lineage among living creatures
  speed: number | null; // simulated seconds per real second achieved, null until measured
  helpers: number; // helper threads sensing and thinking, 0 when the simulation runs on one thread
  wasm: boolean; // sense and think run on the WebAssembly kernels
  season: { name: string; factor: number } | null; // null when seasons are off
}

export interface EcoSelected {
  id: number;
  energy: number;
  fullEnergy: number; // energy at which the bar is full (the birth threshold)
  age: number; // seconds
  children: number;
  eaten: number; // food items eaten
  depth: number; // lineage depth, founders are 0
  plan: BodyPlan;
  upkeep: number; // energy per second besides thrust and turning
  birth: { energy: number; cost: number; cooldown: number }; // its heritable birth traits
  drain: number; // energy per second now, thrust and turning included
  founderId: number;
  founderPool: boolean; // the founder came from the seed pool
  founderHue: number;
  died?: boolean; // the values are those of its last moment
}

// What the page tells the simulation side. The page switches phase itself, setPhase is for changes the simulation causes.
export interface EcoHandlers {
  onStart(config: EcoConfig): void;
  onPause(): void;
  onResume(): void;
  onReset(): void;
  onReseed(): void; // after extinction; the page is running again, the caller picks the new seed and calls fillConfig
  onSpeed(speed: EcoSpeedSetting): void;
  onZoom(action: ZoomAction): void;
  onPickBest(by: Board): void; // select and follow the best living creature
  onFollow(follow: boolean): void; // the Follow toggle
  onWorldView(): void; // the World view button; the page has already cleared the Follow toggle
  onShowRays(show: boolean): void;
  onHighlight(founder: number | null): void; // the Lineages card picked a lineage to highlight in the world, or cleared it
  onConfigChange(config: EcoConfig): void; // idle edits of the settings form
}

// What the simulation side drives. Everything is plain data in, so the page never reads the simulation.
export interface EcoView {
  readonly canvas: HTMLCanvasElement;
  readonly brain: BrainView; // draw the selected creature's brain here
  readonly brainPanel: Card; // skip drawing the brain while collapsed
  readonly graph: PopulationGraph;
  readConfig(): EcoConfig;
  fillConfig(config: EcoConfig): void;
  speed(): EcoSpeedSetting;
  showRays(): boolean;
  setPhase(phase: EcoPhase): void;
  setStats(stats: EcoStats | null): void; // null clears the tiles
  setSelected(selected: EcoSelected | null): void; // null shows only the pick buttons and hides the brain card
  setFollowing(follow: boolean): void;
  setHistory(samples: readonly PopulationSample[]): void;
  setSeasons(eco: EcoConfig["eco"] | null): void; // the graph shades winters; null for none
  setLineages(lineages: readonly Lineage[], population: number): void;
  setLineageHistory(history: Float64Array): void;
  clearLineages(): void;
  setTraits(traits: readonly (readonly TraitHistogram[] | null)[]): void; // body plan histograms per species
  setLeaders(leaders: readonly Leaders[]): void; // the run's records
  clearStatistics(): void; // traits and records, at a new run
  setNote(text: string | null): void;
  showExtinct(simSeconds: number): void;
  hideExtinct(): void;
}

const nf = new Intl.NumberFormat("en-US");

const SPEED_TIP = "Simulated seconds per real second the computer is achieving. It can be lower than the speed asked for.";

// How the run uses the cores, for the speed tooltip.
export function threadsText(helpers: number, wasm = false): string {
  const kernels = wasm ? ", with WebAssembly" : "";
  if (helpers === 0) return `Runs on one thread${kernels}.`;
  return `Runs on ${helpers + 1} threads (${helpers} ${helpers === 1 ? "helper" : "helpers"})${kernels}.`;
}

function setTip(tileId: string, text: string): void {
  const tip = $(tileId).parentElement!.querySelector<HTMLElement>(".tip")!;
  if (tip.dataset.tip === text) return;
  tip.dataset.tip = text;
  tip.setAttribute("aria-label", text);
}

// "birth at 150 · cost 75 · every 10 s": the energy that triggers a birth, what it costs the parent (the child starts with that), the cooldown.
export function formatBirth(b: EcoSelected["birth"]): string {
  return `birth at ${Math.round(b.energy)} · cost ${Math.round(b.cost)} · every ${b.cooldown < 10 ? b.cooldown.toFixed(1) : Math.round(b.cooldown)} s`;
}

// "8 rays · 75° · 100 range · 16 hidden · mem 2+2"; layers join with +, no memory reads "no mem".
export function formatPlan(plan: BodyPlan): string {
  const rays = `${plan.rayCount} ${plan.rayCount === 1 ? "ray" : "rays"}`;
  const mem = plan.memoryShort + plan.memoryLong === 0 ? "no mem" : `mem ${plan.memoryShort}+${plan.memoryLong}`;
  return [rays, `${Math.round((plan.raySpread * 180) / Math.PI)}°`, `${Math.round(plan.rayLength)} range`, `${plan.hiddenLayers.join("+")} hidden`, mem].join(" · ");
}

export function createEcoView(handlers: EcoHandlers, page: ModePage): EcoView {
  const { mode } = page;
  const start = $<HTMLButtonElement>("start");
  const pause = $<HTMLButtonElement>("pause");
  const reset = $<HTMLButtonElement>("reset");
  const setup = $<HTMLFormElement>("setup");
  const follow = $<HTMLButtonElement>("follow");
  const selectedCard = $("selectedCard");
  const brainCard = $("brainCard");
  const extinct = $("extinct");
  const mobile = window.matchMedia("(max-width: 700px)").matches;
  let phase: EcoPhase = "idle";
  let returnFocus: HTMLElement | null = null;
  let hasSelection = false;

  const settingsForm = buildForm($("settings"), page.form);
  const readEcoConfig = settingsForm.read;
  const fillEcoForm = settingsForm.fill;
  fillEcoForm(readEcoConfig());
  settingsForm.init(setup, (c) => { if (phase === "idle") handlers.onConfigChange(c); });
  const session = initRunSession({
    mode,
    container: $("settings"),
    form: setup,
    presets: page.presets,
    locked: page.locked,
    formatScore: durationText,
    read: readEcoConfig,
    fill: fillEcoForm,
    withPreset: (c, id) => withEcoPreset(c, id, page.presets),
  });
  const presets = session.presets;
  // The score is how long the world has lived (page.peak says while it counts), so it counts while the run does and at its end.
  presets.select("normal", false); // the page's first fill is the defaults, which Normal matches
  let founders = ""; // "40 founders" or "2 species", shown with the score
  let peak = 0;
  const beginScoring = (): void => {
    const c = readEcoConfig();
    founders = c.species ? `${c.species.length} species` : `${c.eco.initialPopulation} founders`;
    peak = 0;
    session.begin(c);
  };
  const recordScore = (simTime: number, population: number): void => {
    peak = Math.max(peak, population);
    session.record(Math.floor(simTime), `${founders} · peak ${nf.format(peak)} ${page.peakLabel}`);
  };
  initTooltips($("tooltip"));
  const store = page.store;
  initCard($("legendCard"), `${store}.legend`, mobile);
  initCard(selectedCard, `${store}.selected`, false);
  const brainPanel = initCard(brainCard, `${store}.brain`, mobile);
  initCard($("graphCard"), `${store}.graph`, mobile);
  initCard($("lineageCard"), `${store}.lineage`, mobile);
  initCard($("traitCard"), `${store}.traits`, true);
  initCard($("leaderCard"), `${store}.leaders`, true);
  const speciesNames = page.form.defaults.species?.map((sp) => sp.name) ?? [];
  const traitPanel = new TraitPanel($("traitCard"), speciesNames);
  const leaderPanel = new LeaderPanel($("leaderCard"), speciesNames, page.form.defaults.creature.radius);
  let drain: { id: number; value: number } | null = null; // smoothed, since thrust flickers from tick to tick
  let selectedFounder = -1;
  const lineages = new LineagePanel($("lineageCard"), (f) => { setFounderButton(); handlers.onHighlight(f); });
  const founderBtn = $("selFounder");
  const setFounderButton = (): void => { founderBtn.classList.toggle("on", selectedFounder >= 0 && lineages.highlight() === selectedFounder); };

  const speed = (): EcoSpeedSetting => {
    const v = document.querySelector<HTMLInputElement>('input[name="speed"]:checked')!.value;
    return v === "max" ? "max" : Number(v);
  };

  const setPhase = (p: EcoPhase): void => {
    phase = p;
    const idle = p === "idle";
    renderRunControls({ start, pause, reset, settings: $<HTMLFieldSetElement>("settings"), form: setup }, p === "extinct" ? "running" : p, p !== "extinct");
    selectedCard.hidden = idle;
    brainCard.hidden = idle || !hasSelection;
    extinct.hidden = p !== "extinct";
    if (p !== "extinct" && returnFocus) {
      if (extinct.contains(document.activeElement) || document.activeElement === document.body) returnFocus.focus();
      returnFocus = null;
    }
  };

  const view: EcoView = {
    canvas: $<HTMLCanvasElement>("view"),
    brain: new BrainView($<HTMLCanvasElement>("brainView")),
    brainPanel,
    graph: new PopulationGraph($<HTMLCanvasElement>("graphView")),
    readConfig: readEcoConfig,
    fillConfig: fillEcoForm,
    speed,
    showRays: () => $<HTMLInputElement>("rays").checked,
    setPhase,
    setStats(s) {
      const timer = $("timer");
      timer.hidden = s === null;
      if (s) {
        timer.textContent = durationText(s.simTime);
        const peak = page.peak(s);
        if (peak !== null) recordScore(s.simTime, peak);
      }
      for (const tile of page.tiles) setTile(tile.id, s && tile.value(s), s ? tile.unit?.(s) : undefined);
      $("statSeasonTile").hidden = !s?.season;
      if (s?.season) setTile("statSeason", s.season.name, ` · ${s.season.factor.toFixed(2)}×`);
      if (s) setTip("statSpeed", `${SPEED_TIP} ${threadsText(s.helpers, s.wasm)}`);
    },
    setSelected(sel) {
      hasSelection = sel !== null;
      selectedCard.classList.toggle("has-sel", hasSelection);
      selectedCard.hidden = phase === "idle";
      brainCard.hidden = phase === "idle" || !hasSelection;
      if (!sel) {
        view.setFollowing(false);
        return;
      }
      const frac = Math.min(1, Math.max(0, sel.energy / sel.fullEnergy));
      $("selFill").style.width = `${frac * 100}%`;
      const meter = $("selMeter");
      meter.setAttribute("aria-valuemax", String(Math.round(sel.fullEnergy)));
      meter.setAttribute("aria-valuenow", String(Math.round(sel.energy)));
      $("selEnergy").textContent = sel.died ? "died" : `${Math.round(sel.energy)} / ${Math.round(sel.fullEnergy)}`;
      $("selAge").textContent = durationText(sel.age);
      $("selChildren").textContent = nf.format(sel.children);
      $("selEaten").textContent = nf.format(sel.eaten);
      $("selDepth").textContent = nf.format(sel.depth);
      $("selId").textContent = `#${sel.id}`;
      $("selPlan").textContent = `${formatPlan(sel.plan)} · ${formatBirth(sel.birth)}`;
      drain = drain?.id === sel.id ? { id: sel.id, value: drain.value + 0.25 * (sel.drain - drain.value) } : { id: sel.id, value: sel.drain };
      $("selBase").textContent = sel.upkeep.toFixed(2);
      $("selDrain").textContent = sel.died ? "-" : drain.value.toFixed(2);
      selectedFounder = sel.founderId;
      $("selFounderSw").style.background = lineageColor(sel.founderHue);
      $("selFounderText").textContent = `Founder #${sel.founderId} · ${sel.founderPool ? "trained pool" : "random"}`;
      setFounderButton();
    },
    setFollowing(on) {
      follow.setAttribute("aria-pressed", String(on));
    },
    setHistory: (samples) => view.graph.setData(samples),
    setSeasons: (eco) => view.graph.setSeasons(eco),
    setLineages: (l, population) => lineages.setLineages(l, population),
    setLineageHistory: (h) => lineages.setHistory(h),
    clearLineages: () => lineages.reset(),
    setTraits: (traits) => traitPanel.set(traits),
    setLeaders: (leaders) => leaderPanel.set(leaders),
    clearStatistics() {
      traitPanel.clear();
      leaderPanel.clear();
    },
    setNote(text) {
      $("note").textContent = text ?? "";
    },
    showExtinct(simSeconds) {
      $("extinctTitle").textContent = `Extinct after ${durationText(simSeconds)}`;
      recordScore(simSeconds, 0);
      if (phase !== "extinct") returnFocus = document.activeElement as HTMLElement | null;
      setPhase("extinct");
      $("reseed").focus();
    },
    hideExtinct() {
      if (phase === "extinct") setPhase("running");
    },
  };

  start.onclick = () => { beginScoring(); setPhase("running"); handlers.onStart(readEcoConfig()); };
  pause.onclick = () => {
    const resume = phase === "paused";
    setPhase(resume ? "running" : "paused");
    if (resume) handlers.onResume();
    else handlers.onPause();
  };
  reset.onclick = () => { setPhase("idle"); handlers.onReset(); };
  $("editSettings").onclick = () => {
    setPhase("idle");
    handlers.onReset();
    const settings = $("setup");
    settings.scrollIntoView({ block: "start", behavior: "smooth" });
    settings.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
  };
  $("reseed").onclick = () => { setPhase("running"); handlers.onReseed(); beginScoring(); };
  document.querySelector(".seg")!.addEventListener("change", () => handlers.onSpeed(speed()));
  $<HTMLInputElement>("rays").addEventListener("change", () => handlers.onShowRays(view.showRays()));
  $("zoomIn").onclick = () => handlers.onZoom("in");
  $("zoomOut").onclick = () => handlers.onZoom("out");
  $("zoomFit").onclick = () => handlers.onZoom("fit");
  for (const [id, by] of page.picks) $(id).onclick = () => handlers.onPickBest(by);
  follow.onclick = () => {
    const on = follow.getAttribute("aria-pressed") !== "true";
    view.setFollowing(on);
    handlers.onFollow(on);
  };
  founderBtn.onclick = () => { if (selectedFounder >= 0) lineages.pick(selectedFounder); };
  $("worldView").onclick = () => {
    view.setFollowing(false);
    handlers.onWorldView();
  };
  setPhase("idle");
  return view;
}
