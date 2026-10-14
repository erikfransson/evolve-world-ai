import "./base.css";
import "./landing.css";
import { fitCanvas } from "./ui/canvas.ts";
import { TICK_SECONDS, WARMUP_TICKS, arenaScene, ecosystemScene, inlandMapScene, trialsScene } from "./ui/landing/index.ts";
import type { MapScene, Scene } from "./ui/landing/index.ts";
import inlandSea from "./ui/landing/inland-sea.webp";
import { fetchStats, statsText, statsUrl } from "./ui/landing/liveStats.ts";
import { TickClock } from "./ui/tickClock.ts";
import { serverUrl } from "./live/serverUrl.ts";
import { VERSION } from "./version.ts";

const SCENES: Record<string, (seed: number) => Scene> = { trials: trialsScene, ecosystem: ecosystemScene, arena: arenaScene, live: inlandMapScene };
document.getElementById("version")!.textContent = `Evolve World v${VERSION}`;

// The Live World card's numbers, once per visit; the line stays hidden when the server does not answer.
const statsLine = document.getElementById("liveStats")!;
const local = import.meta.env.DEV || ["127.0.0.1", "localhost"].includes(location.hostname);
void fetchStats(statsUrl(serverUrl(location.search, local))).then((s) => {
  if (!s) return;
  statsLine.textContent = statsText(s);
  statsLine.hidden = false;
});

const SPEED = 1.5; // times real time
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

interface Card {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  scene: Scene;
  visible: boolean;
}

const cards: Card[] = [];
for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas[data-scene]")) {
  const make = SCENES[canvas.dataset.scene!];
  if (!make) continue;
  const card: Card = { ctx: canvas.getContext("2d")!, canvas, scene: make(7), visible: false };
  for (let i = 0; i < WARMUP_TICKS; i++) card.scene.step(); // start mid-action
  cards.push(card);
}

// The Live World card's map picture; the card draws plain ground until it has loaded.
const mapCard = cards.find((c) => c.canvas.dataset.scene === "live");
if (mapCard) {
  const img = new Image();
  img.src = inlandSea;
  img.decode().then(
    () => {
      (mapCard.scene as MapScene).background = img;
      if (mapCard.visible) drawCard(mapCard);
    },
    () => {},
  );
}

const drawCard = (c: Card): void => {
  fitCanvas(c.canvas);
  c.scene.draw(c.ctx);
};

const clock = new TickClock(0);
let raf = 0;

function frame(now: number): void {
  raf = 0;
  const ticks = clock.advance(now, SPEED / TICK_SECONDS);
  for (const c of cards) {
    if (!c.visible) continue;
    for (let i = 0; i < ticks; i++) c.scene.step();
    drawCard(c);
  }
  schedule(true);
}

// Runs only while motion is allowed and some card is on screen; a restart drops the time spent stopped.
function schedule(continuing = false): void {
  if (raf || reducedMotion.matches || document.hidden || !cards.some((c) => c.visible)) return;
  if (!continuing) clock.reset(performance.now());
  raf = requestAnimationFrame(frame);
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const card = cards.find((c) => c.canvas === e.target)!;
    card.visible = e.isIntersecting;
    if (e.isIntersecting) drawCard(card);
  }
  schedule();
});
const resizer = new ResizeObserver((entries) => {
  for (const e of entries) drawCard(cards.find((c) => c.canvas === e.target)!);
});
for (const c of cards) {
  observer.observe(c.canvas);
  resizer.observe(c.canvas);
}
document.addEventListener("visibilitychange", () => schedule());
reducedMotion.addEventListener("change", () => schedule());
