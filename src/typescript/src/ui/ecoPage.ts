import type { EcoConfig } from "../sim/ecoConfig.ts";
import { BrainView } from "./brainView.ts";
import { buildEcoForm, fillEcoForm, initEcoSettingsForm, readEcoConfig } from "./ecoSettingsForm.ts";
import { formatElapsed } from "./elapsed.ts";
import { initCard } from "./overlays.ts";
import type { Card } from "./overlays.ts";
import { PopulationGraph } from "./populationGraph.ts";
import type { PopulationSample } from "./populationGraph.ts";
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
  depth: number; // lineage depth, founders are 0
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
  onFollow(follow: boolean): void; // the Follow toggle
  onWorldView(): void; // the World view button; the page has already cleared the Follow toggle
  onShowRays(show: boolean): void;
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
  setSelected(selected: EcoSelected | null): void; // null hides the selected and brain cards
  setFollowing(follow: boolean): void;
  setHistory(samples: readonly PopulationSample[]): void;
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

  buildEcoForm($("settings"));
  fillEcoForm(readEcoConfig());
  initEcoSettingsForm(setup, (c) => { if (phase === "idle") handlers.onConfigChange(c); });
  initSettingsIO({ mode: "ecosystem", form: setup, read: readEcoConfig, fill: fillEcoForm });
  initTooltips($("tooltip"));
  initCard($("legendCard"), "evolve.eco.card.legend", mobile);
  initCard(selectedCard, "evolve.eco.card.selected", false);
  const brainPanel = initCard(brainCard, "evolve.eco.card.brain", mobile);
  initCard($("graphCard"), "evolve.eco.card.graph", mobile);

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
      if (s) timer.textContent = formatElapsed(s.simTime);
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
      selectedCard.hidden = brainCard.hidden = sel === null;
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
      $("selDepth").textContent = nf.format(sel.depth);
      $("selId").textContent = `#${sel.id}`;
    },
    setFollowing(on) {
      follow.setAttribute("aria-pressed", String(on));
    },
    setHistory: (samples) => view.graph.setData(samples),
    setNote(text) {
      $("note").textContent = text ?? "";
    },
    showExtinct(simSeconds) {
      $("extinctTitle").textContent = `Extinct after ${Math.round(simSeconds)} s`;
      if (phase !== "extinct") returnFocus = document.activeElement as HTMLElement | null;
      setPhase("extinct");
      $("reseed").focus();
    },
    hideExtinct() {
      if (phase === "extinct") setPhase("running");
    },
  };

  start.onclick = () => { setPhase("running"); handlers.onStart(readEcoConfig()); };
  pause.onclick = () => {
    const resume = phase === "paused";
    setPhase(resume ? "running" : "paused");
    if (resume) handlers.onResume();
    else handlers.onPause();
  };
  reset.onclick = () => { setPhase("idle"); handlers.onReset(); };
  $("reseed").onclick = () => { setPhase("running"); handlers.onReseed(); };
  document.querySelector(".seg")!.addEventListener("change", () => handlers.onSpeed(speed()));
  $<HTMLInputElement>("rays").addEventListener("change", () => handlers.onShowRays(view.showRays()));
  $("zoomIn").onclick = () => handlers.onZoom("in");
  $("zoomOut").onclick = () => handlers.onZoom("out");
  $("zoomFit").onclick = () => handlers.onZoom("fit");
  follow.onclick = () => {
    const on = follow.getAttribute("aria-pressed") !== "true";
    view.setFollowing(on);
    handlers.onFollow(on);
  };
  $("worldView").onclick = () => {
    view.setFollowing(false);
    handlers.onWorldView();
  };
  setPhase("idle");
  return view;
}
