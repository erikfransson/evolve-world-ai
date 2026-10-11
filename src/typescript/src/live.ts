import "./base.css";
import "./style.css";
import "./ecosystem.css";
import "./live.css";
import { Camera } from "./ui/camera.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { pickCreature } from "./ui/ecoPick.ts";
import { BirthRings } from "./ui/ecoBirths.ts";
import { EcoRenderer } from "./ui/ecoScene.ts";
import type { EcoDrawConfig } from "./ui/ecoScene.ts";
import type { SelectedDetails } from "./worker/ecoProtocol.ts";
import { LiveLink } from "./live/connection.ts";
import type { LinkState } from "./live/connection.ts";
import { LiveScene } from "./live/scene.ts";
import { serverUrl } from "./live/serverUrl.ts";
import type { Hello, Stats } from "./live/protocol.ts";
import { MAX_AGE_S } from "./live/protocol.ts";

// TODO(L6): admin panel. `?admin` opens a second socket to the owner's loopback admin port (ws://127.0.0.1:8788), sends {t:"auth", token}
// with a token the owner pastes in, then {t:"get-config"} and {t:"set-config", changes}. See server/src/admin.ts.

const MAX_CREATURE_PX = 60; // CSS px radius of a creature at the closest zoom
const PICK_RADII = 3; // click reach in creature radii
const PICK_MIN_PX = 14; // click reach never below this many CSS px
const SELECT_RAY_LENGTHS = 3; // follow zoom: this many default ray lengths across the shorter side
const ZOOM_STEP = 1.6;
const UI_INTERVAL_MS = 200;
const RAY_LENGTH = 100;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const chip = $("chip");
const camera = new Camera(1, 1, 1, 1);
const renderer = new EcoRenderer();
const births = new BirthRings();
const scene = new LiveScene();
const url = serverUrl(location.search, import.meta.env.DEV || ["127.0.0.1", "localhost"].includes(location.hostname));

let hello: Hello | null = null;
let draw: EcoDrawConfig | null = null;
let canvasW = 0;
let canvasH = 0;
let selectedId = -1;
let highlight = -1;
let lastUiAt = 0;
let lastStats: Stats | null = null;
let retryTimer: ReturnType<typeof setInterval> | undefined;

const fmt = (n: number): string => n.toLocaleString("en-US");
function fmtDuration(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}

function setChip(state: LinkState, text: string): void {
  chip.dataset.state = state;
  $("chipText").textContent = text;
}

function onState(state: LinkState, retryInS: number): void {
  clearInterval(retryTimer);
  $("offline").hidden = state !== "offline";
  if (state === "connecting") setChip(state, "Connecting");
  else if (state === "full") setChip(state, `The world is full of viewers, trying again in ${retryInS} s`);
  else if (state === "outdated") setChip(state, "Page out of date, reload");
  else if (state === "live") {
    chip.dataset.state = "live";
    renderStats();
  }
  else {
    setChip(state, "World offline");
    let left = retryInS;
    const tick = (): void => {
      $("offlineRetry").textContent = left > 0 ? `Trying again in ${left} s` : "Trying again";
      left = Math.max(0, left - 1);
    };
    tick();
    retryTimer = setInterval(tick, 1000);
    clearSelection();
  }
}

function renderStats(): void {
  const s = lastStats;
  if (s) {
    $("stPop").textContent = fmt(s.population);
    $("stBirths").textContent = fmt(s.births);
    $("stDeaths").textContent = fmt(s.deaths);
    $("stViewers").textContent = fmt(s.viewers);
    $("stSpeed").textContent = `${s.speed.toFixed(s.speed >= 10 ? 0 : 1)}x`;
    $("stUptime").textContent = fmtDuration(s.uptimeS);
  }
  if (chip.dataset.state === "live") setChip("live", s ? `${fmt(s.viewers)} watching · Live · ${fmt(s.population)} creatures · up ${fmtDuration(s.uptimeS)}` : "Live");
}

function onHello(h: Hello): void {
  hello = h;
  scene.reset();
  scene.fullEnergy = h.fullEnergy;
  draw = { worldW: h.world.width, worldH: h.world.height, radius: h.radius, itemRadius: h.itemRadius, species: [{ fullEnergy: h.fullEnergy, hunter: false }], winter: 0 };
  camera.setWorld(h.world.width, h.world.height);
  births.reset();
  clearSelection();
}

