// Tiny synth and mixer: sound effects, creature voices and a marimba bed, written as a 48 kHz stereo WAV.
import { writeFileSync } from "node:fs";
import { rng } from "./ease.ts";

export const SR = 48000;
const TAU = Math.PI * 2;

export type Mono = Float32Array;
export interface Cue { t: number; sound: Mono; gain?: number; pan?: number } // pan -1 left .. 1 right

const len = (s: number): Mono => new Float32Array(Math.max(1, Math.round(s * SR)));
const env = (i: number, n: number, a: number, r: number): number => {
  const t = i / SR, T = n / SR;
  return Math.min(1, t / a) * Math.min(1, Math.max(0, (T - t) / r));
};

// Oscillator with a pitch contour f(u), u in 0..1 over the sound; shape mixes sine and soft square.
function tone(dur: number, f: (u: number) => number, opts: { square?: number; vib?: number; vibHz?: number; a?: number; r?: number; decay?: number; lp?: number } = {}): Mono {
  const o = len(dur), n = o.length;
  let ph = 0, low = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const fr = f(u) * (1 + (opts.vib ?? 0) * Math.sin((TAU * (opts.vibHz ?? 6) * i) / SR));
    ph += (TAU * fr) / SR;
    const sq = opts.square ?? 0;
    const s = Math.sin(ph) * (1 - sq) + sq * Math.tanh(4 * Math.sin(ph)) * 0.7;
    const dec = opts.decay ? Math.exp(-opts.decay * (i / SR)) : 1;
    const v = s * dec * env(i, n, opts.a ?? 0.004, opts.r ?? 0.03);
    low += (opts.lp ?? 1) * (v - low); // optional one-pole low-pass to soften square edges
    o[i] = low;
  }
  return o;
}

function noise(dur: number, seed: number, lp = 1, hp = 0, a = 0.002, r = 0.05, decay = 0): Mono {
  const o = len(dur), n = o.length, rand = rng(seed);
  let l = 0, h = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const x = rand() * 2 - 1;
    l += lp * (x - l); // one-pole low-pass, lp in 0..1
    h = hp ? (1 - hp) * (h + l - prev) : l; // one-pole high-pass
    prev = l;
    o[i] = h * env(i, n, a, r) * (decay ? Math.exp(-decay * (i / SR)) : 1);
  }
  return o;
}

function mix(...parts: [Mono, number, number?][]): Mono {
  const n = Math.max(...parts.map(([p, , off]) => p.length + Math.round((off ?? 0) * SR)));
  const o = new Float32Array(n);
  for (const [p, g, off] of parts) { const k = Math.round((off ?? 0) * SR); for (let i = 0; i < p.length; i++) o[i + k]! += p[i]! * g; }
  return o;
}

// Bell-ish partials with exponential decay.
function bell(freq: number, dur = 0.8, bright = 1): Mono {
  return mix([tone(dur, () => freq, { decay: 5, r: 0.1 }), 0.6], [tone(dur, () => freq * 2.76, { decay: 9, r: 0.1 }), 0.25 * bright], [tone(dur, () => freq * 5.4, { decay: 14, r: 0.1 }), 0.12 * bright]);
}

function marimba(freq: number, dur = 0.5): Mono {
  return mix([tone(dur, () => freq, { decay: 7, a: 0.002, r: 0.05 }), 0.7], [tone(dur, () => freq * 4, { decay: 22, a: 0.001, r: 0.05 }), 0.18], [tone(0.03, () => freq * 10, { decay: 80 }), 0.05]);
}

const note = (semi: number): number => 440 * 2 ** ((semi - 9) / 12); // 0 = C4

