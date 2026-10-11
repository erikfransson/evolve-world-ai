// What a shot module exports: a factory returning frame-by-frame drawing and, optionally, its sound mix.
import type { Ctx, StyleName } from "./critter.ts";

export interface ShotOptions { style: StyleName; W: number; H: number }

export interface Shot {
  duration: number; // seconds
  frame(ctx: Ctx, t: number, dt: number): void; // advance to time t and draw
  mixAudio?(path: string): void; // called after all frames; writes a WAV that gets muxed in
}
