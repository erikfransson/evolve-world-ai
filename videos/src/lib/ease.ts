// Easing, interpolation and small deterministic helpers shared by shots.

export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => clamp((v - a) / (b - a));
export const smooth = (t: number): number => { t = clamp(t); return t * t * (3 - 2 * t); };
export const smoother = (t: number): number => { t = clamp(t); return t * t * t * (t * (6 * t - 15) + 10); };
export const easeOut = (t: number): number => 1 - (1 - clamp(t)) ** 3;
export const easeIn = (t: number): number => clamp(t) ** 3;
export const easeInOut = (t: number): number => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };
export const easeOutBack = (t: number, s = 1.70158): number => { t = clamp(t) - 1; return 1 + (s + 1) * t * t * t + s * t * t; };
export const easeOutElastic = (t: number): number => {
  t = clamp(t);
  if (t === 0 || t === 1) return t;
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
// 0 -> 1 -> 0 over [0, 1] with eased edges of width `edge`.
export const pulse = (t: number, edge = 0.2): number => (t <= 0 || t >= 1 ? 0 : smooth(t / edge) * smooth((1 - t) / edge));
export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

// Mulberry32: small seeded generator so every render is identical.
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth 1D value noise in [-1, 1], cheap and deterministic.
export function noise1(x: number, seed = 0): number {
  const h = (i: number): number => {
    let n = Math.imul(i ^ (seed * 374761393), 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 2147483648 - 1;
  };
  const i = Math.floor(x);
  const f = x - i;
  return lerp(h(i), h(i + 1), smooth(f));
}

// Critically damped spring toward a target, stepped by dt; `k` is the response rate in 1/s.
export function approach(v: number, target: number, k: number, dt: number): number {
  return target + (v - target) * Math.exp(-k * dt);
}

export interface Key { t: number; v: number; ease?: (t: number) => number }

// Piecewise keyframe track, holding the end values outside the keys.
export function track(keys: Key[]): (t: number) => number {
  return (t) => {
    if (t <= keys[0]!.t) return keys[0]!.v;
    for (let i = 1; i < keys.length; i++) {
      const b = keys[i]!;
      if (t <= b.t) {
        const a = keys[i - 1]!;
        return lerp(a.v, b.v, (b.ease ?? smoother)((t - a.t) / (b.t - a.t)));
      }
    }
    return keys[keys.length - 1]!.v;
  };
}

export interface Waypoint { t: number; x: number; y: number }

// Centripetal-ish Catmull-Rom path through timed waypoints; returns position and velocity.
export function path(points: Waypoint[]): (t: number) => { x: number; y: number; vx: number; vy: number } {
  const at = (i: number): Waypoint => points[Math.max(0, Math.min(points.length - 1, i))]!;
  const pos = (t: number): { x: number; y: number } => {
    if (t <= points[0]!.t) return { x: points[0]!.x, y: points[0]!.y };
    const last = points[points.length - 1]!;
    if (t >= last.t) return { x: last.x, y: last.y };
    let i = 0;
    while (points[i + 1]!.t < t) i++;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const u = smooth((t - p1.t) / (p2.t - p1.t)) * 0.35 + ((t - p1.t) / (p2.t - p1.t)) * 0.65;
    const cr = (a: number, b: number, c: number, d: number): number =>
      0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
    return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
  };
  return (t) => {
    const h = 1 / 240;
    const a = pos(t - h), b = pos(t + h), p = pos(t);
    return { x: p.x, y: p.y, vx: (b.x - a.x) / (2 * h), vy: (b.y - a.y) / (2 * h) };
  };
}
