import "./base.css";
import "./landing.css";
import { fitCanvas } from "./ui/canvas.ts";
import { TICK_SECONDS, WARMUP_TICKS, ecosystemScene, liveScene, predatorScene, trialsScene } from "./ui/landingScenes.ts";
import type { Scene } from "./ui/landingScenes.ts";
import { TickClock } from "./ui/tickClock.ts";

const SCENES: Record<string, (seed: number) => Scene> = { trials: trialsScene, ecosystem: ecosystemScene, predators: predatorScene, live: liveScene };
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