// Effects library.
export const SFX = {
  pop: (p = 1): Mono => tone(0.09, (u) => 900 * p * (1 - 0.5 * u), { decay: 25 }),
  boing: (p = 1): Mono => tone(0.22, (u) => 300 * p * (1 + 1.6 * u * u), { square: 0.15, vib: 0.03, vibHz: 18, r: 0.06 }),
  chomp: (seed = 1): Mono => mix([noise(0.07, seed, 0.25, 0, 0.001, 0.04, 30), 0.9], [tone(0.07, (u) => 180 * (1 - 0.4 * u), { decay: 40 }), 0.8]),
  nomnom: (seed = 1): Mono => mix([SFX.chomp(seed), 1, 0], [SFX.chomp(seed + 1), 0.9, 0.13], [SFX.chomp(seed + 2), 0.8, 0.26]),
  sparkle: (seed = 3): Mono => { const r = rng(seed); return mix(...Array.from({ length: 6 }, (_, k): [Mono, number, number] => [bell(note(24 + [0, 4, 7, 12, 16, 19][k]!) * (1 + r() * 0.01), 0.6), 0.18, k * 0.045])); },
  yum: (): Mono => mix([marimba(note(12)), 0.6, 0], [marimba(note(16)), 0.6, 0.08], [marimba(note(19)), 0.6, 0.16], [marimba(note(24)), 0.7, 0.24]),
  uhoh: (): Mono => mix([tone(0.18, () => note(7), { square: 0.3, vib: 0.02, lp: 0.2 }), 0.5, 0], [tone(0.32, (u) => note(2) * (1 - 0.05 * u), { square: 0.3, vib: 0.03, lp: 0.2 }), 0.5, 0.2]),
  bleh: (): Mono => tone(0.6, (u) => 150 * (1 - 0.3 * u), { square: 0.5, vib: 0.08, vibHz: 7, a: 0.03, r: 0.25, lp: 0.08 }),
  bonk: (): Mono => mix([tone(0.25, (u) => 120 * (1 - 0.5 * u), { decay: 14 }), 1], [noise(0.05, 9, 0.6, 0, 0.001, 0.03, 60), 0.5], [tone(0.08, () => 1100, { decay: 50 }), 0.25]),
  grr: (dur = 0.9, seed = 5): Mono => {
    const o = mix([noise(dur, seed, 0.08, 0, 0.05, 0.2), 1.6], [tone(dur, () => 85, { square: 0.8, a: 0.05, r: 0.2 }), 0.35]);
    for (let i = 0; i < o.length; i++) o[i]! *= 0.6 + 0.4 * Math.sin((TAU * 28 * i) / SR);
    return o;
  },
  steam: (dur = 0.8): Mono => noise(dur, 21, 0.9, 0.85, 0.05, 0.3),
  aww: (): Mono => mix([tone(1.2, (u) => note(16) * (1 + 0.03 * u), { vib: 0.012, vibHz: 5, a: 0.15, r: 0.5 }), 0.35], [tone(1.2, () => note(19), { vib: 0.012, vibHz: 5.3, a: 0.2, r: 0.5 }), 0.25], [tone(1.2, () => note(24), { vib: 0.01, vibHz: 4.7, a: 0.3, r: 0.5 }), 0.2]),
  bleeps: (seed = 7): Mono => { const r = rng(seed); return mix(...Array.from({ length: 10 }, (_, k): [Mono, number, number] => [tone(0.06, () => note(24 + Math.floor(r() * 12)), { square: 0.7, r: 0.02 }), 0.12, k * 0.09])); },
  ding: (): Mono => mix([bell(note(28), 1.6), 0.6], [bell(note(35), 1.4, 0.6), 0.3, 0.06]),
  whoosh: (dur = 0.5): Mono => { const o = noise(dur, 31, 0.3, 0.6, dur * 0.6, dur * 0.4); return o; },
  nope: (): Mono => mix([tone(0.1, () => note(19), { square: 0.2 }), 0.4, 0], [tone(0.14, () => note(14), { square: 0.2 }), 0.4, 0.14]),
};

// Creature voice: a short gibberish chirp whose contour follows the emotion; `pitch` sets the voice.
export function voice(kind: "happy" | "sad" | "angry" | "surprised" | "sick" | "love" | "hmm", pitch = 1, seed = 1): Mono {
  const r = rng(seed);
  const syl = (dur: number, f0: number, f1: number, sq = 0.35): Mono => tone(dur, (u) => pitch * (f0 + (f1 - f0) * u), { square: sq, vib: 0.02, vibHz: 9, a: 0.015, r: 0.05, lp: 0.18 });
  switch (kind) {
    case "happy": return mix([syl(0.08, 520, 660), 0.5, 0], [syl(0.1, 600, 900), 0.5, 0.1]);
    case "surprised": return syl(0.16, 400, 950, 0.25);
    case "sad": return mix([syl(0.18, 420, 360, 0.2), 0.5, 0], [syl(0.35, 380, 250, 0.2), 0.5, 0.2]);
    case "angry": return mix(...Array.from({ length: 3 }, (_, k): [Mono, number, number] => [syl(0.09, 230 + r() * 40, 180, 0.8), 0.5, k * 0.11]));
    case "sick": return syl(0.5, 300, 200, 0.5);
    case "love": return mix([syl(0.12, 500, 700, 0.1), 0.45, 0], [syl(0.3, 700, 620, 0.1), 0.45, 0.13]);
    case "hmm": return syl(0.3, 330, 360, 0.2);
  }
}

