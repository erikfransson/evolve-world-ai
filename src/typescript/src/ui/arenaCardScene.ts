import { createRng } from "../sim/rng.ts";
import { BACKGROUND, FOOD, OTHER, POISON, WALL, beginFrame } from "./scene.ts";
import { TICK_SECONDS, clamp, drawBirthRings, drawBursts, drawColoured, sceneConfig, wrapAngle } from "./landingScenes.ts";
import type { Effect, Scene } from "./landingScenes.ts";

// RL Arena card: the same gold learner in four small training boxes. It starts clumsy and gets better over a loop,
// and every good move pays out a "+1", a ring and a pulse.
const W = 360; // world units, as the Live card
const H = 225;
const GAP = 6;
const BOX_W = (W - 3 * GAP) / 2;
const BOX_H = (H - 3 * GAP) / 2;
const PAD = 11; // keeps bodies off the walls
const TOP = 24; // and off the header
const R = 6; // learner radius
const PREY_R = 4.2;
const ITEM_R = 3.5;
const GOLD = 43; // hue of the Arena's learner, #fbbf24
const RIVAL_HUE = 199; // as OTHER
const LOOP_TICKS = Math.round(70 / TICK_SECONDS);
const WINDOW_TICKS = Math.round(3 / TICK_SECONDS); // one bar of the reward history
const BARS = 12;
const FLOAT_SECONDS = 1.1;
const PULSE_SECONDS = 0.4;
const FLICKER_SECONDS = 0.5;
const GROW_SECONDS = 0.45;
const RAY_LENGTH = 30;
const RAY_OFFSETS = [-0.9, -0.45, 0, 0.45, 0.9];
const RAY_NONE = "#9db3a8";
const RAY_WALL = "#facc15";
const ticksOf = (seconds: number): number => Math.round(seconds / TICK_SECONDS);

type Mode = "forage" | "dodge" | "duel" | "chase";
interface Point { x: number; y: number }
interface Agent { x: number; y: number; heading: number }
interface Item { x: number; y: number; born: number }
interface Floater { at: number; x: number; y: number; good: boolean }

interface Box {
  mode: Mode;
  label: string;
  x0: number;
  y0: number;
  learner: Agent;
  other: Agent; // the duel rival or the prey
  otherAt: number; // tick the prey is (re)born
  food: Item[];
  poison: Item[];
  phase: number; // offsets the clumsy wobble so the boxes do not move in step
  gainAt: number; // tick of the last reward and of the last penalty
  hitAt: number;
  rings: Effect[];
  bursts: Effect[];
  floaters: Floater[];
  window: number; // reward collected in the current bar
  history: number[];
  score: [number, number]; // duel: learner, rival
}

const MODES: [Mode, string, number, number][] = [
  ["forage", "Forage", 0, 0],
  ["dodge", "Dodge", 1, 0],
  ["duel", "Duel", 0, 1],
  ["chase", "Chase", 1, 1],
];

export interface ArenaScene extends Scene {
  rewards: number; // pluses since the start
  penalties: number;
  poisonOverlaps(): number; // poison touching a learner; a touch is a penalty and removes the poison in the same tick
}

