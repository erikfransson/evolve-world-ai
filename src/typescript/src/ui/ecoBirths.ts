import type { SnapshotViews } from "../worker/ecoProtocol.ts";

const MAX_RINGS = 64;
const RING_MS = 800; // real time, so it looks the same at any sim speed
const FADE_IN_PX = 5; // creature radius on screen (CSS px) where the rings start to appear
const FADE_FULL_PX = 9; // and where they are fully visible

interface Ring {
  x: number;
  y: number;
  hue: number;
  at: number; // ms
}

// 0 when creatures are small on screen, 1 when clearly visible.
export const ringVisibility = (radiusCssPx: number): number => Math.min(1, Math.max(0, (radiusCssPx - FADE_IN_PX) / (FADE_FULL_PX - FADE_IN_PX)));

// Brief expanding rings where new creatures appear, found by new (higher) ids in the snapshots, so the worker sends nothing extra.
export class BirthRings {
  private readonly rings: Ring[] = [];
  private maxId = -1;
  private primed = false;

  // Call at the start of a run, so the first snapshot's creatures do not count as births.
  reset(): void {
    this.rings.length = 0;
    this.maxId = -1;
    this.primed = false;
  }

  observe(v: SnapshotViews, now: number): void {
    let top = this.maxId;
    for (let i = 0; i < v.count; i++) {
      const id = v.ids[i]!;
      if (id <= this.maxId) continue;
      if (id > top) top = id;
      if (!this.primed) continue;
      if (this.rings.length >= MAX_RINGS) this.rings.shift();
      this.rings.push({ x: v.x[i]!, y: v.y[i]!, hue: v.hue[i]!, at: now });
    }
    this.maxId = top;
    this.primed = true;
  }

  get size(): number {
    return this.rings.length;
  }

  // Drawn in world coordinates. radius: creature radius in world units, css: one CSS pixel in world units, cssZoom: CSS pixels per world unit.
  draw(ctx: CanvasRenderingContext2D, now: number, radius: number, css: number, cssZoom: number): void {
    while (this.rings.length && now - this.rings[0]!.at >= RING_MS) this.rings.shift();
    const visible = ringVisibility(radius * cssZoom);
    if (visible <= 0) return;
    for (const g of this.rings) {
      const t = (now - g.at) / RING_MS;
      ctx.globalAlpha = 0.95 * (1 - t) * visible;
      ctx.strokeStyle = `hsl(${g.hue}, 90%, 70%)`;
      ctx.lineWidth = (2.4 - 1.2 * t) * css;
      ctx.beginPath();
      ctx.arc(g.x, g.y, radius * (1.2 + 2.2 * (1 - (1 - t) ** 2)), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