function syncCanvas(): number {
  const dpr = fitCanvas(canvas);
  if (canvas.width !== canvasW || canvas.height !== canvasH) {
    canvasW = canvas.width;
    canvasH = canvas.height;
    camera.resize(canvasW, canvasH);
  }
  if (hello) camera.maxZoom = (MAX_CREATURE_PX * dpr) / hello.radius;
  return dpr;
}

function clearSelection(): void {
  selectedId = -1;
  highlight = -1;
  camera.follow(null);
  $("selectedCard").hidden = true;
  $("family").setAttribute("aria-pressed", "false");
}

function select(slot: number): void {
  const v = scene.views;
  selectedId = v.ids[slot]!;
  highlight = -1;
  $("family").setAttribute("aria-pressed", "false");
  $("selectedCard").hidden = false;
  const zoom = Math.min(canvasW, canvasH) / (SELECT_RAY_LENGTHS * RAY_LENGTH);
  camera.cancel();
  camera.animateTo(v.x[slot]!, v.y[slot]!, zoom);
  camera.follow(() => {
    const i = scene.slotOf(selectedId);
    return i >= 0 && selectedId >= 0 ? { x: scene.views.x[i]!, y: scene.views.y[i]! } : null;
  });
}

camera.onClick = (wx, wy) => {
  if (!hello) return;
  const v = scene.views;
  const dpr = window.devicePixelRatio || 1;
  const reach = Math.max(PICK_RADII * hello.radius, (PICK_MIN_PX * dpr) / camera.zoom);
  const i = pickCreature(v.x, v.y, v.count, wx, wy, reach);
  if (i >= 0) select(i);
  else clearSelection();
};

function updateSelectedCard(): void {
  if (selectedId < 0) return;
  const i = scene.slotOf(selectedId);
  if (i < 0) {
    // Died: the camera stops following by itself.
    $("selEnergy").textContent = "died";
    $("selFill").style.width = "0%";
    return;
  }
  const v = scene.views;
  const share = Math.min(1, v.energy[i]! / scene.fullEnergy);
  $("selFill").style.width = `${Math.round(share * 100)}%`;
  $("selMeter").setAttribute("aria-valuenow", String(Math.round(share * 100)));
  $("selEnergy").textContent = `${Math.round(share * 100)}%`;
  $("selAge").textContent = v.age[i]! >= MAX_AGE_S ? `${fmtDuration(MAX_AGE_S)}+` : fmtDuration(v.age[i]!); // the wire caps the age
  $("selId").textContent = String(selectedId);
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dpr = syncCanvas();
  const ctx = canvas.getContext("2d")!;
  camera.update(now);
  if (!draw || !scene.views.count) {
    ctx.fillStyle = "#0b1d16";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const views = scene.sample(now);
  const i = selectedId >= 0 ? scene.slotOf(selectedId) : -1;
  // The renderer only reads alive, x and y of a selection when rays are off.
  const selected = i >= 0 ? ({ alive: true, x: views.x[i]!, y: views.y[i]! } as SelectedDetails) : null;
  renderer.draw(ctx, camera, draw, views, selected, false, dpr, highlight, births, now, null);
  if (now - lastUiAt >= UI_INTERVAL_MS) {
    lastUiAt = now;
    updateSelectedCard();
  }
}

const link = new LiveLink(url, {
  onState,
  onHello,
  onCreatures(f) {
    scene.push(f, performance.now());
    births.observe(scene.views, performance.now());
  },
  onItems: (f) => scene.setItems(f),
  onStats(s) {
    lastStats = s;
    renderStats();
  },
});

camera.attach(canvas);
$("zoomIn").addEventListener("click", () => zoomBy(ZOOM_STEP));
$("zoomOut").addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
$("zoomFit").addEventListener("click", () => {
  clearSelection();
  camera.animateToFit();
});
$("release").addEventListener("click", clearSelection);
$("family").addEventListener("click", () => {
  const i = scene.slotOf(selectedId);
  highlight = highlight >= 0 || i < 0 ? -1 : scene.views.founder[i]!;
  $("family").setAttribute("aria-pressed", String(highlight >= 0));
});

function zoomBy(factor: number): void {
  const g = camera.goal;
  camera.animateTo(g.cx, g.cy, g.zoom * factor);
}

new ResizeObserver(() => syncCanvas()).observe(canvas);
link.start();
requestAnimationFrame(frame);
