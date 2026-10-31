import { Camera } from "./camera.ts";
import { FLOOR, WALL } from "./palette.ts";

// A picture of a whole map's ground (floor drifts, wash, mud, firm ground, rock), drawn by the map's own drawing code ahead of time
// (scripts/buildMapImage.ts) and shipped with the page, so the world shows at once: a tiny preview inlined in the page, then a picture
// near the screen's resolution. The renderer draws it in place of the map until the map is built and all its images are made (EcoDrawConfig.backdrop).
// The map is drawn over the floor colour (an opaque picture is a tenth of the bytes of one with the floor see-through); in winter the
// winter mask lays the renderer's winter tint where the floor shows, as the map lets it through, so the swap keeps the colours.

export const BACKDROP_SCALES = [0.025, 0.05] as const; // device px per world unit of the shipped pictures, about a whole-world view at 1x and 2x pixel ratio
export const PREVIEW_WIDTH = 160; // px of the inlined preview
export const WINTER_RGB = [150, 190, 235] as const; // the renderer's winter tint over the floor (ecoScene)

export interface BackdropFiles {
  preview: string; // url (a data url)
  images: Readonly<Record<string, string>>; // url by scale, as String(scale)
  winter: string; // url of the winter mask
}

type Picture = HTMLImageElement | ImageBitmap;

export class GroundBackdrop {
  private image: Picture | null = null;
  private rank = -1; // what the image is: 0 the preview, 1 + i BACKDROP_SCALES[i]
  private winter: Picture | null = null;

  readonly worldW: number;
  readonly worldH: number;
  private readonly files: BackdropFiles;

  constructor(worldW: number, worldH: number, files: BackdropFiles) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.files = files;
  }

  get ready(): boolean {
    return this.image !== null;
  }

  // Loads the preview, and the picture for a view at this zoom (device px per world unit): the smallest scale at least 3/4 of it, else the largest.
  load(zoom: number): void {
    this.fetch(this.files.preview, 0);
    const i = BACKDROP_SCALES.findIndex((s) => s >= 0.75 * zoom);
    const at = i < 0 ? BACKDROP_SCALES.length - 1 : i;
    const url = this.files.images[String(BACKDROP_SCALES[at])];
    if (url) this.fetch(url, 1 + at);
    this.fetch(this.files.winter, -1);
  }

  private fetch(url: string, rank: number): void {
    if (typeof Image === "undefined") return;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    img.decode().then(
      () => {
        if (rank < 0) this.winter = img;
        else if (rank > this.rank) {
          this.image = img;
          this.rank = rank;
        }
      },
      () => undefined, // no picture: the map is drawn when it is built, as before
    );
  }

  // Draws the picture over the world's rectangle under the current transform (world units), with the winter tint at this opacity where the floor shows. False when there is none yet.
  draw(ctx: CanvasRenderingContext2D, winter = 0): boolean {
    if (!this.image) return false;
    const smoothing = ctx.imageSmoothingEnabled;
    const quality = ctx.imageSmoothingQuality;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.image, 0, 0, this.worldW, this.worldH);
    if (winter > 0 && this.winter) {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = winter;
      ctx.drawImage(this.winter, 0, 0, this.worldW, this.worldH);
      ctx.globalAlpha = alpha;
    }
    ctx.imageSmoothingEnabled = smoothing;
    ctx.imageSmoothingQuality = quality;
    return true;
  }

  // The world as the renderer frames it before it knows anything else (whole world in view): floor, picture and wall, on a canvas of w x h device px.
  drawFitted(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number): void {
    const cam = new Camera(this.worldW, this.worldH, w, h);
    cam.apply(ctx);
    ctx.fillStyle = FLOOR;
    ctx.fillRect(0, 0, this.worldW, this.worldH);
    this.draw(ctx);
    ctx.strokeStyle = WALL;
    ctx.lineWidth = Math.max(2, 1.5 * dpr) / cam.zoom;
    ctx.strokeRect(0, 0, this.worldW, this.worldH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