export function arenaScene(seed: number): ArenaScene {
  const config = sceneConfig(W, H, 0, { radius: R });
  const rng = createRng(seed);
  let tick = 0;
  let rewards = 0;
  let penalties = 0;

  // A fresh item away from the learner, the rival, the poison and the other food.
  function spawn(b: Box, far = 40): Item {
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 10; tries++) {
      x = b.x0 + PAD + rng.range(0, BOX_W - 2 * PAD);
      y = b.y0 + TOP + rng.range(0, BOX_H - TOP - PAD);
      const clear = (a: { x: number; y: number }, d: number): boolean => (a.x - x) ** 2 + (a.y - y) ** 2 > d * d;
      if (clear(b.learner, far) && (b.mode !== "duel" || clear(b.other, 30)) && b.poison.every((p) => clear(p, 22)) && b.food.every((f) => clear(f, 20))) break;
    }
    return { x, y, born: tick };
  }

  const boxes: Box[] = MODES.map(([mode, label, cx, cy], k) => {
    const x0 = GAP + cx * (BOX_W + GAP);
    const y0 = GAP + cy * (BOX_H + GAP);
    const b: Box = {
      mode, label, x0, y0,
      learner: { x: x0 + BOX_W / 2, y: y0 + BOX_H / 2 + 8, heading: rng.range(0, 2 * Math.PI) },
      other: { x: x0 + BOX_W * 0.8, y: y0 + BOX_H * 0.3, heading: rng.range(0, 2 * Math.PI) },
      otherAt: 0, food: [], poison: [], phase: k * 1.7, gainAt: -1e9, hitAt: -1e9,
      rings: [], bursts: [], floaters: [], window: 0, history: [], score: [0, 0],
    };
    const foods = mode === "duel" ? 3 : mode === "dodge" ? 2 : mode === "forage" ? 4 : 0;
    for (let i = 0; i < foods; i++) b.food.push(spawn(b, 30));
    for (let i = 0; i < (mode === "dodge" ? 3 : 0); i++) b.poison.push(spawn(b, 30));
    return b;
  });

  const ring = (b: Box, x: number, y: number, hue: number): void => { b.rings.push({ at: tick, x, y, hue }); };
  const gain = (b: Box, x: number, y: number): void => {
    ring(b, x, y, GOLD);
    b.floaters.push({ at: tick, x, y, good: true });
    b.gainAt = tick;
    b.window++;
    rewards++;
  };
  const penalise = (b: Box, x: number, y: number): void => {
    ring(b, x, y, 0);
    b.floaters.push({ at: tick, x, y, good: false });
    b.hitAt = tick;
    b.window--;
    penalties++;
  };

  // Turn-limited steering toward the direction (dx, dy), with a wobble that fades as the learner gets skilled.
  function drive(b: Box, a: Agent, dx: number, dy: number, vMax: number, skill: number, wobble: number): void {
    const err = wrapAngle(Math.atan2(dy, dx) - a.heading);
    a.heading += clamp(err, -4 * TICK_SECONDS, 4 * TICK_SECONDS) + wobble * (1 - skill) * Math.sin(tick * 0.09 + b.phase) * TICK_SECONDS;
    const v = vMax * (0.4 + 0.6 * Math.max(0, Math.cos(err)));
    a.x = clamp(a.x + Math.cos(a.heading) * v * TICK_SECONDS, b.x0 + PAD - 3, b.x0 + BOX_W - PAD + 3);
    a.y = clamp(a.y + Math.sin(a.heading) * v * TICK_SECONDS, b.y0 + TOP - 3, b.y0 + BOX_H - PAD + 3);
  }

  // Direction toward a point, pushed off the walls and sidestepping any poison in the way.
  function aim(b: Box, a: Agent, tx: number, ty: number, avoid: Item[], strength: number): [number, number] {
    let dx = tx - a.x;
    let dy = ty - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const reach = 34;
    for (const p of avoid) {
      const px = a.x - p.x;
      const py = a.y - p.y;
      const d = Math.hypot(px, py) || 1;
      if (d > reach) continue;
      const w = strength * (((reach - d) / reach) ** 1.5 + 2 * Math.max(0, (18 - d) / 18)); // a hard shove when it gets close
      const side = dx * py - dy * px > 0 ? 1 : -1; // slip past on the side already ahead
      dx += w * ((px / d) * 0.6 - side * (py / d) * 0.9);
      dy += w * ((py / d) * 0.6 + side * (px / d) * 0.9);
    }
    const m = 16;
    dx += (clamp((b.x0 + m - a.x) / m, 0, 1) - clamp((a.x - (b.x0 + BOX_W - m)) / m, 0, 1)) * 1.5;
    dy += (clamp((b.y0 + TOP + 4 - a.y) / m, 0, 1) - clamp((a.y - (b.y0 + BOX_H - m)) / m, 0, 1)) * 1.5;
    return [dx, dy];
  }

  const nearest = (items: Item[], a: Agent): Item => {
    let best = items[0]!;
    let bestD = Infinity;
    for (const it of items) {
      const d = (it.x - a.x) ** 2 + (it.y - a.y) ** 2;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  };
  const touches = (it: Point, a: Point, r: number): boolean => (it.x - a.x) ** 2 + (it.y - a.y) ** 2 < r * r;

  function stepChase(b: Box, skill: number): void {
    const L = b.learner;
    const prey = b.other;
    if (tick === b.otherAt) { // a new prey is born away from the learner
      prey.x = b.x0 + PAD + rng.range(0, BOX_W - 2 * PAD);
      prey.y = b.y0 + TOP + rng.range(0, BOX_H - TOP - PAD);
      if (Math.hypot(prey.x - L.x, prey.y - L.y) < 50) { prey.x = 2 * b.x0 + BOX_W - L.x; prey.y = Math.max(b.y0 + TOP, 2 * b.y0 + BOX_H - L.y); }
      ring(b, prey.x, prey.y, RIVAL_HUE);
    }
    if (tick < b.otherAt) {
      drive(b, L, b.x0 + BOX_W / 2 - L.x, b.y0 + BOX_H / 2 - L.y, 18, skill, 0);
      return;
    }
    const [dx, dy] = aim(b, L, prey.x, prey.y, [], 0);
    drive(b, L, dx, dy, 14 + 30 * skill, skill, 4);
    const d = Math.hypot(prey.x - L.x, prey.y - L.y);
    if (d < R + PREY_R) {
      b.bursts.push({ at: tick, x: prey.x, y: prey.y, hue: RIVAL_HUE });
      gain(b, L.x, L.y);
      b.otherAt = tick + ticksOf(1.1);
      return;
    }
    // The prey wanders, bolts from the learner when it is close and slips along walls rather than into corners.
    const flee = d < 55;
    let fx = Math.cos(prey.heading) * 0.4;
    let fy = Math.sin(prey.heading) * 0.4;
    if (flee) {
      const ux = (prey.x - L.x) / d;
      const uy = (prey.y - L.y) / d;
      const side = Math.cos(prey.heading) * uy - Math.sin(prey.heading) * ux > 0 ? -1 : 1;
      fx = ux - side * uy * 0.6;
      fy = uy + side * ux * 0.6;
    }
    const [wx, wy] = aim(b, prey, prey.x + fx * 30, prey.y + fy * 30, [], 0);
    drive(b, prey, wx, wy, flee ? 24 : 14, 1, 0);
    if (!flee) prey.heading += Math.sin(tick * 0.05 + b.phase * 3) * 0.7 * TICK_SECONDS;
  }

  function stepFood(b: Box, skill: number): void {
    const L = b.learner;
    const target = nearest(b.food, L);
    const [dx, dy] = aim(b, L, target.x, target.y, b.poison, 1 + 2.4 * skill * skill);
    drive(b, L, dx, dy, 14 + 30 * skill, skill, 4);
    if (b.mode === "duel") {
      const O = b.other;
      const t = nearest(b.food, O);
      const [ox, oy] = aim(b, O, t.x, t.y, [], 0);
      drive(b, O, ox, oy, 29, 1, 0);
      const sx = O.x - L.x;
      const sy = O.y - L.y;
      const sd = Math.hypot(sx, sy);
      if (sd < 2 * R && sd > 0) { // the bodies never overlap
        const push = (2 * R - sd) / 2;
        O.x += (sx / sd) * push;
        O.y += (sy / sd) * push;
        L.x -= (sx / sd) * push;
        L.y -= (sy / sd) * push;
      }
      for (const it of b.food) {
        if (!touches(it, O, R + ITEM_R)) continue;
        ring(b, O.x, O.y, RIVAL_HUE);
        b.score[1]++;
        Object.assign(it, spawn(b));
      }
    }
    for (const it of b.food) {
      if (!touches(it, L, R + ITEM_R)) continue;
      gain(b, L.x, L.y);
      b.score[0]++;
      Object.assign(it, spawn(b));
      if (b.poison.length && b.score[0] % 2 === 0) Object.assign(b.poison[(b.score[0] / 2) % b.poison.length]!, spawn(b));
    }
    for (const p of b.poison) {
      if (!touches(p, L, R + ITEM_R)) continue;
      penalise(b, L.x, L.y);
      Object.assign(p, spawn(b));
    }
  }

  return {
    get rewards() { return rewards; },
    get penalties() { return penalties; },
    poisonOverlaps() {
      let n = 0;
      for (const b of boxes) for (const p of b.poison) if (touches(p, b.learner, R + ITEM_R)) n++;
      return n;
    },
    step() {
      tick++;
      const p = (tick % LOOP_TICKS) / LOOP_TICKS;
      const skill = 0.3 + 0.7 * (1 - (1 - p) ** 2);
      for (const b of boxes) {
        if (tick % LOOP_TICKS === 0) { b.history.length = 0; b.window = 0; b.score = [0, 0]; }
        if (b.mode === "chase") stepChase(b, skill);
        else stepFood(b, skill);
        if (tick % WINDOW_TICKS === 0) {
          b.history.push(b.window);
          if (b.history.length > BARS) b.history.shift();
          b.window = 0;
        }
      }
    },
    draw(ctx) {
      const f = beginFrame(ctx, config);
      const { clientWidth, width } = ctx.canvas;
      const css = (clientWidth > 0 ? width / clientWidth : 1) * f.px; // one CSS pixel in world units
      for (const b of boxes) drawBox(ctx, b, f.px, css);
    },
  };

  function drawBox(ctx: CanvasRenderingContext2D, b: Box, px: number, css: number): void {
    ctx.fillStyle = "rgba(4, 14, 10, 0.4)";
    ctx.fillRect(b.x0, b.y0, BOX_W, BOX_H);
    ctx.strokeStyle = WALL;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = px;
    ctx.strokeRect(b.x0, b.y0, BOX_W, BOX_H);
    ctx.globalAlpha = 1;
    drawHeader(ctx, b, css);

    const grow = (it: Item): number => Math.min(1, ((tick - it.born) * TICK_SECONDS) / GROW_SECONDS);
    for (const [items, color] of [[b.food, FOOD], [b.poison, POISON]] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const it of items) {
        const r = ITEM_R * (1 - (1 - grow(it)) ** 2);
        ctx.moveTo(it.x + r, it.y);
        ctx.arc(it.x, it.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    drawRays(ctx, b, px);

    if (b.mode === "duel") drawColoured(ctx, px, b.other, R, RIVAL_HUE);
    if (b.mode === "chase" && tick >= b.otherAt) drawColoured(ctx, px, b.other, PREY_R * Math.min(1, ((tick - b.otherAt) * TICK_SECONDS) / GROW_SECONDS), RIVAL_HUE);

    // The learner pulses when it scores and flickers red when it eats poison.
    const L = b.learner;
    const since = (tick - b.gainAt) * TICK_SECONDS;
    const pulse = since < PULSE_SECONDS ? (1 - since / PULSE_SECONDS) ** 2 : 0;
    if (pulse > 0) {
      ctx.fillStyle = `hsl(${GOLD}, 95%, 60%)`;
      ctx.globalAlpha = 0.28 * pulse;
      ctx.beginPath();
      ctx.arc(L.x, L.y, R * (1.6 + 0.8 * (1 - pulse)), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    drawColoured(ctx, px, L, R * (1 + 0.22 * pulse), GOLD);
    const hit = (tick - b.hitAt) * TICK_SECONDS;
    if (hit < FLICKER_SECONDS && Math.floor(hit / 0.09) % 2 === 0) {
      ctx.fillStyle = "#ef4444";
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(L.x, L.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    drawBursts(ctx, px, b.bursts, tick, PREY_R);
    drawBirthRings(ctx, px, b.rings, tick, R * 0.75);
    drawFloaters(ctx, b, px, css);
  }

  // Label with a dot in the colour of what the box is about, the duel score and the reward history as small bars.
  function drawHeader(ctx: CanvasRenderingContext2D, b: Box, css: number): void {
    const y = b.y0 + 8;
    ctx.fillStyle = b.mode === "dodge" ? POISON : b.mode === "forage" ? FOOD : OTHER;
    ctx.beginPath();
    ctx.arc(b.x0 + 8, y, 2.2 * css, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 ${8.5 * css}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(238, 245, 241, 0.72)";
    ctx.fillText(b.label.toUpperCase(), b.x0 + 8 + 5 * css, y);
    const barW = 2 * css;
    const barH = 13 * css;
    const left = b.x0 + BOX_W - 7 - BARS * (barW + css);
    if (b.mode === "duel") {
      const cx = left - 20 * css;
      ctx.textAlign = "right";
      ctx.fillStyle = `hsl(${GOLD}, 90%, 66%)`;
      ctx.fillText(`${b.score[0]}`, cx - 3 * css, y);
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(238, 245, 241, 0.5)";
      ctx.fillText(":", cx, y);
      ctx.textAlign = "left";
      ctx.fillStyle = `hsl(${RIVAL_HUE}, 80%, 70%)`;
      ctx.fillText(`${b.score[1]}`, cx + 3 * css, y);
    }
    ctx.fillStyle = `hsl(${GOLD}, 90%, 62%)`;
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < b.history.length; i++) {
      const v = clamp(b.history[i]! / (b.mode === "chase" ? 2 : 4), 0.1, 1);
      ctx.fillRect(left + (i + BARS - b.history.length) * (barW + css), b.y0 + 3 + barH * (1 - v), barW, barH * v);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters(ctx: CanvasRenderingContext2D, b: Box, px: number, css: number): void {
    while (b.floaters.length && (tick - b.floaters[0]!.at) * TICK_SECONDS >= FLOAT_SECONDS) b.floaters.shift();
    ctx.font = `700 ${12 * css}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * px;
    for (const e of b.floaters) {
      const t = ((tick - e.at) * TICK_SECONDS) / FLOAT_SECONDS;
      const x = clamp(e.x, b.x0 + 10, b.x0 + BOX_W - 10);
      const y = Math.max(b.y0 + 22, e.y - R - 5 - 20 * (1 - (1 - t) ** 2));
      ctx.globalAlpha = Math.min(1, t / 0.12) * (1 - t) ** 1.4;
      ctx.strokeStyle = BACKGROUND;
      ctx.fillStyle = e.good ? `hsl(${GOLD}, 100%, 68%)` : "#f87171";
      const text = e.good ? "+1" : "−1";
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  // Five rays from the learner, coloured by what they meet, as on the Trials card.
  function drawRays(ctx: CanvasRenderingContext2D, b: Box, px: number): void {
    const L = b.learner;
    ctx.lineWidth = px;
    for (const off of RAY_OFFSETS) {
      const dx = Math.cos(L.heading + off);
      const dy = Math.sin(L.heading + off);
      let best = RAY_LENGTH;
      let color = RAY_NONE;
      const wall = Math.min(dx > 0 ? (b.x0 + BOX_W - L.x) / dx : dx < 0 ? (b.x0 - L.x) / dx : Infinity, dy > 0 ? (b.y0 + BOX_H - L.y) / dy : dy < 0 ? (b.y0 - L.y) / dy : Infinity);
      if (wall < best) { best = wall; color = RAY_WALL; }
      const hitCircle = (cx: number, cy: number, cr: number, c: string): void => {
        const fx = cx - L.x;
        const fy = cy - L.y;
        const t = fx * dx + fy * dy;
        const d2 = fx * fx + fy * fy - t * t;
        if (t < 0 || d2 > cr * cr) return;
        const d = t - Math.sqrt(cr * cr - d2);
        if (d < best) { best = Math.max(0, d); color = c; }
      };
      for (const it of b.food) hitCircle(it.x, it.y, ITEM_R, FOOD);
      for (const it of b.poison) hitCircle(it.x, it.y, ITEM_R, POISON);
      if (b.mode === "duel") hitCircle(b.other.x, b.other.y, R, OTHER);
      else if (b.mode === "chase" && tick >= b.otherAt) hitCircle(b.other.x, b.other.y, PREY_R, OTHER);
      ctx.strokeStyle = color;
      ctx.globalAlpha = color === RAY_NONE ? 0.4 : 0.8;
      ctx.beginPath();
      ctx.moveTo(L.x, L.y);
      ctx.lineTo(L.x + dx * best, L.y + dy * best);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