const HAPPY = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]]; // I-V-vi-IV
export const SNEAKY = [[9, 12, 16], [5, 9, 12], [4, 8, 11], [9, 12, 16]]; // Am-F-E-Am

// Gentle marimba loop over a four-chord progression at `bpm`, for `dur` seconds.
export function musicBed(dur: number, bpm = 100, seed = 2, chords = HAPPY): Mono {
  const out = len(dur), beat = 60 / bpm, r = rng(seed);
  // Soft pad holding each chord for a bar.
  for (let bar = 0; bar * 4 * beat < dur; bar++) {
    const ch = chords[bar % 4]!, k0 = Math.round(bar * 4 * beat * SR);
    for (const [j, semi] of ch.entries()) {
      const p = tone(4 * beat + 0.4, () => note(semi) * (j === 0 ? 0.5 : 1), { vib: 0.004, vibHz: 4 + j * 0.7, a: 0.35, r: 0.5, lp: 0.05 });
      for (let i = 0; i < p.length && k0 + i < out.length; i++) out[k0 + i]! += p[i]! * 0.09;
    }
  }
  for (let b = 0; b * beat < dur; b++) {
    const ch = chords[Math.floor(b / 4) % 4]!;
    const t = b * beat;
    const bass = marimba(note(ch[0]! - 12), 0.9);
    const k0 = Math.round(t * SR);
    if (b % 2 === 0) for (let i = 0; i < bass.length && k0 + i < out.length; i++) out[k0 + i]! += bass[i]! * 0.35;
    for (const half of [0, 0.5]) {
      if (half && r() < 0.4) continue;
      const m = marimba(note(ch[Math.floor(r() * 3)]! + 12), 0.4);
      const k = Math.round((t + half * beat) * SR);
      for (let i = 0; i < m.length && k + i < out.length; i++) out[k + i]! += m[i]! * 0.18;
    }
  }
  return out;
}

// Mixes cues (and an optional music bed) into a stereo WAV with a soft limiter.
export function writeMix(path: string, dur: number, cues: Cue[], music?: { sound: Mono; gain: number; fadeOut?: number }): void {
  const n = Math.round(dur * SR);
  const L = new Float32Array(n), Rr = new Float32Array(n);
  const add = (s: Mono, t: number, g: number, pan: number): void => {
    const k = Math.round(t * SR), gl = g * Math.cos(((pan + 1) * Math.PI) / 4), gr = g * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < s.length && k + i < n; i++) { if (k + i < 0) continue; L[k + i]! += s[i]! * gl; Rr[k + i]! += s[i]! * gr; }
  };
  if (music) {
    const fo = music.fadeOut ?? 1;
    const m = music.sound.map((v, i) => v * Math.min(1, (dur - i / SR) / fo, i / SR / 0.5));
    add(m, 0, music.gain * Math.SQRT2, 0);
  }
  for (const c of cues) add(c.sound, c.t, (c.gain ?? 1) * Math.SQRT2, c.pan ?? 0);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.tanh(L[i]! * 0.9) * 32000), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.tanh(Rr[i]! * 0.9) * 32000), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

// Chase drums: kick on beats, snare on 2 and 4, hats on eighths, between `from` and `to` seconds.
export function drums(dur: number, bpm: number, from: number, to: number): Mono {
  const out = len(dur), beat = 60 / bpm;
  const put = (s: Mono, t: number, g: number): void => { const k = Math.round(t * SR); for (let i = 0; i < s.length && k + i < out.length; i++) out[k + i]! += s[i]! * g; };
  const kick = tone(0.25, (u) => 140 * Math.exp(-u * 4) + 45, { decay: 12, a: 0.001 });
  const snare = mix([noise(0.18, 3, 0.6, 0.3, 0.001, 0.08, 18), 0.8], [tone(0.1, () => 200, { decay: 30 }), 0.4]);
  const hat = noise(0.05, 4, 1, 0.9, 0.001, 0.03, 60);
  for (let b = 0; from + b * beat < to; b++) {
    const t = from + b * beat;
    put(kick, t, 0.8);
    if (b % 2 === 1) put(snare, t, 0.5);
    put(hat, t, 0.18);
    put(hat, t + beat / 2, 0.12);
  }
  return out;
}

// Adds b into a in place (same rate), returning a.
export function layer(a: Mono, b: Mono, g = 1): Mono { for (let i = 0; i < Math.min(a.length, b.length); i++) a[i]! += b[i]! * g; return a; }
