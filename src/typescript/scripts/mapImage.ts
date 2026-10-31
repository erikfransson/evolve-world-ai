// Renders the Live map's ground pictures (src/live/maps/<name>-ground-*) with the page's own drawing code; scripts/buildMapImage.ts opens
// this page in headless Chrome and saves window.__out. The map is drawn over the floor colour; the winter mask (winter colour where the floor shows through,
// clear on mud, firm ground and rock) lets the page lay the winter tint where the map lets it through (GroundBackdrop).
import { mapSpec } from "../src/sim/maps/index.ts";
import { mapTerrain } from "../src/sim/terrain.ts";
import { drawTerrain, prepareTerrain } from "../src/ui/terrainScene.ts";
import { BACKDROP_SCALES, PREVIEW_WIDTH, WINTER_RGB } from "../src/ui/groundBackdrop.ts";
import { FLOOR } from "../src/ui/palette.ts";

const name = new URLSearchParams(location.search).get("map") ?? "inland-sea";
const spec = mapSpec(name)!;
const t = mapTerrain(spec.name, spec.width, spec.height);
const q = Number(new URLSearchParams(location.search).get("q") ?? 0.85);
const view = { x0: 0, x1: spec.width, y0: 0, y1: spec.height };

function render(scale: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(spec.width * scale);
  c.height = Math.round(spec.height * scale);
  const ctx = c.getContext("2d")!;
  const s = c.width / spec.width;
  for (let pass = 0; pass < 1000; pass++) {
    let guard = 0;
    while (!prepareTerrain(t, s, view) && guard++ < 100_000);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (drawTerrain(ctx, t, s, view)) break; // drawn with every image in place, no stand-ins
  }
  return c;
}

// The map over the floor colour, as the page draws it in summer.
function onFloor(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = document.createElement("canvas");
  o.width = c.width;
  o.height = c.height;
  const g = o.getContext("2d")!;
  g.fillStyle = FLOOR;
  g.fillRect(0, 0, o.width, o.height);
  g.drawImage(c, 0, 0);
  return o;
}

const out: Record<string, string> = {};
let low: HTMLCanvasElement | null = null;
for (const scale of BACKDROP_SCALES) {
  const c = render(scale);
  if (!low) {
    low = c;
    const m = document.createElement("canvas");
    m.width = c.width;
    m.height = c.height;
    const src = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const mg = m.getContext("2d")!;
    const img = mg.createImageData(c.width, c.height);
    for (let k = 0; k < src.length; k += 4) {
      img.data[k] = WINTER_RGB[0];
      img.data[k + 1] = WINTER_RGB[1];
      img.data[k + 2] = WINTER_RGB[2];
      img.data[k + 3] = src[k + 3]! < 128 ? 255 : 0;
    }
    mg.putImageData(img, 0, 0);
    out.winter = m.toDataURL("image/png");
  }
  out[String(scale)] = onFloor(c).toDataURL("image/webp", q);
}
const p = document.createElement("canvas");
p.width = PREVIEW_WIDTH;
p.height = Math.round((PREVIEW_WIDTH * spec.height) / spec.width);
const pg = p.getContext("2d")!;
pg.imageSmoothingEnabled = true;
pg.imageSmoothingQuality = "high";
pg.drawImage(onFloor(low!), 0, 0, p.width, p.height);
out.preview = p.toDataURL("image/webp", 0.5);
(window as unknown as { __out: unknown }).__out = out;
