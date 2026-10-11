import type { EcoConfig } from "../sim/ecoConfig.ts";
import { CUSTOM, withEcoPreset } from "../sim/presets.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import type { Lineage, SpeciesCount } from "../sim/ecosystem.ts";
import type { BestBy } from "../worker/ecoProtocol.ts";
import { BrainView } from "./brainView.ts";
import type { ModePage } from "./ecoModes.ts";
import { buildForm } from "./settingsForm.ts";
import { initCard } from "./overlays.ts";
import type { Card } from "./overlays.ts";
import { initPresetPanel } from "./presetPanel.ts";
import { LineagePanel, lineageColor } from "./lineagePanel.ts";
import { PopulationGraph } from "./populationGraph.ts";
import type { PopulationSample } from "./populationGraph.ts";
import { Scoreboard, settingsOf, today } from "./scoreboard.ts";
import { initSettingsIO } from "./settingsIO.ts";
import { $, durationText, setTile } from "./page.ts";
import { initTooltips } from "./tooltip.ts";
import { LINEAGE_STRIDE } from "../worker/ecoProtocol.ts";

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
  helpers: number; // helper threads sensing and thinking, 0 when the simulation runs on one thread
  sharedMemory: boolean;
  wasm: boolean; // sense and think run on the WebAssembly kernels
  species?: readonly SpeciesCount[]; // with several species
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
  founderId: number;
  founderPool: boolean; // the founder came from the seed pool
  founderHue: number;
  species?: { name: string; index: number; kills: number; hunter: boolean }; // with several species
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
  setSeasons(eco: EcoConfig["eco"] | null): void; // the graph shades winters; null for none
  setLineages(lineages: readonly Lineage[], population: number, speciesCounts?: readonly number[]): void; // speciesCounts with several species
  setLineageHistory(history: Float64Array): void;
  clearLineages(): void;
  setNote(text: string | null): void;
  showExtinct(simSeconds: number): void;
  hideExtinct(): void;
}

const nf = new Intl.NumberFormat("en-US");

const SPEED_TIP = "Simulated seconds per real second the computer is achieving. It can be lower than the speed asked for.";

