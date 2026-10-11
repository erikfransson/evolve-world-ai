// Still grid of every emotion in every style, for tuning the face rig.
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { Critter } from "../lib/critter.ts";
import type { StyleName } from "../lib/critter.ts";
import { EMOTIONS } from "../lib/face.ts";
import type { Emotion } from "../lib/face.ts";

const styles: StyleName[] = ["classic", "cute", "neon"];
const emos = Object.keys(EMOTIONS) as Emotion[];
const cell = 220, R = 72;
const c = createCanvas(cell * emos.length, cell * styles.length + 30);
const ctx = c.getContext("2d");
ctx.fillStyle = "#10291f";
ctx.fillRect(0, 0, c.width, c.height);
ctx.font = "16px Cantarell";
ctx.fillStyle = "#cfe";
styles.forEach((style, j) => emos.forEach((emo, i) => {
  const k = new Critter(cell * (i + 0.5), 30 + cell * (j + 0.5), R, [200, 20, 280, 50, 340][(i + j) % 5]!, i + 1);
  k.heading = Math.PI / 2 * 0.3; k.base = emo; k.energy = 0.6;
  for (let s = 0; s < 60; s++) k.update(0.1 + s / 60, 1 / 60);
  k.draw(ctx, style);
  if (j === 0) ctx.fillText(emo, cell * i + 10, 20);
}));
writeFileSync("out/faceSheet.png", c.toBuffer("image/png"));
// Second sheet: hunters.
const c2 = createCanvas(cell * emos.length, cell * styles.length + 30);
const x2 = c2.getContext("2d");
x2.fillStyle = "#10291f";
x2.fillRect(0, 0, c2.width, c2.height);
styles.forEach((style, j) => emos.forEach((emo, i) => {
  const k = new Critter(cell * (i + 0.5), 30 + cell * (j + 0.5), R, 0 + (i * 7) % 20, i + 1);
  k.hunter = true; k.heading = 0.3; k.base = emo; k.energy = 0.6;
  for (let s = 0; s < 60; s++) k.update(0.1 + s / 60, 1 / 60);
  k.draw(x2, style);
}));
writeFileSync("out/faceSheetHunter.png", c2.toBuffer("image/png"));
