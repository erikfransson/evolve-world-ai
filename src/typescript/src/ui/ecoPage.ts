import { DEFAULT_ECO_CONFIG } from "../sim/ecoConfig.ts";
import type { EcoConfig } from "../sim/ecoConfig.ts";
import { CUSTOM, ECO_LOCKED, ECO_PRESETS, withEcoPreset } from "../sim/presets.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import type { Lineage } from "../sim/ecosystem.ts";
import type { BestBy } from "../worker/ecoProtocol.ts";
import { BrainView } from "./brainView.ts";
import { buildEcoForm, fillEcoForm, initEcoSettingsForm, readEcoConfig } from "./ecoSettingsForm.ts";
import { formatElapsed } from "./elapsed.ts";
import { initCard } from "./overlays.ts";
import type { Card } from "./overlays.ts";
import { initPresetPanel } from "./presetPanel.ts";
import { LineagePanel, lineageColor } from "./lineagePanel.ts";
import { PopulationGraph } from "./populationGraph.ts";
import type { PopulationSample } from "./populationGraph.ts";
import { Scoreboard, settingsOf, today } from "./scoreboard.ts";
import { initSettingsIO } from "./settingsIO.ts";
import { initTooltips } from "./tooltip.ts";

export type EcoSpeed = number | "max"; // simulated seconds per real second asked for, "max" = as fast as possible
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
  onSpeed(speed: EcoSpeed): void;
  onZoom(action: ZoomAction): void;
  onPickBest(by: BestBy): void; // select and follow the best living creature
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
  speed(): EcoSpeed;
  showRays(): boolean;
  setPhase(phase: EcoPhase): void;
  setStats(stats: EcoStats | null): void; // null clears the tiles
  setSelected(selected: EcoSelected | null): void; // null shows only the pick buttons and hides the brain card
  setFollowing(follow: boolean): void;
  setHistory(samples: readonly PopulationSample[]): void;
  setLineages(lineages: readonly Lineage[], population: number): void;
  setLineageHistory(history: Float64Array): void;
  clearLineages(): void;
  setNote(text: string | null): void;
  showExtinct(simSeconds: number): void;
  hideExtinct(): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const nf = new Intl.NumberFormat("en-US");

