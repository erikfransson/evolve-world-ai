import "./base.css";
import "./landing.css";
import { fitCanvas } from "./ui/canvas.ts";
import { TICK_SECONDS, ecosystemScene, liveScene, trialsScene } from "./ui/landingScenes.ts";
import type { Scene } from "./ui/landingScenes.ts";

const SCENES: Record<string, (seed: number) => Scene> = { trials: trialsScene, ecosystem: ecosystemScene, live: liveScene };
const SPEED = 1.5; // times real time
const WARMUP_TICKS = 150;
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

let last = 0;
let debt = 0;
let raf = 0;

function frame(now: number): void {
  raf = 0;
  debt += Math.min(0.25, (now - last) / 1000) * SPEED / TICK_SECONDS; // long gaps (hidden tab) are capped
  last = now;
  const ticks = Math.floor(debt);
  debt -= ticks;
  for (const c of cards) {
    if (!c.visible) continue;
    for (let i = 0; i < ticks; i++) c.scene.step();
    drawCard(c);
  }
  schedule();
}

// Runs only while motion is allowed and some card is on screen.
function schedule(): void {
  if (raf || reducedMotion.matches || document.hidden || !cards.some((c) => c.visible)) return;
  last = performance.now();
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
document.addEventListener("visibilitychange", schedule);
reducedMotion.addEventListener("change", schedule);
