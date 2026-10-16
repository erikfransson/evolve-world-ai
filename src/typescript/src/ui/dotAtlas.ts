import { context2d, makeCanvas } from "./canvas.ts";

const ATLAS_PX = 1024; // side of the atlas (4 MB): 4 x 4 dots of each colour, about 1000 colours at DPR 1, 200 at DPR 3 (the rest draw as paths)

type Canvas = OffscreenCanvas | HTMLCanvasElement;
interface Block {
  x: number;
  y: number;
  size: number;
}

// Round dots stamped from bitmaps instead of filled as one path per colour: a path of a thousand circles costs the GPU tens of ms a frame,
// the stamps a few. All dots sit in one atlas, so the GPU draws every stamp from one texture. Each colour and device px radius gets a
// block of 4 x 4 cells, the cell at (fx, fy) holding the dot with its centre fx, fy quarter pixels past the cell's middle: a stamp on whole
// device pixels lands a dot where the path would have, with the same edge.
export class DotAtlas {
  private readonly blocks = new Map<string, Block>();
  private atlas: Canvas | null = null;
  private atlasCtx: CanvasRenderingContext2D | null = null;
  private readonly shelf = { x: 0, y: 0, h: 0 }; // where the next block goes: rows of blocks, left to right
  private sizes = ""; // the radii the atlas holds dots of; another size (a zoom) starts it over
  private lastSizes = ""; // the previous frame's
  private stamps = false; // this frame stamps; while the size changes (a zoom) dots draw as paths, so the atlas is not redrawn every frame
  private layer: Canvas | null = null;
  private layerCtx: CanvasRenderingContext2D | null = null;

  // At the start of a frame, with the dot radii it draws: stamps only once they held for a frame, and starts the atlas over then (never
  // within a frame, so a full atlas cannot be cleared and refilled every frame).
  frame(sizes: string): void {
    this.stamps = sizes === this.lastSizes;
    this.lastSizes = sizes;
    if (!this.stamps || sizes === this.sizes) return;
    this.sizes = sizes;
    this.atlasCtx?.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    this.blocks.clear();
    Object.assign(this.shelf, { x: 0, y: 0, h: 0 });
  }

  // A clear canvas the size of the target, for a pass laid down at partial opacity (stamped opaque here, then laid down once, so
  // overlapping dots do not stack darker). Null where none can be made.
  layerFor(w: number, h: number): CanvasRenderingContext2D | null {
    if (!this.layer || this.layer.width !== w || this.layer.height !== h) {
      this.layer = makeCanvas(w, h);
      this.layerCtx = context2d(this.layer);
    }
    const g = this.layerCtx;
    if (!g) return null;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    return g;
  }

  get stamping(): boolean {
    return this.stamps;
  }

  get layerCanvas(): CanvasImageSource | null {
    return this.layer as CanvasImageSource | null;
  }

  // The block of dots of this colour and device px radius, drawn on first use. Null where no canvas can be made or the atlas is full
  // (many colours on a high-DPR screen: the rest draw as paths until the dot size changes).
  private block(style: string, r: number): Block | null {
    const key = `${r} ${style}`;
    let b = this.blocks.get(key);
    if (b !== undefined) return b;
    const size = 2 * Math.ceil(r + 1);
    const side = 4 * size;
    if (side > ATLAS_PX) return null;
    if (!this.atlas) {
      this.atlas = makeCanvas(ATLAS_PX, ATLAS_PX);
      this.atlasCtx = context2d(this.atlas);
      for (const lost of ["contextlost", "contextrestored"]) this.atlas?.addEventListener(lost, () => (this.sizes = "")); // the pixels are gone: drawn again next frame
    }
    const g = this.atlasCtx;
    if (!g) return null;
    const a = this.shelf;
    if (a.x + side > ATLAS_PX) Object.assign(a, { x: 0, y: a.y + a.h, h: 0 });
    if (a.y + side > ATLAS_PX) return null;
    b = { x: a.x, y: a.y, size };
    a.x += side;
    a.h = Math.max(a.h, side);
    g.fillStyle = style;
    g.beginPath();
    for (let fy = 0; fy < 4; fy++) {
      for (let fx = 0; fx < 4; fx++) {
        const cx = b.x + fx * size + size / 2 + fx / 4;
        const cy = b.y + fy * size + size / 2 + fy / 4;
        g.moveTo(cx + r, cy);
        g.arc(cx, cy, r, 0, Math.PI * 2);
      }
    }
    g.fill();
    this.blocks.set(key, b);
    return b;
  }

  // Stamps the dots at order[from..to) into g, m being the world-to-device transform (g is left in it), r the device px radius; those
  // skip(i) names are left to the caller. False when the caller must draw the whole pass as a path: not stamping this frame, a rotated
  // view, or no block.
  stamp(g: CanvasRenderingContext2D, m: DOMMatrix, xs: Float32Array, ys: Float32Array, order: Int32Array, from: number, to: number, style: string, r: number, skip: (i: number) => boolean): boolean {
    if (!this.stamps || m.b !== 0 || m.c !== 0) return false;
    const b = this.block(style, Math.round(r * 4) / 4);
    if (!b) return false;
    const atlas = this.atlas as CanvasImageSource;
    const { size } = b;
    const half = size / 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (let at = from; at < to; at++) {
      const i = order[at]!;
      if (skip(i)) continue;
      const qx = Math.round((m.a * xs[i]! + m.e) * 4); // the centre in quarter device px
      const qy = Math.round((m.d * ys[i]! + m.f) * 4);
      if (!Number.isFinite(qx) || !Number.isFinite(qy)) continue; // NaN would land at the corner
      g.drawImage(atlas, b.x + (qx & 3) * size, b.y + (qy & 3) * size, size, size, (qx >> 2) - half, (qy >> 2) - half, size, size);
    }
    g.setTransform(m);
    return true;
  }
}