// Seconds under a minute, then m:ss, then h:mm:ss.
export function formatSimTime(s: number): { text: string; unit: string } {
  if (s < 60) return { text: s.toFixed(1), unit: " s" };
  const t = Math.floor(s);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return { text: h > 0 ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`, unit: "" };
}

function setTile(id: string, value: string | null, unit = ""): void {
  const e = $(id);
  e.textContent = value ?? "-";
  e.dataset.unit = value === null ? "" : unit; // unit is drawn by CSS
}

// "8 rays · 75° · 100 range · 16 hidden · mem 2+2 · upkeep 0.45/s"; layers join with +, no memory reads "no mem".
export function formatPlan(plan: BodyPlan, upkeep: number): string {
  const rays = `${plan.rayCount} ${plan.rayCount === 1 ? "ray" : "rays"}`;
  const mem = plan.memoryShort + plan.memoryLong === 0 ? "no mem" : `mem ${plan.memoryShort}+${plan.memoryLong}`;
  return [rays, `${Math.round((plan.raySpread * 180) / Math.PI)}°`, `${Math.round(plan.rayLength)} range`, `${plan.hiddenLayers.join("+")} hidden`, mem, `upkeep ${upkeep.toFixed(2)}/s`].join(" · ");
}

export function createEcoView(handlers: EcoHandlers): EcoView {
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

  buildEcoForm($("settings"));
  fillEcoForm(readEcoConfig());
  initEcoSettingsForm(setup, (c) => { if (phase === "idle") handlers.onConfigChange(c); });
  const board = new Scoreboard("ecosystem");
  const presets = initPresetPanel({
    container: $("settings"),
    form: setup,
    presets: ECO_PRESETS,
    locked: ECO_LOCKED,
    board,
    formatScore: formatElapsed,
    read: readEcoConfig,
    fill: fillEcoForm,
    withPreset: withEcoPreset,
    setPreset: () => undefined, // every world field has a form input
  });
  initSettingsIO({ mode: "ecosystem", form: setup, read: readEcoConfig, fill: fillEcoForm, preset: { get: presets.current, set: presets.select } });
  // The score is how long the world has lived, so it counts while the run is alive and at its end.
  presets.select("normal", false); // the page's first fill is the defaults, which Normal matches
  const scored = { preset: CUSTOM, key: "", date: "", settings: settingsOf(DEFAULT_ECO_CONFIG), peak: 0 };
  const beginScoring = (): void => {
    const c = readEcoConfig();
    Object.assign(scored, { preset: presets.current(), key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, date: today(), settings: settingsOf(c), peak: 0 });
  };
  const recordScore = (simTime: number, population: number): void => {
    scored.peak = Math.max(scored.peak, population);
    if (scored.preset === CUSTOM) return;
    const note = `peak ${nf.format(scored.peak)} creatures`;
    if (board.submit(scored.preset, { run: scored.key, score: Math.floor(simTime), date: scored.date, settings: scored.settings, note })) presets.refresh();
  };
  initTooltips($("tooltip"));
  initCard($("legendCard"), "evolve.eco.card.legend", mobile);
  initCard(selectedCard, "evolve.eco.card.selected", false);
  const brainPanel = initCard(brainCard, "evolve.eco.card.brain", mobile);
  initCard($("graphCard"), "evolve.eco.card.graph", mobile);
  initCard($("lineageCard"), "evolve.eco.card.lineage", mobile);
  let selectedFounder = -1;
  const lineages = new LineagePanel($("lineageCard"), (f) => { setFounderButton(); handlers.onHighlight(f); });
  const founderBtn = $("selFounder");
  const setFounderButton = (): void => { founderBtn.classList.toggle("on", selectedFounder >= 0 && lineages.highlight() === selectedFounder); };

  const speed = (): EcoSpeed => {
    const v = document.querySelector<HTMLInputElement>('input[name="speed"]:checked')!.value;
    return v === "max" ? "max" : Number(v);
  };

  const setPhase = (p: EcoPhase): void => {
    phase = p;
    const idle = p === "idle";
    start.disabled = !idle;
    pause.disabled = idle || p === "extinct";
    pause.textContent = p === "paused" ? "Resume" : "Pause";
    reset.disabled = idle;
    $<HTMLFieldSetElement>("settings").disabled = !idle;
    setup.classList.toggle("locked", !idle);
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
        timer.textContent = formatElapsed(s.simTime);
        recordScore(s.simTime, s.population);
      }
      setTile("statPop", s && nf.format(s.population));
      setTile("statBirths", s && nf.format(s.births));
      setTile("statDeaths", s && nf.format(s.deaths));
      setTile("statFood", s && nf.format(s.food));
      setTile("statPoison", s && nf.format(s.poison));
      const t = s && formatSimTime(s.simTime);
      setTile("statTime", t && t.text, t?.unit);
      setTile("statDepth", s && nf.format(s.oldestDepth));
      setTile("statSpeed", s && s.speed !== null ? s.speed.toFixed(1) : null, " ×");
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
      const age = formatSimTime(sel.age);
      $("selAge").textContent = age.text + age.unit;
      $("selChildren").textContent = nf.format(sel.children);
      $("selEaten").textContent = nf.format(sel.eaten);
      $("selDepth").textContent = nf.format(sel.depth);
      $("selId").textContent = `#${sel.id}`;
      $("selPlan").textContent = formatPlan(sel.plan, sel.upkeep);
      selectedFounder = sel.founderId;
      $("selFounderSw").style.background = lineageColor(sel.founderHue);
      $("selFounderText").textContent = `Founder #${sel.founderId} · ${sel.founderPool ? "trained pool" : "random"}`;
      setFounderButton();
    },
    setFollowing(on) {
      follow.setAttribute("aria-pressed", String(on));
    },
    setHistory: (samples) => view.graph.setData(samples),
    setLineages: (l, population) => lineages.setLineages(l, population),
    setLineageHistory: (h) => lineages.setHistory(h),
    clearLineages: () => lineages.reset(),
    setNote(text) {
      $("note").textContent = text ?? "";
    },
    showExtinct(simSeconds) {
      $("extinctTitle").textContent = `Extinct after ${Math.round(simSeconds)} s`;
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
  for (const [id, by] of [["pickAge", "age"], ["pickChildren", "children"], ["pickEaten", "eaten"]] as const) $(id).onclick = () => handlers.onPickBest(by);
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
