import { Camera } from "./camera.ts";
import { FLOOR, WALL } from "./palette.ts";

// A picture of a whole map's ground (floor drifts, wash, mud, firm ground, rock), drawn by the map's own drawing code ahead of time
// (scripts/buildMapImage.ts) and shipped with the page, so the world shows at once. The page's CSS shows a tiny inlined preview and the picture
// for the screen's pixel ratio under the canvas from the first paint; this draws that picture on the canvas until the map is drawn with all its images (EcoDrawConfig.backdrop).
// The map is drawn over the floor colour (an opaque picture is a tenth of the bytes of one with the floor see-through); in winter the
// winter mask lays the renderer's winter tint where the floor shows, as the map lets it through, so the swap keeps the colours.

export const BACKDROP_SCALES = [0.025, 0.05] as const; // device px per world unit of the shipped pictures, about a whole-world view at 1x and 2x pixel ratio
export const PREVIEW_WIDTH = 160; // px of the preview the page's CSS inlines
export const WINTER_RGB = [150, 190, 235] as const; // the renderer's winter tint over the floor (ecoScene)
export const WINTER_TINT = 0.16; // its opacity at mid-winter

export interface BackdropFiles {
  images: Readonly<Record<string, string>>; // url by scale, as String(scale)
  winter: string; // url of the winter mask
}

type Picture = HTMLImageElement | ImageBitmap;

export class GroundBackdrop {
  private image: Picture | null = null;
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

  // Loads the picture for this pixel ratio, the one the page's CSS picks (image-set 1x and 2x), so the browser fetches and decodes it once.
  load(dpr: number): void {
    const url = this.files.images[String(dpr > 1 ? BACKDROP_SCALES[1] : BACKDROP_SCALES[0])];
    if (url) this.fetch(url, false);
    this.fetch(this.files.winter, true);
  }

  private fetch(url: string, winter: boolean): void {
    if (typeof Image === "undefined") return;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    img.decode().then(
      () => {
        if (winter) this.winter = img;
        else this.image = img;
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

  // The world as the renderer frames it before it knows anything else (whole world in view): floor, picture (winter tint at this opacity) and wall, on a canvas of w x h device px.
  drawFitted(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, winter = 0): void {
    const cam = new Camera(this.worldW, this.worldH, w, h);
    cam.apply(ctx);
    ctx.fillStyle = FLOOR;
    ctx.fillRect(0, 0, this.worldW, this.worldH);
    this.draw(ctx, winter);
    ctx.strokeStyle = WALL;
    ctx.lineWidth = Math.max(2, 1.5 * dpr) / cam.zoom;
    ctx.strokeRect(0, 0, this.worldW, this.worldH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
