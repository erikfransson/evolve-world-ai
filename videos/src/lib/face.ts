// Face rig: a small set of continuous parameters that every emotion is a blend of.
import { approach } from "./ease.ts";

export interface Expr {
  eyeOpen: number; // 1 open, 0 closed
  happyLids: number; // 0..1, lower lids push up into ^^ arcs
  lidTilt: number; // -1 sad (outer corners droop) .. +1 angry (inner corners down)
  browY: number; // -1 low .. +1 raised
  brow: number; // brow visibility 0..1
  mouthCurve: number; // -1 frown .. +1 smile
  mouthOpen: number; // 0..1
  mouthWide: number; // width multiplier around 1
  wobble: number; // 0..1 wavy queasy mouth
  pupil: number; // pupil size multiplier
  blush: number; // 0..1
  tint: number; // 0..1 sick green
  teeth: number; // 0..1 gritted teeth (angry)
}

export const NEUTRAL: Expr = { eyeOpen: 1, happyLids: 0, lidTilt: 0, browY: 0, brow: 0, mouthCurve: 0.25, mouthOpen: 0, mouthWide: 1, wobble: 0, pupil: 1, blush: 0.25, tint: 0, teeth: 0 };

export type Emotion = "neutral" | "happy" | "joy" | "sad" | "angry" | "surprised" | "sick" | "sleepy" | "focus" | "love" | "scared";

const P = (o: Partial<Expr>): Expr => ({ ...NEUTRAL, ...o });
export const EMOTIONS: Record<Emotion, Expr> = {
  neutral: NEUTRAL,
  happy: P({ happyLids: 0.7, mouthCurve: 1, mouthOpen: 0.25, blush: 0.8, browY: 0.4, brow: 0.0 }),
  joy: P({ happyLids: 1, mouthCurve: 1, mouthOpen: 0.9, mouthWide: 1.25, blush: 1, browY: 0.8, brow: 0.6 }),
  sad: P({ eyeOpen: 0.75, lidTilt: -0.9, browY: 0.2, brow: 1, mouthCurve: -0.9, mouthOpen: 0.05, mouthWide: 0.8, pupil: 1.2, blush: 0.1 }),
  angry: P({ eyeOpen: 0.75, lidTilt: 1, browY: -0.7, brow: 1, mouthCurve: -0.45, mouthOpen: 0.5, mouthWide: 1.35, pupil: 0.8, blush: 0.6, teeth: 1 }),
  surprised: P({ eyeOpen: 1.2, browY: 1, brow: 1, mouthCurve: 0, mouthOpen: 0.8, mouthWide: 0.6, pupil: 0.7, blush: 0.2 }),
  sick: P({ eyeOpen: 0.55, lidTilt: -0.5, brow: 0.8, browY: 0.1, mouthCurve: -0.5, mouthOpen: 0.2, wobble: 1, pupil: 0.8, blush: 0, tint: 1 }),
  sleepy: P({ eyeOpen: 0.15, mouthCurve: 0.1, mouthOpen: 0.1, blush: 0.4 }),
  focus: P({ eyeOpen: 0.85, lidTilt: 0.35, brow: 1, browY: -0.25, mouthCurve: 0, mouthWide: 0.6, pupil: 1.1, blush: 0.2 }),
  love: P({ happyLids: 0.5, mouthCurve: 1, mouthOpen: 0.3, blush: 1.4, browY: 0.5, pupil: 1.5 }),
  scared: P({ eyeOpen: 1.25, lidTilt: -0.6, brow: 1, browY: 0.9, mouthCurve: -0.6, mouthOpen: 0.5, wobble: 0.6, pupil: 0.5, blush: 0 }),
};

const KEYS = Object.keys(NEUTRAL) as (keyof Expr)[];

export function blend(a: Expr, b: Expr, t: number): Expr {
  const o = { ...a };
  for (const k of KEYS) o[k] = a[k] + (b[k] - a[k]) * t;
  return o;
}

// Moves `cur` toward `target` in place with a per-parameter spring.
export function relax(cur: Expr, target: Expr, k: number, dt: number): void {
  for (const key of KEYS) cur[key] = approach(cur[key], target[key], k, dt);
}