// How the run uses the cores, for the speed tooltip.
export function threadsText(helpers: number, shared: boolean, wasm = false): string {
  const kernels = wasm ? ", with WebAssembly" : "";
  if (helpers === 0) return `Runs on one thread${kernels}.`;
  return `Runs on ${helpers + 1} threads (${helpers} ${helpers === 1 ? "helper" : "helpers"}), ${shared ? "in shared memory" : "by messages"}${kernels}.`;
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

// "8 rays · 75° · 100 range · 16 hidden · mem 2+2 · upkeep 0.45/s"; layers join with +, no memory reads "no mem".
export function formatPlan(plan: BodyPlan, upkeep: number): string {
  const rays = `${plan.rayCount} ${plan.rayCount === 1 ? "ray" : "rays"}`;
  const mem = plan.memoryShort + plan.memoryLong === 0 ? "no mem" : `mem ${plan.memoryShort}+${plan.memoryLong}`;
  return [rays, `${Math.round((plan.raySpread * 180) / Math.PI)}°`, `${Math.round(plan.rayLength)} range`, `${plan.hiddenLayers.join("+")} hidden`, mem, `upkeep ${upkeep.toFixed(2)}/s`].join(" · ");
}

export function createEcoView(handlers: EcoHandlers, page: ModePage): EcoView {
  const { mode, speciesColors } = page;
  const several = speciesColors.length > 1;
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
  const board = new Scoreboard(mode);
  const presets = initPresetPanel({
    container: $("settings"),
    form: setup,
    presets: page.presets,
    locked: page.locked,
    board,
    formatScore: durationText,
    read: readEcoConfig,
    fill: fillEcoForm,
    withPreset: (c, id) => withEcoPreset(c, id, page.presets),
  });
  initSettingsIO({ mode, form: setup, read: readEcoConfig, fill: fillEcoForm, preset: { get: presets.current, set: presets.select } });
  // The score is how long the world has lived (page.peak says while it counts), so it counts while the run does and at its end.
  presets.select("normal", false); // the page's first fill is the defaults, which Normal matches
  const scored = { preset: CUSTOM, key: "", date: "", settings: settingsOf(page.form.defaults), peak: 0 };
  const beginScoring = (): void => {
    const c = readEcoConfig();
    Object.assign(scored, { preset: presets.current(), key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, date: today(), settings: settingsOf(c), peak: 0 });
  };
  const recordScore = (simTime: number, population: number): void => {
    scored.peak = Math.max(scored.peak, population);
    if (scored.preset === CUSTOM) return;
    const note = `peak ${nf.format(scored.peak)} ${page.peakLabel}`;
    if (board.submit(scored.preset, { run: scored.key, score: Math.floor(simTime), date: scored.date, settings: scored.settings, note })) presets.refresh();
  };
  initTooltips($("tooltip"));
  const store = page.store;
  initCard($("legendCard"), `${store}.legend`, mobile);
  initCard(selectedCard, `${store}.selected`, false);
  const brainPanel = initCard(brainCard, `${store}.brain`, mobile);
  initCard($("graphCard"), `${store}.graph`, mobile);
  initCard($("lineageCard"), `${store}.lineage`, mobile);
  let selectedFounder = -1;
  const lineages = new LineagePanel($("lineageCard"), (f) => { setFounderButton(); handlers.onHighlight(f); });
  // With several species the Lineages card shows one species at a time, picked by the switch in its header.
  let lineageSpecies = 0;
  let lastLineages: { list: readonly Lineage[]; counts: readonly number[] } | null = null;
  let lastLineageHistory: Float64Array | null = null;
  const speciesBlock = (h: Float64Array, s: number, blocks: number): Float64Array => {
    const out = new Float64Array(h.length / blocks);
    for (let i = 0, o = 0; i < h.length; i += LINEAGE_STRIDE * blocks, o += LINEAGE_STRIDE) out.set(h.subarray(i + s * LINEAGE_STRIDE, i + (s + 1) * LINEAGE_STRIDE), o);
    return out;
  };
  const showLineages = (): void => {
    if (lastLineages) lineages.setLineages(lastLineages.list.filter((l) => l.species === lineageSpecies), lastLineages.counts[lineageSpecies] ?? 0);
    if (lastLineageHistory) lineages.setHistory(speciesBlock(lastLineageHistory, lineageSpecies, speciesColors.length));
  };
  document.querySelectorAll<HTMLInputElement>('input[name="linSpecies"]').forEach((input) => {
    input.addEventListener("change", () => {
      lineageSpecies = Number(input.value);
      if (lineages.highlight() !== null) lineages.pick(null);
      showLineages();
    });
  });
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
    graph: new PopulationGraph($<HTMLCanvasElement>("graphView"), speciesColors),
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
      if (s) setTip("statSpeed", `${SPEED_TIP} ${threadsText(s.helpers, s.sharedMemory, s.wasm)}`);
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
      $("selEaten").textContent = nf.format(sel.species?.hunter ? sel.species.kills : sel.eaten);
      if (sel.species) {
        const tag = $("selSpecies");
        tag.textContent = sel.species.name;
        tag.style.setProperty("--sp", speciesColors[sel.species.index] ?? "currentColor");
        $("selEatenLabel").textContent = sel.species.hunter ? "Prey eaten" : "Plants eaten";
      }
      $("selDepth").textContent = nf.format(sel.depth);
      $("selId").textContent = `#${sel.id}`;
      $("selPlan").textContent = `${formatPlan(sel.plan, sel.upkeep)} · ${formatBirth(sel.birth)}`;
      selectedFounder = sel.founderId;
      $("selFounderSw").style.background = lineageColor(sel.founderHue);
      $("selFounderText").textContent = `Founder #${sel.founderId} · ${sel.founderPool ? "trained pool" : "random"}`;
      if (several && sel.species && sel.species.index !== lineageSpecies) {
        // The founder button highlights a lineage of the species on show.
        const radio = document.querySelector<HTMLInputElement>(`input[name="linSpecies"][value="${sel.species.index}"]`);
        if (radio) {
          radio.checked = true;
          lineageSpecies = sel.species.index;
          showLineages();
        }
      }
      setFounderButton();
    },
    setFollowing(on) {
      follow.setAttribute("aria-pressed", String(on));
    },
    setHistory: (samples) => view.graph.setData(samples),
    setSeasons: (eco) => view.graph.setSeasons(eco),
    setLineages(l, population, counts) {
      if (!counts) return lineages.setLineages(l, population);
      lastLineages = { list: l, counts };
      showLineages();
    },
    setLineageHistory(h) {
      if (!several) return lineages.setHistory(h);
      lastLineageHistory = h;
      showLineages();
    },
    clearLineages() {
      lastLineages = null;
      lastLineageHistory = null;
      lineages.reset();
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
